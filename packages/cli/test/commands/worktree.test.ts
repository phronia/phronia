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
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "init"]);
    const taskDir = path.join(root, ".phronia/tasks/01-01-demo");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ id: "01-01-demo", title: "Demo", status: "in_progress" }),
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

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(root, ".phronia/tasks/01-01-demo/task.json"), "utf8"),
    ) as { worktree_path?: string; branch?: string };
    expect(taskJson.worktree_path).toBe(record.path);
    expect(taskJson.branch).toBe(record.branch);

    expect(listWorktrees({ cwd: root }).map((item) => item.taskRef)).toContain(
      ".phronia/tasks/01-01-demo",
    );

    const removed = removeWorktree("01-01-demo", {
      cwd: root,
      force: true,
    });
    expect(removed.ok, removed.message).toBe(true);
    expect(fs.existsSync(record.path)).toBe(false);
    const after = JSON.parse(
      fs.readFileSync(path.join(root, ".phronia/tasks/01-01-demo/task.json"), "utf8"),
    ) as { worktree_path?: string | null };
    expect(after.worktree_path).toBeNull();
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
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
