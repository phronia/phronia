/**
 * The default root moved, but existing tasks and existing worktrees must not
 * move with it. These cases are the regression gate for the upgrade promise:
 * before/after behaviour is identical for everything created under the old
 * layout, and the registry rebuild can never rewrite a recorded path.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addWorktree,
  attachWorktree,
  listWorktrees,
  removeWorktree,
} from "../../src/commands/worktree.js";
import { resolveWorktreeRoot } from "@phronia/core/task";

const LEGACY_DIR = ".phronia/worktrees";

describe("worktree legacy compatibility", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-legacy-"));
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
    writeLegacyConfig(root);
    commitAll(root, "init");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps a worktree created under the configured legacy root in place", () => {
    writeTask(root, "10-28-legacy");
    commitAll(root, "plan legacy");

    const added = addWorktree("10-28-legacy", { cwd: root });
    expect(added.ok, added.message).toBe(true);
    if (!added.record) return;

    // The project still configures the old directory, so that is where it goes.
    expect(added.record.path).toContain(LEGACY_DIR);
    expect(fs.existsSync(added.record.path)).toBe(true);

    const listed = listWorktrees({ cwd: root });
    expect(listed.map((entry) => entry.path)).toContain(added.record.path);
  });

  it("reports an attached external worktree without relocating it", () => {
    writeTask(root, "10-28-external");
    commitAll(root, "plan external");

    const elsewhere = path.join(path.dirname(root), `${path.basename(root)}-external`);
    git(root, ["worktree", "add", "-q", elsewhere, "-b", "phronia/10-28-external", "main"]);
    try {
      const attached = attachWorktree("10-28-external", {
        cwd: root,
        path: elsewhere,
      });
      expect(attached.ok, attached.message).toBe(true);

      const listed = listWorktrees({ cwd: root });
      const entry = listed.find(
        (candidate) => candidate.taskRef === ".phronia/tasks/10-28-external",
      );
      // Compared through realpath: macOS reports /private/var while the
      // fixture's own paths keep the /var spelling.
      expect(realpath(entry?.path ?? "")).toBe(realpath(elsewhere));
      // The new default root must be untouched by this task.
      expect(fs.existsSync(path.join(root, ".phronia-workspace"))).toBe(false);
    } finally {
      git(root, ["worktree", "remove", "--force", elsewhere]);
    }
  });

  it("moves new tasks to the new root while old worktrees stay put", () => {
    writeTask(root, "10-28-old");
    commitAll(root, "plan old");
    const legacy = addWorktree("10-28-old", { cwd: root });
    expect(legacy.ok, legacy.message).toBe(true);
    if (!legacy.record) return;

    // A project that drops the legacy override moves future worktrees only.
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      "parallel:\n  worktree_dir: .phronia-workspace\n",
    );
    writeGitignore(root, ".phronia-workspace");
    writeTask(root, "10-28-new");
    commitAll(root, "plan new");

    const modern = addWorktree("10-28-new", { cwd: root });
    expect(modern.ok, modern.message).toBe(true);
    if (!modern.record) return;

    expect(modern.record.path).toContain(".phronia-workspace");
    expect(fs.existsSync(legacy.record.path)).toBe(true);
    expect(fs.existsSync(modern.record.path)).toBe(true);
  });

  it("removes a legacy worktree from its own directory on archive-style cleanup", () => {
    writeTask(root, "10-28-legacy");
    commitAll(root, "plan legacy");
    const added = addWorktree("10-28-legacy", { cwd: root });
    expect(added.ok, added.message).toBe(true);
    if (!added.record) return;

    const removed = removeWorktree("10-28-legacy", { cwd: root, force: true });
    expect(removed.ok, removed.message).toBe(true);
    expect(fs.existsSync(added.record.path)).toBe(false);
  });

  it("rebuilds the registry from git without rewriting recorded paths", () => {
    writeTask(root, "10-28-legacy");
    commitAll(root, "plan legacy");
    const added = addWorktree("10-28-legacy", { cwd: root });
    expect(added.ok, added.message).toBe(true);
    if (!added.record) return;

    // Drop the registry the way a fresh clone or a wiped runtime would.
    const registry = path.join(
      git(root, ["rev-parse", "--git-common-dir"]).trim(),
      "phronia/worktrees.json",
    );
    fs.rmSync(registry, { force: true });

    const listed = listWorktrees({ cwd: root });
    const entry = listed.find(
      (candidate) => candidate.taskRef === ".phronia/tasks/10-28-legacy",
    );
    expect(entry?.path).toBe(realpath(added.record.path));
  });

  it("resolves the new default root without touching configured old projects", () => {
    const configured = resolveWorktreeRoot({
      configuredDir: LEGACY_DIR,
      mainRoot: root,
    });
    expect(configured.absolute).toBe(path.join(root, LEGACY_DIR));
    expect(configured.source).toBe("config");

    const fallback = resolveWorktreeRoot({ mainRoot: root });
    expect(fallback.relativeFromRepo).toBe(".phronia-workspace");
    expect(fallback.source).toBe("default");
  });
});

function writeLegacyConfig(root: string): void {
  fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".phronia/config.yaml"),
    "parallel:\n  worktree_dir: .phronia/worktrees\n",
  );
  fs.writeFileSync(
    path.join(root, ".phronia/.gitignore"),
    ["worktrees/", ".runtime/", ""].join("\n"),
  );
  writeGitignore(root, ".phronia-workspace");
}

function writeGitignore(root: string, relative: string): void {
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ["# PHRONIA:START", `/${relative}/`, "# PHRONIA:END", ""].join("\n"),
  );
}

function writeTask(root: string, id: string): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id,
      name: id,
      title: id,
      description: `task ${id}`,
      status: "in_progress",
      branch: null,
      base_branch: "main",
      worktree_path: null,
      subtasks: [],
      children: [],
      parent: null,
      relatedFiles: [],
      notes: "",
      meta: {},
    }),
  );
  fs.writeFileSync(path.join(dir, "prd.md"), `# ${id}\n`);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
}

function realpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}
