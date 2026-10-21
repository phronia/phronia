/**
 * Minimal cross-repo task links.
 *
 * Git is the transport: each active repo commits a `task.yaml` on
 * `phronia/<task-id>`, and status reads it back with `git show`. There is no
 * daemon, no automatic init, and no silent guess: a repo that cannot be read
 * is reported as `unresolvable`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openState } from "../state/index.js";

export type CrossRepoState = "active" | "reference" | "external";

export interface CrossRepoTouch {
  repo: string;
  remote?: string;
  localHint?: string;
  state: CrossRepoState;
  status: string;
  prUrl?: string | null;
  mergeSha?: string | null;
}

export interface CrossRepoConsume {
  repo: string;
  path: string;
  ref: string;
}

export interface CrossRepoMeta {
  taskId: string;
  originRepo: { remote?: string; path: string };
  touches: CrossRepoTouch[];
  consumes: CrossRepoConsume[];
}

export interface RepoStatus {
  repo: string;
  state: CrossRepoState | "unresolvable";
  status: string | null;
  progress?: string;
  summary?: string;
  updatedAt?: string;
  reason?: string;
}

export interface CrossRepoStatusReport {
  taskId: string;
  repos: RepoStatus[];
  allMerged: boolean;
  consumes: {
    repo: string;
    path: string;
    ref: string;
    drift: boolean;
    resolved: string | null;
  }[];
}

export function readCrossRepo(root: string, taskRef: string): CrossRepoMeta | null {
  const state = openState({ root });
  const record = state.tasks.read(taskRef);
  if (!record) return null;
  const meta = record.raw.meta;
  if (!meta || typeof meta !== "object") return null;
  const crossRepo = (meta as Record<string, unknown>).crossRepo;
  return isCrossRepo(crossRepo) ? crossRepo : null;
}

export function attachCrossRepo(
  root: string,
  taskRef: string,
  touches: readonly CrossRepoTouch[],
  consumes: readonly CrossRepoConsume[] = [],
): CrossRepoMeta {
  const state = openState({ root });
  const record = state.tasks.read(taskRef);
  if (!record) throw new Error(`task not found: ${taskRef}`);
  const existing = readCrossRepo(root, taskRef);
  const meta: CrossRepoMeta = {
    taskId: existing?.taskId ?? record.id,
    originRepo: existing?.originRepo ?? { path: "." },
    touches: mergeTouches(existing?.touches ?? [], touches),
    consumes: [...(existing?.consumes ?? []), ...consumes],
  };
  const target = path.join(root, canonicalRef(root, record.dir), "task.json");
  const raw = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
  raw.meta = { ...(raw.meta as Record<string, unknown> | undefined), crossRepo: meta };
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return meta;
}

export function crossRepoStatus(root: string, taskRef: string): CrossRepoStatusReport {
  const meta = readCrossRepo(root, taskRef);
  if (!meta) {
    throw new Error(`task has no crossRepo metadata: ${taskRef}`);
  }
  const branch = `phronia/${meta.taskId}`;
  const repos: RepoStatus[] = meta.touches.map((touch) => {
    const result = readRemoteTask(root, touch, branch);
    if (!result) {
      return {
        repo: touch.repo,
        state: "unresolvable",
        status: null,
        reason: `cannot read ${branch}:task.yaml from ${touch.remote ?? touch.localHint ?? "origin"}`,
      };
    }
    return {
      repo: touch.repo,
      state: touch.state,
      status: result.status ?? touch.status,
      progress: result.progress,
      summary: result.summary,
      updatedAt: result.updated_at,
    };
  });
  const active = repos.filter((repo) => repo.state === "active");
  const allMerged =
    active.length > 0 &&
    active.every((repo) => repo.status === "completed" || repo.status === "merged");
  return {
    taskId: meta.taskId,
    repos,
    allMerged,
    consumes: meta.consumes.map((consume) => {
      const resolved = resolveConsume(root, consume);
      return {
        ...consume,
        resolved,
        drift: resolved !== null && !resolved.startsWith(consume.ref),
      };
    }),
  };
}

interface RemoteTaskYaml {
  status?: string;
  progress?: string;
  summary?: string;
  updated_at?: string;
}

function readRemoteTask(
  root: string,
  touch: CrossRepoTouch,
  branch: string,
): RemoteTaskYaml | null {
  const target = touch.localHint
    ? path.resolve(root, touch.localHint)
    : touch.remote
      ? root
      : root;
  try {
    if (touch.remote && !touch.localHint) {
      git(root, ["fetch", touch.remote, branch]);
      const content = git(root, ["show", "FETCH_HEAD:task.yaml"]);
      return parseSimpleYaml(content);
    }
    const content = git(target, ["show", `${branch}:task.yaml`]);
    return parseSimpleYaml(content);
  } catch {
    return null;
  }
}

function resolveConsume(root: string, consume: CrossRepoConsume): string | null {
  try {
    return git(root, ["rev-parse", consume.ref]);
  } catch {
    return null;
  }
}

function parseSimpleYaml(content: string): RemoteTaskYaml {
  const out: RemoteTaskYaml = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
    if (match[1] === "status") out.status = value;
    else if (match[1] === "progress") out.progress = value;
    else if (match[1] === "summary") out.summary = value;
    else if (match[1] === "updated_at") out.updated_at = value;
  }
  return out;
}

function mergeTouches(
  existing: readonly CrossRepoTouch[],
  incoming: readonly CrossRepoTouch[],
): CrossRepoTouch[] {
  const byRepo = new Map(existing.map((touch) => [touch.repo, touch]));
  for (const touch of incoming) byRepo.set(touch.repo, touch);
  return [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

function isCrossRepo(value: unknown): value is CrossRepoMeta {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as CrossRepoMeta).taskId === "string" &&
      Array.isArray((value as CrossRepoMeta).touches) &&
      Array.isArray((value as CrossRepoMeta).consumes),
  );
}

function canonicalRef(root: string, dir: string): string {
  return path.relative(root, dir).split(path.sep).join("/");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
