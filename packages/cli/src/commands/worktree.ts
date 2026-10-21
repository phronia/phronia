/**
 * `phronia task worktree` — one task, one worktree, one serial workflow.
 *
 * The registry is diagnostic state; git itself remains the source of truth
 * for worktree existence. Never create a worktree for a missing task and
 * never remove one with uncommitted changes unless forced.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LAYOUT, openState } from "@phronia/core";

export interface WorktreeRecord {
  taskRef: string;
  taskId: string;
  path: string;
  branch: string;
  createdAt: string;
}

interface WorktreeRegistry {
  schemaVersion: 1;
  worktrees: WorktreeRecord[];
}

export interface WorktreeOptions {
  cwd: string;
  json?: boolean;
  force?: boolean;
  path?: string;
  branch?: string;
  base?: string;
  deleteBranch?: boolean;
}

export interface WorktreeResult {
  ok: boolean;
  message: string;
  record?: WorktreeRecord;
}

export function addWorktree(taskRef: string, options: WorktreeOptions): WorktreeResult {
  const root = path.resolve(options.cwd);
  const state = openState({ root });
  const record = state.tasks.read(taskRef);
  if (!record) {
    return { ok: false, message: `task not found: ${taskRef}` };
  }
  if (record.status === "completed") {
    return { ok: false, message: `task is already completed: ${record.id}` };
  }
  const ref = canonicalRef(root, record.dir);
  const raw = readTaskJson(root, ref);
  const existing = typeof raw?.worktree_path === "string" ? raw.worktree_path : "";
  if (existing && fs.existsSync(existing)) {
    return { ok: false, message: `task already has a worktree at ${existing}` };
  }
  if (!options.force && gitDirty(root)) {
    return {
      ok: false,
      message: "main checkout has uncommitted changes; commit them or pass --force",
    };
  }

  const target = path.resolve(
    options.path ?? path.join(root, LAYOUT.paths.worktrees, record.id),
  );
  if (fs.existsSync(target)) {
    return { ok: false, message: `target path already exists: ${target}` };
  }
  const branch = options.branch ?? record.branch ?? `phronia/${record.id}`;
  const base = options.base ?? record.baseBranch ?? "HEAD";
  try {
    if (branchExists(root, branch)) {
      git(root, ["worktree", "add", target, branch]);
    } else {
      git(root, ["worktree", "add", "-b", branch, target, base]);
    }
  } catch (error) {
    return { ok: false, message: gitMessage(error) };
  }

  fs.mkdirSync(path.join(target, LAYOUT.paths.runtime), { recursive: true });
  writeTaskJson(root, ref, { ...raw, worktree_path: target, branch });

  const entry: WorktreeRecord = {
    taskRef: ref,
    taskId: record.id,
    path: target,
    branch,
    createdAt: new Date().toISOString(),
  };
  const registry = readRegistry(root);
  registry.worktrees = [
    ...registry.worktrees.filter((item) => item.taskRef !== entry.taskRef),
    entry,
  ];
  writeRegistry(root, registry);
  return { ok: true, message: `worktree ready: ${target} (${branch})`, record: entry };
}

export function listWorktrees(options: { cwd: string; json?: boolean }): WorktreeRecord[] {
  const root = path.resolve(options.cwd);
  const registry = readRegistry(root);
  const alive = registry.worktrees.filter((entry) => fs.existsSync(entry.path));
  return alive;
}

export function removeWorktree(taskRef: string, options: WorktreeOptions): WorktreeResult {
  const root = path.resolve(options.cwd);
  const state = openState({ root });
  const record = state.tasks.read(taskRef);
  if (!record) {
    return { ok: false, message: `task not found: ${taskRef}` };
  }
  const ref = canonicalRef(root, record.dir);
  const registry = readRegistry(root);
  const entry = registry.worktrees.find((item) => item.taskRef === ref);
  const raw = readTaskJson(root, ref);
  const target =
    entry?.path && fs.existsSync(entry.path)
      ? entry.path
      : typeof raw?.worktree_path === "string"
        ? raw.worktree_path
        : "";
  if (!target) {
    return { ok: false, message: `task has no worktree: ${record.id}` };
  }
  if (!options.force && fs.existsSync(target) && gitDirty(target)) {
    return {
      ok: false,
      message: "worktree has uncommitted changes; commit them or pass --force",
    };
  }
  try {
    git(root, ["worktree", "remove", ...(options.force ? ["--force"] : []), target]);
  } catch (error) {
    return { ok: false, message: gitMessage(error) };
  }
  if (options.deleteBranch && entry?.branch) {
    try {
      git(root, ["branch", options.force ? "-D" : "-d", entry.branch]);
    } catch (error) {
      return {
        ok: false,
        message: `worktree removed, branch not deleted: ${gitMessage(error)}`,
      };
    }
  }
  writeTaskJson(root, ref, {
    ...raw,
    worktree_path: null,
    branch: options.deleteBranch ? null : (raw?.branch ?? null),
  });
  registry.worktrees = registry.worktrees.filter(
    (item) => item.taskRef !== ref,
  );
  writeRegistry(root, registry);
  return { ok: true, message: `worktree removed: ${target}` };
}

function canonicalRef(root: string, dir: string): string {
  return path.relative(root, dir).split(path.sep).join("/");
}

function readTaskJson(root: string, ref: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, ref, "task.json"), "utf8"),
    ) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeTaskJson(
  root: string,
  ref: string,
  data: Record<string, unknown>,
): void {
  const target = path.join(root, ref, "task.json");
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}

function readRegistry(root: string): WorktreeRegistry {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, LAYOUT.paths.worktreeRegistry), "utf8"),
    ) as WorktreeRegistry;
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.worktrees)) {
      return parsed;
    }
  } catch {
    // missing or corrupt registry: rebuild from task.json below
  }
  const rebuilt: WorktreeRecord[] = [];
  for (const task of openState({ root }).tasks.list({ includeArchived: true })) {
    const raw = readTaskJson(root, task.ref);
    const worktreePath = raw?.worktree_path;
    if (typeof worktreePath === "string" && worktreePath) {
      rebuilt.push({
        taskRef: task.ref,
        taskId: task.id,
        path: worktreePath,
        branch: typeof raw?.branch === "string" ? raw.branch : "",
        createdAt: "",
      });
    }
  }
  return { schemaVersion: 1, worktrees: rebuilt };
}

function writeRegistry(root: string, registry: WorktreeRegistry): void {
  const target = path.join(root, LAYOUT.paths.worktreeRegistry);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitDirty(cwd: string): boolean {
  try {
    return git(cwd, ["status", "--porcelain"]).length > 0;
  } catch {
    return false;
  }
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function gitMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}
