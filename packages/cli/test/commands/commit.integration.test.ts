import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitTask } from "../../src/services/integrate.js";

describe("task commit ownership (INT-07)", { timeout: 30_000 }, () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
    writeTask(root, "10-28-alpha");
    commitAll(root, "plan alpha");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("INT-07: refuses in the main checkout and commits in the task worktree", () => {
    const wt = addTaskWorktree(root, "10-28-alpha");
    fs.writeFileSync(path.join(wt, "src-work.txt"), "alpha\n");

    const refused = commitTask("10-28-alpha", { cwd: root });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("COMMIT_WRONG_WORKSPACE");
    expect(refused.next).toContain("phronia task commit");
    expect(gitOut(root, ["status", "--porcelain"])).not.toContain("src-work.txt");

    const committed = commitTask("10-28-alpha", { cwd: wt });
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    if (!committed.ok) return;
    expect(committed.committed).toBe(true);
    expect(committed.commit).toHaveLength(40);
    expect(gitOut(wt, ["status", "--porcelain"])).toBe("");
    expect(gitOut(wt, ["log", "-1", "--format=%s"])).toBe("chore(task): 10-28-alpha");
  });

  it("refuses to commit a worktree task while the main checkout is dirty", () => {
    const wt = addTaskWorktree(root, "10-28-alpha");
    fs.writeFileSync(path.join(wt, "src-work.txt"), "alpha\n");
    fs.writeFileSync(path.join(root, "main-dirty.txt"), "dirty\n");

    const result = commitTask("10-28-alpha", { cwd: wt });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INTEGRATE_DIRTY_CHECKOUT");
    expect(result.next).toContain("main checkout");
  });

  it("reports nothing to commit for an already clean worktree", () => {
    const wt = addTaskWorktree(root, "10-28-alpha");
    const result = commitTask("10-28-alpha", { cwd: wt });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.committed).toBe(false);
    expect(result.commit).toHaveLength(40);
  });

  it("accepts a custom commit message", () => {
    const wt = addTaskWorktree(root, "10-28-alpha");
    fs.writeFileSync(path.join(wt, "src-work.txt"), "alpha\n");

    const result = commitTask("10-28-alpha", {
      cwd: wt,
      message: "feat(alpha): add work",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(gitOut(wt, ["log", "-1", "--format=%s"])).toBe("feat(alpha): add work");
  });

  it("refuses a task with no registered worktree", () => {
    const result = commitTask("10-28-alpha", { cwd: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("COMMIT_WRONG_WORKSPACE");
  });
});

// ---------------------------------------------------------------------------
// Repo helpers
// ---------------------------------------------------------------------------

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-commit-"));
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

function writeTask(root: string, id: string): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    `${JSON.stringify(
      {
        id,
        name: id,
        title: `Task ${id}`,
        description: "",
        status: "in_progress",
        dev_type: null,
        scope: null,
        package: null,
        priority: "P2",
        creator: "test",
        assignee: "test",
        createdAt: "2026-01-01",
        completedAt: null,
        branch: null,
        base_branch: null,
        worktree_path: null,
        commit: null,
        pr_url: null,
        subtasks: [],
        children: [],
        parent: null,
        relatedFiles: [],
        notes: "",
        meta: { parallel: { touches: ["src/**"] } },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(dir, "prd.md"), `# ${id}\n`);
}

function addTaskWorktree(root: string, id: string): string {
  const target = path.join(root, ".phronia/worktrees", id);
  const branch = `phronia/${id}`;
  git(root, ["worktree", "add", "-q", "-b", branch, target, "main"]);
  const runtime = path.join(root, ".git/phronia");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, "worktrees.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        worktrees: [
          {
            taskRef: `.phronia/tasks/${id}`,
            path: target,
            branch,
            kind: "phronia",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    ),
  );
  return target;
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
