/**
 * The failure this guards against is real and self-inflicted: an untracked
 * worktree root makes the main checkout dirty, and the next `workspace ensure`
 * refuses with `WORKSPACE_DIRTY_UNCLAIMED`. These cases pin both the pattern
 * shape and the "never rewrite the user's file" behaviour.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitPort } from "../../src/adapters/git.js";
import {
  ensureWorktreeIgnored,
  gitignorePatternFor,
  upsertManagedGitignoreBlock,
} from "../../src/utils/ensure-gitignore.js";
import {
  GITIGNORE_BLOCK_END,
  GITIGNORE_BLOCK_START,
} from "../../src/utils/managed-paths.js";
import { resolveWorktreeRoot } from "@phronia/core/task";

describe("gitignorePatternFor", () => {
  it("anchors the pattern to the repository root", () => {
    expect(gitignorePatternFor(".phronia-workspace")).toBe("/.phronia-workspace/");
  });

  it("strips leading and trailing separators plus Windows backslashes", () => {
    expect(gitignorePatternFor("/.custom/wt/")).toBe("/.custom/wt/");
    expect(gitignorePatternFor(".custom\\wt")).toBe("/.custom/wt/");
  });
});

describe("upsertManagedGitignoreBlock", () => {
  it("appends a managed block to an empty payload", () => {
    const result = upsertManagedGitignoreBlock("", "/.phronia-workspace/");
    expect(result).toContain(GITIGNORE_BLOCK_START);
    expect(result).toContain(GITIGNORE_BLOCK_END);
    expect(result).toContain("/.phronia-workspace/");
  });

  it("keeps user content and gains one block", () => {
    const before = "node_modules\n*.log\n";
    const result = upsertManagedGitignoreBlock(before, "/.phronia-workspace/");
    expect(result.startsWith("node_modules\n*.log")).toBe(true);
    expect(result).toContain("/.phronia-workspace/");
  });

  it("is idempotent for the same pattern", () => {
    const once = upsertManagedGitignoreBlock("node_modules\n", "/.phronia-workspace/");
    const twice = upsertManagedGitignoreBlock(once, "/.phronia-workspace/");
    expect(twice).toBe(once);
  });

  it("adds a second pattern inside the existing block", () => {
    const once = upsertManagedGitignoreBlock("node_modules\n", "/.a/");
    const twice = upsertManagedGitignoreBlock(once, "/.b/");
    expect(twice).toContain("/.a/");
    expect(twice).toContain("/.b/");
    expect(twice.match(/PHRONIA:START/g)).toHaveLength(1);
  });
});

describe("ensureWorktreeIgnored", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-gitignore-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const git = createGitPort();

  it("creates a .gitignore and makes git ignore the root", () => {
    const worktreeRoot = resolveWorktreeRoot({ mainRoot: root });
    const result = ensureWorktreeIgnored({ mainRoot: root, root: worktreeRoot, git });

    expect(result.changed).toBe(true);
    expect(result.pattern).toBe("/.phronia-workspace/");
    expect(result.ignored).toBe(true);
    // `git check-ignore` only matches existing paths, so prove the rule with a
    // path that would live inside the root.
    expect(git.checkIgnore(root, ".phronia-workspace/some-task")).toBe(true);
  });

  it("preserves existing user rules", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n*.log\n");
    const worktreeRoot = resolveWorktreeRoot({ mainRoot: root });
    ensureWorktreeIgnored({ mainRoot: root, root: worktreeRoot, git });

    const content = fs.readFileSync(path.join(root, ".gitignore"), "utf-8");
    expect(content.startsWith("node_modules\n*.log")).toBe(true);
    expect(content).toContain("/.phronia-workspace/");
  });

  it("reports already-ignored without touching the file", () => {
    const gitignorePath = path.join(root, ".gitignore");
    fs.writeFileSync(gitignorePath, "/.phronia-workspace/\n");
    const before = fs.statSync(gitignorePath).mtimeMs;

    const worktreeRoot = resolveWorktreeRoot({ mainRoot: root });
    const result = ensureWorktreeIgnored({ mainRoot: root, root: worktreeRoot, git });

    expect(result.reason).toBe("already-ignored");
    expect(result.changed).toBe(false);
    expect(fs.readFileSync(gitignorePath, "utf-8")).toBe("/.phronia-workspace/\n");
    expect(fs.statSync(gitignorePath).mtimeMs).toBe(before);
  });

  it("honours a custom configured directory", () => {
    const worktreeRoot = resolveWorktreeRoot({
      configuredDir: ".custom-wt",
      mainRoot: root,
    });
    const result = ensureWorktreeIgnored({ mainRoot: root, root: worktreeRoot, git });

    expect(result.pattern).toBe("/.custom-wt/");
    expect(git.checkIgnore(root, ".custom-wt/some-task")).toBe(true);
  });

  it("refuses to describe a root outside the repository", () => {
    const worktreeRoot = resolveWorktreeRoot({
      configuredDir: "/elsewhere/worktrees",
      mainRoot: root,
    });
    const result = ensureWorktreeIgnored({ mainRoot: root, root: worktreeRoot, git });

    expect(result.reason).toBe("outside-repo");
    expect(result.changed).toBe(false);
    expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  it("does not write on dry-run", () => {
    const worktreeRoot = resolveWorktreeRoot({ mainRoot: root });
    const result = ensureWorktreeIgnored({
      mainRoot: root,
      root: worktreeRoot,
      git,
      dryRun: true,
    });

    expect(result.changed).toBe(true);
    expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  it("stays idempotent across repeated runs", () => {
    const worktreeRoot = resolveWorktreeRoot({ mainRoot: root });
    ensureWorktreeIgnored({ mainRoot: root, root: worktreeRoot, git });
    const afterFirst = fs.readFileSync(path.join(root, ".gitignore"), "utf-8");
    const second = ensureWorktreeIgnored({ mainRoot: root, root: worktreeRoot, git });

    expect(second.changed).toBe(false);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe(afterFirst);
  });
});
