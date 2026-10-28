/**
 * `task.py start` parent gate and branch recording.
 *
 * A parent task is a coordination container, not an implementation target.
 * `start <parent>` must refuse by default, list the children with executable
 * `start` commands, and still work with `--coordinator` and an empty
 * implement/check manifest.
 *
 * The other half is R13: `start` must not record the integration/base branch
 * as the task's feature branch. Recording `main` made `workspace ensure`
 * resolve the worktree branch to `main` and fail with `WORKSPACE_TARGET_EXISTS`
 * before it could reuse the main checkout.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/workflow/scripts",
);

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function setupRepo(tmp: string): void {
  fs.mkdirSync(path.join(tmp, ".phronia", "scripts"), { recursive: true });
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".phronia", "scripts"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(tmp, ".phronia", "config.yaml"),
    "session_auto_commit: false\n",
  );
  fs.writeFileSync(path.join(tmp, ".phronia", ".developer"), "name=tester\n");
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initGit(tmp: string): void {
  git(tmp, ["init", "-q", "-b", "main"]);
  git(tmp, ["config", "user.email", "test@example.com"]);
  git(tmp, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  git(tmp, ["add", "-A"]);
  git(tmp, ["commit", "-q", "-m", "init"]);
}

function makeTask(
  repo: string,
  name: string,
  overrides: Record<string, unknown> = {},
): string {
  const dir = path.join(repo, ".phronia", "tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prd.md"), `${name} prd\n`);
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id: name,
      name,
      title: name,
      status: "planning",
      priority: "P2",
      createdAt: "2026-10-28",
      assignee: "tester",
      creator: "tester",
      branch: null,
      base_branch: "main",
      subtasks: [],
      children: [],
      parent: null,
      relatedFiles: [],
      meta: {},
      ...overrides,
    }) + "\n",
  );
  return dir;
}

function runTask(repo: string, ...args: string[]) {
  return spawnSync("python3", [".phronia/scripts/task.py", ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      PHRONIA_DEVELOPER: "tester",
      PHRONIA_CONTEXT_ID: "start-parent-session",
    },
  });
}

function readTask(repo: string, name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.join(repo, ".phronia", "tasks", name, "task.json"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

const PARENT = "10-28-parent";
const CHILD_A = "10-28-child-a";
const CHILD_B = "10-28-child-b";

describe.skipIf(!hasPython())("task.py start parent gate", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-start-parent-"));
    setupRepo(tmp);
    initGit(tmp);
    makeTask(tmp, CHILD_A);
    makeTask(tmp, CHILD_B);
    makeTask(tmp, PARENT, { children: [CHILD_A, CHILD_B] });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a parent by default and prints an executable start command per child", () => {
    const result = runTask(tmp, "start", `.phronia/tasks/${PARENT}`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "parent/coordinator task (2 children)",
    );
    expect(result.stdout).toContain("Children:");
    expect(result.stdout).toContain(`${CHILD_A}  [planning]`);
    expect(result.stdout).toContain(`${CHILD_B}  [planning]`);
    expect(result.stdout).toContain("python3 ./.phronia/scripts/task.py start");
    expect(result.stdout).toContain(`.phronia/tasks/${CHILD_A}`);
    expect(result.stdout).toContain(`.phronia/tasks/${CHILD_B}`);
    expect(result.stdout).toContain("--coordinator");
    expect(readTask(tmp, PARENT).status).toBe("planning");
  });

  it("reports the parent before the context-manifest gate", () => {
    // An empty file has zero curated entries, so the manifest gate would fire
    // if it ran first. The parent message is the useful one.
    fs.writeFileSync(path.join(tmp, ".phronia", "tasks", PARENT, "implement.jsonl"), "");

    const result = runTask(tmp, "start", `.phronia/tasks/${PARENT}`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("parent/coordinator task");
    expect(result.stdout).not.toContain("no curated entries");
  });

  it("starts a parent with --coordinator and skips the manifest gate", () => {
    fs.writeFileSync(path.join(tmp, ".phronia", "tasks", PARENT, "implement.jsonl"), "");
    fs.writeFileSync(path.join(tmp, ".phronia", "tasks", PARENT, "check.jsonl"), "");

    const result = runTask(
      tmp,
      "start",
      `.phronia/tasks/${PARENT}`,
      "--coordinator",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Current task set to: .phronia/tasks/${PARENT}`);
    expect(readTask(tmp, PARENT).status).toBe("in_progress");
    expect(
      fs.existsSync(
        path.join(tmp, ".phronia/.runtime/sessions/start-parent-session.json"),
      ),
    ).toBe(true);
  });

  it("starts a child task normally", () => {
    const result = runTask(tmp, "start", `.phronia/tasks/${CHILD_A}`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("parent/coordinator task");
    expect(readTask(tmp, CHILD_A).status).toBe("in_progress");
  });

  it("does not record the integration branch as the task branch", () => {
    const result = runTask(tmp, "start", `.phronia/tasks/${CHILD_A}`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Branch recorded");
    expect(result.stderr).toContain("integration/base branch");
    expect(readTask(tmp, CHILD_A).branch).toBeNull();
    expect(readTask(tmp, CHILD_A).status).toBe("in_progress");
  });

  it("still records a real feature branch", () => {
    git(tmp, ["checkout", "-q", "-b", "feature/record-me"]);

    const result = runTask(tmp, "start", `.phronia/tasks/${CHILD_A}`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Branch recorded: feature/record-me");
    expect(readTask(tmp, CHILD_A).branch).toBe("feature/record-me");
  });
});
