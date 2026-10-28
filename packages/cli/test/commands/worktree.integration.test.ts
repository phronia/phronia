import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  attachWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from "../../src/commands/worktree.js";

describe("worktree base resolution, attach, and prune", () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("defaults the base to task.base_branch", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main" });
    commitAll(root, "plan alpha");
    const main = revParse(root, "main");

    const added = addWorktree("10-28-alpha", { cwd: root });
    expect(added.ok, added.message).toBe(true);
    if (!added.record) return;
    expect(revParse(root, added.record.branch)).toBe(main);
  });

  it("defaults the base to the integration branch when task.base_branch is absent", () => {
    writeTask(root, "10-28-alpha", {});
    commitAll(root, "plan alpha");
    const main = revParse(root, "main");

    const added = addWorktree("10-28-alpha", { cwd: root });
    expect(added.ok, added.message).toBe(true);
    if (!added.record) return;
    expect(revParse(root, added.record.branch)).toBe(main);
  });

  it("honours --base and preserves the legacy --base HEAD behaviour", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main" });
    commitAll(root, "plan alpha");
    const first = revParse(root, "main");
    fs.writeFileSync(path.join(root, "second.txt"), "second\n");
    commitAll(root, "second");
    const head = revParse(root, "HEAD");

    const explicit = addWorktree("10-28-alpha", { cwd: root, base: first });
    expect(explicit.ok, explicit.message).toBe(true);
    if (!explicit.record) return;
    expect(revParse(root, explicit.record.branch)).toBe(first);

    removeWorktree("10-28-alpha", { cwd: root, force: true, deleteBranch: true });

    const legacyHead = addWorktree("10-28-alpha", { cwd: root, base: "HEAD" });
    expect(legacyHead.ok, legacyHead.message).toBe(true);
    if (!legacyHead.record) return;
    expect(revParse(root, legacyHead.record.branch)).toBe(head);
  });

  it("refuses an existing target path and a branch checked out elsewhere", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main" });
    commitAll(root, "plan alpha");

    const taken = path.join(root, "taken");
    fs.mkdirSync(taken);
    const exists = addWorktree("10-28-alpha", { cwd: root, path: taken });
    expect(exists.ok).toBe(false);
    expect(exists.code).toBe("WORKSPACE_TARGET_EXISTS");

    const elsewhere = path.join(root, ".phronia/worktrees/elsewhere");
    git(root, ["worktree", "add", "-b", "phronia/10-28-alpha", elsewhere, "main"]);
    const checkedOut = addWorktree("10-28-alpha", { cwd: root });
    expect(checkedOut.ok).toBe(false);
    expect(checkedOut.code).toBe("WORKSPACE_TARGET_EXISTS");
  });

  it("attach registers a platform worktree without creating another one", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main", branch: "phronia/alpha" });
    commitAll(root, "plan alpha");

    const platform = path.join(root, ".claude/worktrees/alpha");
    git(root, ["worktree", "add", "-b", "phronia/alpha", platform, "main"]);

    const attached = attachWorktree("10-28-alpha", { cwd: root, path: platform });
    expect(attached.ok, attached.message).toBe(true);
    expect(attached.record?.kind).toBe("platform");
    expect(listWorktrees({ cwd: root })).toHaveLength(1);
  });

  it("attach refuses a normal directory and the main worktree", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main", branch: "phronia/alpha" });
    commitAll(root, "plan alpha");

    const normal = path.join(root, "normal");
    fs.mkdirSync(normal);
    const notWorktree = attachWorktree("10-28-alpha", { cwd: root, path: normal });
    expect(notWorktree.ok).toBe(false);
    expect(notWorktree.code).toBe("WORKSPACE_ATTACH_INVALID");

    const main = attachWorktree("10-28-alpha", { cwd: root, path: root });
    expect(main.ok).toBe(false);
    expect(main.code).toBe("WORKSPACE_ATTACH_INVALID");
  });

  it("remove can delete the branch explicitly", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main" });
    commitAll(root, "plan alpha");
    const added = addWorktree("10-28-alpha", { cwd: root });
    expect(added.ok).toBe(true);
    if (!added.record) return;

    const removed = removeWorktree("10-28-alpha", {
      cwd: root,
      force: true,
      deleteBranch: true,
    });
    expect(removed.ok, removed.message).toBe(true);
    expect(refExists(root, added.record.branch)).toBe(false);
    expect(listWorktrees({ cwd: root })).toEqual([]);
  });

  it("prune removes only archived/landed clean worktrees and keeps branches", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main" });
    writeTask(root, "10-28-beta", { baseBranch: "main" });
    writeTask(root, "10-28-dirty", { baseBranch: "main" });
    commitAll(root, "plan tasks");

    const landed = addWorktree("10-28-alpha", { cwd: root });
    const running = addWorktree("10-28-beta", { cwd: root });
    const dirty = addWorktree("10-28-dirty", { cwd: root });
    expect(landed.ok && running.ok && dirty.ok).toBe(true);
    if (!landed.record || !running.record || !dirty.record) return;

    writeOutcome(root, "10-28-alpha", "landed");
    fs.writeFileSync(path.join(dirty.record.path, "dirty.txt"), "x");

    const dry = pruneWorktrees({ cwd: root, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.removed.map((item) => item.taskRef)).toContain(
      ".phronia/tasks/10-28-alpha",
    );
    expect(fs.existsSync(landed.record.path)).toBe(true);

    const pruned = pruneWorktrees({ cwd: root });
    expect(pruned.ok, pruned.message).toBe(true);
    expect(fs.existsSync(landed.record.path)).toBe(false);
    expect(fs.existsSync(running.record.path)).toBe(true);
    expect(fs.existsSync(dirty.record.path)).toBe(true);
    expect(pruned.kept.some((item) => item.reason === "not archived or landed")).toBe(
      true,
    );
    expect(pruned.kept.some((item) => item.reason === "dirty")).toBe(true);
    expect(refExists(root, landed.record.branch)).toBe(true);
  });

  it("prune never removes an unmerged worktree", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main" });
    commitAll(root, "plan alpha");
    const added = addWorktree("10-28-alpha", { cwd: root });
    expect(added.ok).toBe(true);
    if (!added.record) return;

    fs.writeFileSync(path.join(added.record.path, "change.txt"), "change\n");
    git(added.record.path, ["add", "-A"]);
    git(added.record.path, ["commit", "-q", "-m", "work"]);
    writeOutcome(root, "10-28-alpha", "landed");

    const pruned = pruneWorktrees({ cwd: root });
    expect(pruned.ok).toBe(true);
    expect(fs.existsSync(added.record.path)).toBe(true);
    expect(pruned.kept.some((item) => item.reason === "unmerged")).toBe(true);
  });

  it("supports copy and reports a post-create failure without deleting the worktree", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main" });
    commitAll(root, "plan alpha");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");

    const added = addWorktree("10-28-alpha", {
      cwd: root,
      force: true,
      copy: [".env", "missing.txt"],
      postCreate: ['node -e "process.exit(1)"'],
    });
    expect(added.ok).toBe(false);
    expect(added.code).toBe("WORKTREE_POST_CREATE_FAILED");
    const record = added.record;
    expect(record).toBeDefined();
    if (!record) return;
    expect(fs.existsSync(record.path)).toBe(true);
    expect(fs.existsSync(path.join(record.path, ".env"))).toBe(true);
  });

  it("keeps worktrees younger than --older-than", () => {
    writeTask(root, "10-28-alpha", { baseBranch: "main" });
    commitAll(root, "plan alpha");
    const added = addWorktree("10-28-alpha", { cwd: root });
    expect(added.ok).toBe(true);

    const pruned = pruneWorktrees({ cwd: root, olderThan: "7d" });
    expect(pruned.ok).toBe(true);
    expect(pruned.kept.some((item) => item.reason === "younger than --older-than")).toBe(
      true,
    );
  });
});

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-worktree-int-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".phronia/.gitignore"),
    ["worktrees/", ".runtime/"].join("\n"),
  );
  commitAll(root, "init");
  return root;
}

function writeTask(
  root: string,
  id: string,
  options: { baseBranch?: string; branch?: string },
): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id,
      title: `Task ${id}`,
      status: "in_progress",
      ...(options.baseBranch === undefined ? {} : { base_branch: options.baseBranch }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
    }),
  );
}

function writeOutcome(root: string, id: string, outcome: string): void {
  const file = path.join(root, ".phronia/tasks", id, "task.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  record.meta = { ...(record.meta as Record<string, unknown>), integration: { outcome } };
  fs.writeFileSync(file, JSON.stringify(record));
  commitAll(root, `record ${outcome} for ${id}`);
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function revParse(cwd: string, ref: string): string {
  return execFileSync("git", ["rev-parse", ref], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function refExists(cwd: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
