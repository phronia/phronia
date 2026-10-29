import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PARALLEL_CONFIG } from "@phronia/core/state";
import {
  addWorktree,
  applyWorktreeInputs,
  attachWorktree,
  bindWorkspace,
  detectWorktreeInputs,
  ensureWorkspace,
  prepareWorkspace,
  reclaimWorkspace,
  releaseWorkspace,
  removeWorktree,
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

  it("S3/R7: resolves the session from a pre-shell ticket without --session-key", () => {
    const now = Date.now() / 1000;
    const ticketDir = path.join(root, ".phronia/.runtime/shell-tickets");
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, "ticket.json"),
      JSON.stringify({
        context_key: "ticket-session",
        cwd: fs.realpathSync(root),
        created_at_epoch: now,
        expires_at_epoch: now + 30,
        subcommands: [
          {
            name: "workspace",
            action: "ensure",
            task_ref: ".phronia/tasks/10-28-alpha",
          },
        ],
      }),
    );

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      env: {},
      argv: ["task", "workspace", "ensure", ".phronia/tasks/10-28-alpha"],
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.decision.kind).toBe("reuse-current");
    expect(result.claim?.sessionKey).toBe("ticket-session");
  });

  it("S3/R7: ambiguous session files produce a copy-paste hint, never a guess", () => {
    const sessions = path.join(root, ".phronia/.runtime/sessions");
    fs.mkdirSync(sessions, { recursive: true });
    for (const key of ["claude_a", "claude_b"]) {
      fs.writeFileSync(
        path.join(sessions, `${key}.json`),
        JSON.stringify({ platform: "claude", current_task: null }),
      );
    }

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      env: {},
      argv: ["status"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WORKSPACE_SESSION_UNKNOWN");
    expect(result.message).toContain("2 session files exist");
    expect(result.next).toContain("--session-key");
  });

  it("S3/R7: a unique checkout session is named in the executable next command", () => {
    const sessions = path.join(root, ".phronia/.runtime/sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "claude_abc.json"),
      JSON.stringify({ platform: "claude", current_task: null }),
    );

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      env: {},
      argv: ["status"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WORKSPACE_SESSION_UNKNOWN");
    expect(result.next).toBe(
      "phronia task workspace ensure 10-28-alpha --session-key claude_abc",
    );
    expect(result.details?.hint).toBe(
      "set PHRONIA_CONTEXT_ID=claude_abc for non-hook shells",
    );
  });

  it("S3/R13: branch=main, clean unclaimed main reuses the current checkout", () => {
    writeTask(root, "10-28-main-branch", {
      touches: ["src/m/**"],
      branch: "main",
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan main-branch task"]);

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-main-branch",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.decision.kind).toBe("reuse-current");
    expect(result.workspace).toBe(fs.realpathSync(root));
    expect(result.claim?.taskRef).toBe(".phronia/tasks/10-28-main-branch");
    expect(fs.existsSync(path.join(root, ".phronia/worktrees"))).toBe(false);
  });

  it("S3/R13: branch=main + parallel.worktree=always creates phronia/<slug>", () => {
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      ["parallel:", "  worktree: always"].join("\n"),
    );
    writeTask(root, "10-28-main-branch", {
      touches: ["src/m/**"],
      branch: "main",
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan main-branch task"]);

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-main-branch",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.decision.kind).toBe("create");
    if (result.decision.kind !== "create") return;
    expect(result.decision.branch).toBe("phronia/10-28-main-branch");
    expect(result.decision.base).toBe("main");
    expect(fs.existsSync(result.workspace ?? "")).toBe(true);
  });

  it("S3/R13: a main checkout claimed by another task creates phronia/<slug>", () => {
    writeTask(root, "10-28-main-branch", {
      touches: ["src/m/**"],
      branch: "main",
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan main-branch task"]);
    writeTaskClaim(root, ".phronia/tasks/10-28-other", "other-session");

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-main-branch",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.decision.kind).toBe("create");
    if (result.decision.kind !== "create") return;
    expect(result.decision.branch).toBe("phronia/10-28-main-branch");
    expect(result.decision.code).toBe("WORKSPACE_CLAIM_BUSY");
  });

  it("S3/R13: a registered worktree still attaches", () => {
    writeTask(root, "10-28-main-branch", {
      touches: ["src/m/**"],
      branch: "main",
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan main-branch task"]);

    const worktree = path.join(root, ".phronia/worktrees/10-28-main-branch");
    git(root, ["worktree", "add", "-b", "phronia/10-28-main-branch", worktree, "main"]);
    const shared = path.join(root, ".git/phronia");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(
      path.join(shared, "worktrees.json"),
      JSON.stringify({
        schemaVersion: 1,
        worktrees: [
          {
            taskRef: ".phronia/tasks/10-28-main-branch",
            path: worktree,
            branch: "phronia/10-28-main-branch",
            kind: "phronia",
            createdAt: "2026-10-28T00:00:00Z",
          },
        ],
      }),
    );

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-main-branch",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.decision.kind).toBe("attach");
    expect(result.workspace).toBe(worktree);
  });

  it("S3/R13: branch=main with origin/main integration still reuses main", () => {
    writeTask(root, "10-28-origin-main", {
      touches: ["src/o/**"],
      branch: "main",
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan origin-main task"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-origin-main",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.decision.kind).toBe("reuse-current");
    expect(result.workspace).toBe(fs.realpathSync(root));
  });

  it("S3/R13: branch=main with origin/main integration creates phronia/<slug> when isolated", () => {
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      ["parallel:", "  worktree: always"].join("\n"),
    );
    writeTask(root, "10-28-origin-main", {
      touches: ["src/o/**"],
      branch: "main",
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan origin-main task"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-origin-main",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.decision.kind).toBe("create");
    if (result.decision.kind !== "create") return;
    expect(result.decision.branch).toBe("phronia/10-28-origin-main");
    expect(result.decision.base).toBe("origin/main");
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

describe("worktree inputs, hints, and cleanup (S3/R6-R8)", () => {
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

  it("symlinks parallel.inputs into a created worktree", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "shared-cache/\n");
    fs.mkdirSync(path.join(root, "shared-cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "shared-cache/sdk.txt"), "sdk\n");
    writeConfig(root, [
      "parallel:",
      "  worktree: always",
      "  inputs:",
      "    - path: shared-cache",
      "      mode: symlink",
    ]);
    commitAll(root, "plan alpha + config");

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || result.workspace === null) return;
    const link = path.join(result.workspace, "shared-cache");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(link, "sdk.txt"), "utf8")).toBe("sdk\n");
  });

  it("copies parallel.inputs into a created worktree", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), ".env.local\n");
    fs.writeFileSync(path.join(root, ".env.local"), "SECRET=1\n");
    writeConfig(root, [
      "parallel:",
      "  worktree: always",
      "  inputs:",
      "    - path: .env.local",
      "      mode: copy",
    ]);
    commitAll(root, "plan alpha + config");

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || result.workspace === null) return;
    const copied = path.join(result.workspace, ".env.local");
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(copied, "utf8")).toBe("SECRET=1\n");
  });

  it("warns and continues when an input source is missing", () => {
    writeConfig(root, [
      "parallel:",
      "  worktree: always",
      "  inputs:",
      "    - path: missing-dir",
      "      mode: symlink",
    ]);
    commitAll(root, "plan alpha + config");

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || result.workspace === null) return;
    expect(result.warnings.join(" ")).toContain("source is missing");
    expect(fs.existsSync(path.join(result.workspace, "missing-dir"))).toBe(false);
    expect(result.inputs?.missing).toContain("missing-dir");
  });

  it("skips an input whose destination already exists", () => {
    writeConfig(root, [
      "parallel:",
      "  worktree: always",
      "  inputs:",
      "    - path: README.md",
      "      mode: symlink",
    ]);
    commitAll(root, "plan alpha + config");

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || result.workspace === null) return;
    expect(result.warnings.join(" ")).toContain("already exists");
    expect(fs.readFileSync(path.join(result.workspace, "README.md"), "utf8")).toBe(
      "# repo\n",
    );
  });

  it("rejects an input path that escapes either root", () => {
    const mainRoot = path.join(root, "main-root");
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(mainRoot, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    const escaped = applyWorktreeInputs({
      mainRoot,
      worktree,
      inputs: [{ path: "../escape", mode: "symlink" }],
    });
    expect(escaped.ok).toBe(false);
    if (escaped.ok) return;
    expect(escaped.code).toBe("WORKTREE_INPUT_FAILED");

    const absolute = applyWorktreeInputs({
      mainRoot,
      worktree,
      inputs: [{ path: "/etc/passwd", mode: "copy" }],
    });
    expect(absolute.ok).toBe(false);
  });

  it("falls back to copy when a Windows symlink fails", () => {
    const mainRoot = path.join(root, "main-root");
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(path.join(mainRoot, "dep"), { recursive: true });
    fs.writeFileSync(path.join(mainRoot, "dep", "file.txt"), "dep\n");
    fs.mkdirSync(worktree, { recursive: true });

    const result = applyWorktreeInputs({
      mainRoot,
      worktree,
      inputs: [{ path: "dep", mode: "symlink" }],
      platform: "win32",
      symlink: () => {
        throw new Error("EPERM: operation not permitted");
      },
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toContain("copied instead");
    const copied = path.join(worktree, "dep");
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(copied, "file.txt"), "utf8")).toBe("dep\n");
  });

  it("emits executable hints for conventional missing inputs", () => {
    fs.writeFileSync(
      path.join(root, ".gitignore"),
      ["node_modules/", "rust/target/"].join("\n"),
    );
    fs.mkdirSync(path.join(root, "node_modules/dep"), { recursive: true });
    fs.mkdirSync(path.join(root, "rust/target"), { recursive: true });
    writeConfig(root, ["parallel:", "  worktree: always"]);
    commitAll(root, "plan alpha + config");

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.inputs?.missing).toEqual(
      expect.arrayContaining(["node_modules", "rust/target"]),
    );
    const next = result.inputs?.next.join("\n") ?? "";
    expect(next).toContain("ln -s");
    expect(next).toContain("CARGO_TARGET_DIR");
  });

  it("emits shared-target and sccache hints without setting anything globally", () => {
    writeConfig(root, [
      "parallel:",
      "  worktree: always",
      "  build:",
      "    cargo_target_dir: shared",
      "    sccache: true",
    ]);
    commitAll(root, "plan alpha + config");

    const result = ensureWorkspace({
      cwd: root,
      taskRef: "10-28-alpha",
      sessionKey: "session-one",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const next = result.inputs?.next.join("\n") ?? "";
    expect(next).toContain(".phronia/cache/cargo-target");
    expect(next).toContain("serializes concurrent builds");
    expect(next).toContain("sccache");
  });

  it("rejects a source that resolves outside the repository", () => {
    const mainRoot = path.join(root, "main-root");
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(mainRoot, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-input-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "payload"), "x\n");
      fs.symlinkSync(outside, path.join(mainRoot, "escape"), "dir");

      for (const mode of ["symlink", "copy"] as const) {
        const result = applyWorktreeInputs({
          mainRoot,
          worktree,
          inputs: [{ path: "escape", mode }],
        });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.code).toBe("WORKTREE_INPUT_FAILED");
        expect(result.message).toContain("escape");
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("quotes paths with spaces in the symlink hint", () => {
    const mainRoot = path.join(root, "main dir");
    const worktree = path.join(root, "wt dir");
    fs.mkdirSync(path.join(mainRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    const hints = detectWorktreeInputs({
      mainRoot,
      worktree,
      parallel: DEFAULT_PARALLEL_CONFIG,
    });
    const next = hints.next.join("\n");
    expect(next).toContain("ln -s");
    expect(next).toContain(`'${path.join(mainRoot, "node_modules")}'`);
    expect(next).toContain(`'${path.join(worktree, "node_modules")}'`);
  });

  it("worktree add --force warns when task artifacts may be missing", () => {
    writeTask(root, "10-28-dirty", { touches: ["src/d/**"] });

    const forced = addWorktree("10-28-dirty", { cwd: root, force: true });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(forced.warnings?.join(" ")).toContain(
      "worktree created with --force; task artifacts may be missing",
    );
    expect(forced.warnings?.join(" ")).toContain("--copy-task");
  });

  it("worktree add --force --copy-task does not warn about missing artifacts", () => {
    writeTask(root, "10-28-dirty", { touches: ["src/d/**"] });

    const copied = addWorktree("10-28-dirty", {
      cwd: root,
      force: true,
      copyTask: true,
    });
    expect(copied.ok, JSON.stringify(copied)).toBe(true);
    expect(copied.warnings?.join(" ") ?? "").not.toContain("may be missing");
  });

  it("worktree add: only task-artifact dirt gives scoped commit / --copy-task guidance", () => {
    writeTask(root, "10-28-dirty", { touches: ["src/d/**"] });

    const refused = addWorktree("10-28-dirty", { cwd: root });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("TASK_ARTIFACTS_UNCOMMITTED");
    expect(refused.next).toContain("git add .phronia/tasks/10-28-dirty");
    expect(refused.next).toContain("--copy-task");

    const copied = addWorktree("10-28-dirty", { cwd: root, copyTask: true });
    expect(copied.ok, JSON.stringify(copied)).toBe(true);
    if (!copied.ok || copied.record === undefined) return;
    expect(
      fs.existsSync(
        path.join(copied.record.path, ".phronia/tasks/10-28-dirty/task.json"),
      ),
    ).toBe(true);
  });

  it("worktree add: other dirty paths keep the dirty-checkout refusal", () => {
    writeTask(root, "10-28-dirty", { touches: ["src/d/**"] });
    fs.writeFileSync(path.join(root, "unrelated.txt"), "x\n");

    const refused = addWorktree("10-28-dirty", { cwd: root });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("WORKSPACE_DIRTY_UNCLAIMED");
  });

  it("reports the bytes freed by worktree removal", () => {
    const added = addWorktree("10-28-alpha", { cwd: root });
    expect(added.ok, JSON.stringify(added)).toBe(true);
    if (!added.ok || added.record === undefined) return;
    fs.writeFileSync(
      path.join(added.record.path, "large.bin"),
      Buffer.alloc(8192, 1),
    );

    const removed = removeWorktree("10-28-alpha", { cwd: root, force: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.freedBytes).toBeGreaterThanOrEqual(8192);
    expect(removed.message).toContain("freed ~");
  });
});

function writeConfig(root: string, lines: readonly string[]): void {
  fs.writeFileSync(
    path.join(root, ".phronia/config.yaml"),
    `${lines.join("\n")}\n`,
  );
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

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
  writeClaimRecord(root, seed, {
    acquiredAt: "2020-01-01T00:00:00.000Z",
    heartbeatAt: "2020-01-01T00:00:00.000Z",
    ttlSeconds: 1,
  });
}

/** A fresh claim owned by another task/session. */
export function writeTaskClaim(
  root: string,
  taskRef: string,
  sessionKey: string,
): void {
  writeClaimRecord(
    root,
    { taskRef, sessionKey },
    { acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), ttlSeconds: 7200 },
  );
}

function writeClaimRecord(
  root: string,
  seed: ClaimSeed,
  lease: { acquiredAt: string; heartbeatAt: string; ttlSeconds: number },
): void {
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
      ...lease,
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
