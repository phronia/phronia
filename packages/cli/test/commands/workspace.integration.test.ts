import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachWorktree,
  bindWorkspace,
  ensureWorkspace,
  prepareWorkspace,
  reclaimWorkspace,
  releaseWorkspace,
} from "../../src/services/workspace.js";

describe("workspace integration (WS-01..WS-05)", () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });
    fs.writeFileSync(path.join(root, ".phronia/tasks/10-28-alpha/prd.md"), "# Alpha\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan alpha"]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when no session identity exists and creates nothing", () => {
    const prepared = prepareWorkspace({
      cwd: root,
      env: {},
      forNewTask: "Beta feature",
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("WORKSPACE_SESSION_UNKNOWN");
    expect(prepared.next).toContain("--session-key");
    expect(
      fs.existsSync(path.join(root, ".git/phronia/workspace.claim.json")),
    ).toBe(false);
    expect(fs.existsSync(path.join(root, ".phronia/worktrees"))).toBe(false);
  });

  it("uses an explicit --session-key as a stable identity across commands", () => {
    const first = prepareWorkspace({
      cwd: root,
      env: {},
      sessionKey: "stable-session",
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.decision.kind).toBe("reuse-current");

    const second = prepareWorkspace({
      cwd: root,
      env: {},
      sessionKey: "stable-session",
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.decision.kind).toBe("reuse-current");
    expect(second.claim?.sessionKey).toBe("stable-session");
    expect(readClaim(root)?.sessionKey).toBe("stable-session");
  });

  it("WS-01: exactly one session claims main; the other gets a worktree", () => {
    const first = prepareWorkspace({ cwd: root, sessionKey: "session-one" });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.decision.kind).toBe("reuse-current");
    expect(first.claim?.sessionKey).toBe("session-one");

    const second = prepareWorkspace({ cwd: root, sessionKey: "session-two" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("WORKSPACE_CLAIM_BUSY");

    const third = prepareWorkspace({
      cwd: root,
      sessionKey: "session-two",
      forNewTask: "Beta feature",
    });
    expect(third.ok, JSON.stringify(third)).toBe(true);
    if (!third.ok) return;
    expect(third.decision.kind).toBe("create");
    expect(third.provisional?.path).toBeDefined();
    expect(fs.existsSync(third.provisional?.path ?? "")).toBe(true);

    const claim = readClaim(root);
    expect(claim?.sessionKey).toBe("session-one");
  });

  it("WS-02: provisional workspace binds to a task without writing to main", () => {
    prepareWorkspace({ cwd: root, sessionKey: "session-one" });
    const prepared = prepareWorkspace({
      cwd: root,
      sessionKey: "session-two",
      forNewTask: "Beta feature",
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok || prepared.provisional === undefined) return;

    const workspace = prepared.provisional.path;
    const taskDir = path.join(workspace, ".phronia/tasks/10-28-beta");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ id: "10-28-beta", title: "Beta", status: "in_progress" }),
    );
    fs.writeFileSync(path.join(taskDir, "prd.md"), "# Beta\n");

    const bound = bindWorkspace({
      cwd: workspace,
      taskRef: ".phronia/tasks/10-28-beta",
    });
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    if (!bound.ok) return;
    expect(bound.warnings).toEqual([]);

    const registry = readRegistry(root);
    const entry = registry.worktrees.find(
      (item) => item.taskRef === ".phronia/tasks/10-28-beta",
    );
    expect(entry?.provisional).toBe(false);
    expect(entry?.path).toBe(workspace);
    expect(
      fs.existsSync(path.join(root, ".phronia/tasks/10-28-beta")),
    ).toBe(false);
  });

  it("WS-03: two sessions ensure the same task and get the same worktree", () => {
    prepareWorkspace({ cwd: root, sessionKey: "session-one" });

    const created = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-two",
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    expect(created.decision.kind).toBe("create");
    const workspace = created.workspace;
    expect(workspace).not.toBeNull();
    expect(fs.existsSync(workspace ?? "")).toBe(true);

    const attached = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-three",
    });
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    if (!attached.ok) return;
    expect(attached.decision.kind).toBe("attach");
    expect(attached.workspace).toBe(workspace);
    expect(attached.warnings.join(" ")).toContain("share");

    const worktrees = readRegistry(root).worktrees;
    expect(
      worktrees.filter((item) => item.taskRef === ".phronia/tasks/10-28-alpha"),
    ).toHaveLength(1);
  });

  it("WS-04: attaches a platform worktree and refuses a branch mismatch", () => {
    writeTask(root, "10-28-platform", {
      touches: ["src/p/**"],
      branch: "phronia/platform-task",
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan platform task"]);

    const platformPath = path.join(root, ".claude/worktrees/foo");
    git(root, ["worktree", "add", "-b", "phronia/platform-task", platformPath, "main"]);

    const attached = attachWorktree("10-28-platform", {
      cwd: root,
      path: platformPath,
    });
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    const entry = readRegistry(root).worktrees.find(
      (item) => item.taskRef === ".phronia/tasks/10-28-platform",
    );
    expect(entry?.kind).toBe("platform");
    expect(entry?.path).toBe(platformPath);

    const wrongPath = path.join(root, ".claude/worktrees/wrong");
    git(root, ["worktree", "add", "-b", "some/other-branch", wrongPath, "main"]);
    const refused = attachWorktree("10-28-platform", {
      cwd: root,
      path: wrongPath,
    });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("WORKSPACE_ATTACH_INVALID");
  });

  it("WS-05: a stale claim owned by an active task is never reclaimed by prepare", () => {
    writeStaleClaim(root, {
      taskRef: ".phronia/tasks/10-28-alpha",
      sessionKey: "old-session",
    });

    const prepared = prepareWorkspace({ cwd: root, sessionKey: "new-session" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("WORKSPACE_CLAIM_STALE_OWNED");
    expect(readClaim(root)?.sessionKey).toBe("old-session");

    const withWorktree = prepareWorkspace({
      cwd: root,
      sessionKey: "new-session",
      forNewTask: "Gamma",
    });
    expect(withWorktree.ok, JSON.stringify(withWorktree)).toBe(true);
    if (!withWorktree.ok) return;
    expect(withWorktree.decision.kind).toBe("create");
    expect(readClaim(root)?.sessionKey).toBe("old-session");
  });

  it("never reclaims a stale claim when the main checkout is dirty", () => {
    writeStaleClaim(root, { taskRef: null, sessionKey: "old-session" });
    fs.writeFileSync(path.join(root, "dirty.txt"), "x");

    const prepared = prepareWorkspace({ cwd: root, sessionKey: "new-session" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("WORKSPACE_CLAIM_STALE_DIRTY");
  });

  it("creates a worktree when main is dirty and unclaimed unless --reuse-dirty", () => {
    fs.writeFileSync(path.join(root, "dirty.txt"), "x");
    const refused = prepareWorkspace({ cwd: root, sessionKey: "session-one" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("WORKSPACE_DIRTY_UNCLAIMED");

    const reused = prepareWorkspace({
      cwd: root,
      sessionKey: "session-one",
      reuseDirty: true,
    });
    expect(reused.ok, JSON.stringify(reused)).toBe(true);
    if (!reused.ok) return;
    expect(reused.decision.kind).toBe("reuse-current");
  });

  it("refuses to create a worktree before the task artifacts are committed", () => {
    prepareWorkspace({ cwd: root, sessionKey: "session-one" });
    writeTask(root, "10-28-uncommitted", { touches: ["src/u/**"] });

    const refused = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-uncommitted",
      sessionKey: "session-two",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("TASK_ARTIFACTS_UNCOMMITTED");
    expect(refused.next).toContain("--copy-task");

    const copied = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-uncommitted",
      sessionKey: "session-two",
      copyTask: true,
    });
    expect(copied.ok, JSON.stringify(copied)).toBe(true);
    if (!copied.ok) return;
    expect(
      fs.existsSync(
        path.join(copied.workspace ?? "", ".phronia/tasks/10-28-uncommitted/task.json"),
      ),
    ).toBe(true);
  });

  it("releases a claim and only reclaims an explicit stale claim", () => {
    prepareWorkspace({ cwd: root, sessionKey: "session-one" });
    const fresh = reclaimWorkspace({ cwd: root, sessionKey: "session-two" });
    expect(fresh.ok).toBe(false);
    if (fresh.ok) return;
    expect(fresh.code).toBe("WORKSPACE_CLAIM_BUSY");

    const released = releaseWorkspace({ cwd: root, sessionKey: "session-one" });
    expect(released.ok, JSON.stringify(released)).toBe(true);
    expect(readClaim(root)).toBeNull();

    writeStaleClaim(root, { taskRef: null, sessionKey: "old-session" });
    const reclaimed = reclaimWorkspace({ cwd: root, sessionKey: "session-two" });
    expect(reclaimed.ok, JSON.stringify(reclaimed)).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.claim?.sessionKey).toBe("session-two");
  });

  it("does not write task.json worktree fields when creating a worktree", () => {
    prepareWorkspace({ cwd: root, sessionKey: "session-one" });
    const created = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-two",
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(root, ".phronia/tasks/10-28-alpha/task.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(taskJson.worktree_path).toBeUndefined();
    expect(taskJson.branch).toBeUndefined();
  });
});

export function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-workspace-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".phronia/.gitignore"),
    ["worktrees/", ".runtime/"].join("\n"),
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

export function writeTask(
  root: string,
  id: string,
  options: {
    touches?: readonly string[];
    branch?: string;
    meta?: Record<string, unknown>;
  } = {},
): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id,
      title: `Task ${id}`,
      status: "in_progress",
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      meta: {
        parallel: {
          ...(options.touches === undefined ? {} : { touches: options.touches }),
          ...(options.meta ?? {}),
        },
      },
    }),
  );
}

interface ClaimSeed {
  taskRef: string | null;
  sessionKey: string;
}

export function writeStaleClaim(root: string, seed: ClaimSeed): void {
  const shared = path.join(root, ".git/phronia");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(
    path.join(shared, "workspace.claim.json"),
    JSON.stringify({
      schemaVersion: 1,
      ownerType: seed.taskRef === null ? "session" : "task",
      ownerRef: seed.taskRef === null ? `session:${seed.sessionKey}` : `task:${seed.taskRef}`,
      sessionKey: seed.sessionKey,
      taskRef: seed.taskRef,
      workspace: root,
      branch: "main",
      host: "test-host",
      pid: 1,
      state: "in_progress",
      acquiredAt: "2020-01-01T00:00:00.000Z",
      heartbeatAt: "2020-01-01T00:00:00.000Z",
      ttlSeconds: 1,
    }),
  );
}

export function readClaim(
  root: string,
): { sessionKey?: string; taskRef?: string | null } | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, ".git/phronia/workspace.claim.json"), "utf8"),
    ) as { sessionKey?: string; taskRef?: string | null };
  } catch {
    return null;
  }
}

export function readRegistry(root: string): {
  worktrees: {
    taskRef: string;
    path: string;
    branch: string;
    kind?: string;
    provisional?: boolean;
  }[];
} {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".git/phronia/worktrees.json"), "utf8"),
  ) as { worktrees: { taskRef: string; path: string; branch: string }[] };
}

export function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
