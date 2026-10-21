import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachCrossRepo,
  crossRepoStatus,
  readCrossRepo,
} from "../../src/task/cross-repo.js";

describe("cross-repo links", () => {
  let root: string;
  let sibling: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-cross-root-"));
    sibling = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-cross-gui-"));
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@example.com"]);
    git(root, ["config", "user.name", "T"]);
    fs.mkdirSync(path.join(root, ".phronia/tasks/10-20-cross"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".phronia/tasks/10-20-cross/task.json"),
      JSON.stringify({ id: "10-20-cross", title: "Cross", status: "in_progress" }),
    );

    git(sibling, ["init", "-q"]);
    git(sibling, ["config", "user.email", "t@example.com"]);
    git(sibling, ["config", "user.name", "T"]);
    fs.writeFileSync(path.join(sibling, "README.md"), "gui\n");
    git(sibling, ["add", "."]);
    git(sibling, ["commit", "-q", "-m", "init"]);
    git(sibling, ["checkout", "-q", "-b", "phronia/10-20-cross"]);
    fs.writeFileSync(
      path.join(sibling, "task.yaml"),
      ["task_id: 10-20-cross", "repo: gui", "status: in_progress", "progress: 2/5", 'summary: "half"', "updated_at: 2026-10-21"].join("\n"),
    );
    git(sibling, ["add", "."]);
    git(sibling, ["commit", "-q", "-m", "status"]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  });

  it("attaches siblings inside task.json meta without a top-level field", () => {
    const meta = attachCrossRepo(root, "10-20-cross", [
      {
        repo: "gui",
        localHint: sibling,
        state: "active",
        status: "in_progress",
      },
    ]);
    expect(meta.taskId).toBe("10-20-cross");
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, ".phronia/tasks/10-20-cross/task.json"), "utf8"),
    );
    expect(raw.worktree_path).toBeUndefined();
    expect(raw.meta.crossRepo.touches[0]).toMatchObject({ repo: "gui", state: "active" });
    expect(readCrossRepo(root, "10-20-cross")?.touches).toHaveLength(1);
  });

  it("reads the sibling branch task.yaml and reports progress", () => {
    attachCrossRepo(root, "10-20-cross", [
      { repo: "gui", localHint: sibling, state: "active", status: "in_progress" },
    ]);
    const report = crossRepoStatus(root, "10-20-cross");
    expect(report.repos[0]).toMatchObject({
      repo: "gui",
      state: "active",
      status: "in_progress",
      progress: "2/5",
    });
    expect(report.allMerged).toBe(false);
  });

  it("reports an unreadable repo as unresolvable", () => {
    attachCrossRepo(root, "10-20-cross", [
      { repo: "ghost", localHint: path.join(root, "missing"), state: "active", status: "in_progress" },
    ]);
    expect(crossRepoStatus(root, "10-20-cross").repos[0]?.state).toBe("unresolvable");
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
