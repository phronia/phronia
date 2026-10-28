import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
} from "../../src/commands/worktree.js";

describe("task worktree lifecycle", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-worktree-"));
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
    const taskDir = path.join(root, ".phronia/tasks/01-01-demo");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({
        id: "01-01-demo",
        title: "Demo",
        status: "in_progress",
        base_branch: "main",
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates, lists, and removes a worktree", () => {
    const added = addWorktree("01-01-demo", { cwd: root, force: true });
    expect(added.ok, added.message).toBe(true);
    const record = added.record;
    expect(record).toBeDefined();
    if (!record) throw new Error("worktree record missing");
    expect(fs.existsSync(record.path)).toBe(true);
    expect(fs.existsSync(path.join(record.path, ".phronia/.runtime"))).toBe(true);
    expect(record.path.endsWith(path.join(".phronia/worktrees/01-01-demo"))).toBe(
      true,
    );

    // The shared registry is the runtime source of truth; task.json is not
    // rewritten (design.md §13).
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(root, ".phronia/tasks/01-01-demo/task.json"), "utf8"),
    ) as { worktree_path?: string; branch?: string };
    expect(taskJson.worktree_path).toBeUndefined();
    expect(taskJson.branch).toBeUndefined();

    const registry = JSON.parse(
      fs.readFileSync(path.join(root, ".git/phronia/worktrees.json"), "utf8"),
    ) as { worktrees: { taskRef: string; path: string }[] };
    expect(registry.worktrees.map((item) => item.taskRef)).toContain(
      ".phronia/tasks/01-01-demo",
    );

    expect(listWorktrees({ cwd: root }).map((item) => item.taskRef)).toContain(
      ".phronia/tasks/01-01-demo",
    );

    const removed = removeWorktree("01-01-demo", {
      cwd: root,
      force: true,
    });
    expect(removed.ok, removed.message).toBe(true);
    expect(fs.existsSync(record.path)).toBe(false);
    expect(listWorktrees({ cwd: root })).toEqual([]);
  });

  it("rejects a missing task", () => {
    expect(addWorktree("no-such-task", { cwd: root, force: true })).toMatchObject({
      ok: false,
    });
  });

  it("refuses to add twice while the worktree exists", () => {
    expect(addWorktree("01-01-demo", { cwd: root, force: true }).ok).toBe(true);
    expect(addWorktree("01-01-demo", { cwd: root, force: true }).ok).toBe(false);
  });

  it("refuses a dirty main checkout unless --force", () => {
    fs.writeFileSync(path.join(root, "dirty.txt"), "x");
    const refused = addWorktree("01-01-demo", { cwd: root });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("WORKSPACE_DIRTY_UNCLAIMED");

    expect(addWorktree("01-01-demo", { cwd: root, force: true }).ok).toBe(true);
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
