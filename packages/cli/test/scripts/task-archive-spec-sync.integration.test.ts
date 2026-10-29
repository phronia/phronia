/**
 * Python `task.py archive` spec-sync gate and `task.py spec-delta`.
 *
 * Stamps the shipped workflow scripts into a throwaway git repo, then runs
 * the real Python command.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe.skipIf(!hasPython())("task.py archive spec-sync gate", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-archive-spec-"));
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    fs.mkdirSync(path.join(root, ".phronia/scripts"), { recursive: true });
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(root, ".phronia/scripts"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      "session_auto_commit: true\n",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses to archive a pending spec delta", () => {
    makeTask(root, "10-29-alpha", { delta: true, specSync: null });
    commitAll(root, "task with pending delta");

    const result = archive(root, "10-29-alpha");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SPEC_SYNC_PENDING");
    expect(
      fs.existsSync(path.join(root, ".phronia/tasks/10-29-alpha")),
    ).toBe(true);
    expect(readTask(root, ".phronia/tasks/10-29-alpha").status).toBe(
      "in_progress",
    );
  });

  it("archives a synced spec delta", () => {
    makeTask(root, "10-29-alpha", {
      delta: true,
      specSync: { status: "synced", commit: "abc123" },
    });
    commitAll(root, "synced task");

    const result = archive(root, "10-29-alpha");

    expect(result.status, result.stderr).toBe(0);
    expect(
      fs.existsSync(path.join(root, ".phronia/tasks/10-29-alpha")),
    ).toBe(false);
    const archived = path.join(
      root,
      ".phronia/tasks/archive",
      monthDir(),
      "10-29-alpha",
    );
    expect(fs.existsSync(archived)).toBe(true);
    expect(readTask(root, path.relative(root, archived)).status).toBe(
      "completed",
    );
  });

  it("archives a task without a spec delta", () => {
    makeTask(root, "10-29-alpha", { delta: false, specSync: null });
    commitAll(root, "task without delta");

    const result = archive(root, "10-29-alpha");

    expect(result.status, result.stderr).toBe(0);
  });

  it("--skip-spec-sync archives and records the reason in notes", () => {
    makeTask(root, "10-29-alpha", { delta: true, specSync: { status: "none" } });
    commitAll(root, "pending delta");

    const result = archive(root, "10-29-alpha", ["--skip-spec-sync"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("--skip-spec-sync");
    const archived = path.join(
      root,
      ".phronia/tasks/archive",
      monthDir(),
      "10-29-alpha",
    );
    expect(readTask(root, path.relative(root, archived)).notes).toContain(
      "spec sync skipped at archive",
    );
  });

  it("spec-delta creates a template once and never overwrites it", () => {
    makeTask(root, "10-29-alpha", { delta: false, specSync: null });
    commitAll(root, "task");

    const first = runTask(["spec-delta", ".phronia/tasks/10-29-alpha"], root);
    expect(first.status, first.stderr).toBe(0);
    const deltaPath = path.join(
      root,
      ".phronia/tasks/10-29-alpha/spec-delta.md",
    );
    expect(fs.readFileSync(deltaPath, "utf8")).toContain("## Target files");

    fs.writeFileSync(deltaPath, "# custom\n");
    const second = runTask(["spec-delta", ".phronia/tasks/10-29-alpha"], root);
    expect(second.status, second.stderr).toBe(0);
    expect(fs.readFileSync(deltaPath, "utf8")).toBe("# custom\n");
  });
});

interface TaskOptions {
  readonly delta: boolean;
  readonly specSync: Record<string, unknown> | null;
}

function makeTask(root: string, name: string, options: TaskOptions): void {
  const dir = path.join(root, ".phronia/tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prd.md"), `# ${name}\n`);
  fs.writeFileSync(
    path.join(dir, "task.json"),
    `${JSON.stringify(
      {
        id: name,
        name,
        title: name,
        description: "archive gate fixture",
        status: "in_progress",
        dev_type: null,
        scope: null,
        package: null,
        priority: "P2",
        creator: "test",
        assignee: "test",
        createdAt: "2026-10-29",
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
        meta: options.specSync === null ? {} : { spec_sync: options.specSync },
      },
      null,
      2,
    )}\n`,
  );
  if (options.delta) {
    fs.writeFileSync(
      path.join(dir, "spec-delta.md"),
      "# Spec Delta\n## Target files\n- .phronia/spec/a.md\n",
    );
  }
}

function archive(
  root: string,
  name: string,
  extra: readonly string[] = [],
): { readonly status: number | null; readonly stderr: string } {
  return runTask(["archive", name, ...extra], root);
}

function runTask(
  args: readonly string[],
  cwd: string,
): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync("python3", [".phronia/scripts/task.py", ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

function readTask(root: string, relative: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(root, relative, "task.json"), "utf8"),
  ) as Record<string, unknown>;
}

function monthDir(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
