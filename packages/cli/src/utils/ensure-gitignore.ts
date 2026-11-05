/**
 * Keep the task-worktree root out of `git status`.
 *
 * Phronia writes entire checkouts into a directory the user never asked for in
 * this exact location, so leaving it untracked makes the very next
 * `workspace ensure` refuse with `WORKSPACE_DIRTY_UNCLAIMED`. Every entry point
 * that materializes a worktree root therefore has to make it ignored first.
 *
 * The rule is written into a Phronia-managed block so a user's own rules and
 * comments survive, and so repeated runs stay byte-identical.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GitPort } from "../adapters/git.js";
import type { WorktreeRoot } from "@phronia/core/task";
import {
  GITIGNORE_BLOCK_END,
  GITIGNORE_BLOCK_START,
} from "./managed-paths.js";

export interface EnsureGitignoreResult {
  /** True when the file content changed on disk. */
  readonly changed: boolean;
  /** Absolute path of the file that was (or would be) written; null when none. */
  readonly path: string | null;
  /** The ignore pattern, e.g. `/.phronia-workspace/`. Null when nothing was written. */
  readonly pattern: string | null;
  /**
   * Why nothing was written: already ignored, root outside the repository, or
   * no usable file. Null when the pattern is in place.
   */
  readonly reason: "already-ignored" | "outside-repo" | "no-usable-gitignore" | null;
  /** True when git actually honours the pattern (verified, not assumed). */
  readonly ignored: boolean;
}

export interface EnsureGitignoreOptions {
  readonly mainRoot: string;
  readonly root: WorktreeRoot;
  /** Needed for the `check-ignore` verification. Omit only in tests. */
  readonly git?: Pick<GitPort, "checkIgnore">;
  readonly dryRun?: boolean;
}

/**
 * Turn a repo-relative directory into an anchored ignore pattern.
 *
 * The leading slash anchors the rule to the repository root, so a nested
 * directory with the same name elsewhere is unaffected.
 */
export function gitignorePatternFor(relative: string): string {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return `/${normalized}/`;
}

export function ensureWorktreeIgnored(
  options: EnsureGitignoreOptions,
): EnsureGitignoreResult {
  const { mainRoot, root } = options;
  const git = options.git;

  // A path outside the working tree cannot be described by an ignore rule.
  if (root.outsideRepo || root.relativeFromRepo === null) {
    return {
      changed: false,
      path: null,
      pattern: null,
      reason: "outside-repo",
      ignored: false,
    };
  }

  const pattern = gitignorePatternFor(root.relativeFromRepo);

  if (isIgnored(git, mainRoot, root.relativeFromRepo, pattern)) {
    return {
      changed: false,
      path: null,
      pattern,
      reason: "already-ignored",
      ignored: true,
    };
  }

  const target = path.join(mainRoot, ".gitignore");
  const existing = fs.existsSync(target)
    ? fs.readFileSync(target, "utf-8")
    : null;
  if (existing === null && !canCreateFile(target)) {
    return {
      changed: false,
      path: null,
      pattern: null,
      reason: "no-usable-gitignore",
      ignored: false,
    };
  }

  const next = upsertManagedGitignoreBlock(existing ?? "", pattern);
  if (existing !== null && next === existing) {
    // The pattern is already listed but git still does not ignore the path —
    // a later negation rule wins. Report rather than silently claim success.
    return {
      changed: false,
      path: target,
      pattern,
      reason: "already-ignored",
      ignored: false,
    };
  }

  if (options.dryRun !== true) {
    fs.writeFileSync(target, next, "utf8");
  }

  const ignored =
    options.dryRun === true
      ? isPatternDeclared(next, pattern)
      : isIgnored(git, mainRoot, root.relativeFromRepo, pattern);

  return {
    changed: true,
    path: target,
    pattern,
    reason: null,
    ignored,
  };
}

/**
 * Whether git currently ignores `relative`.
 *
 * `git check-ignore` only matches paths that exist, so an absent root always
 * reports "not ignored". A trailing probe makes the rule prove itself: git
 * still decides, but on a name that matches the same directory rule. This is
 * what lets `ensure` stay idempotent before the first worktree exists.
 */
function isIgnored(
  git: Pick<GitPort, "checkIgnore"> | undefined,
  mainRoot: string,
  relative: string,
  pattern: string,
): boolean {
  if (git === undefined) return false;
  if (git.checkIgnore(mainRoot, relative)) return true;
  const probe = `${relative.replace(/\/+$/, "")}/.phronia-gitignore-probe`;
  return git.checkIgnore(mainRoot, probe) && pattern !== "";
}

/** Structural fallback used by dry-run, where git cannot observe the write. */
function isPatternDeclared(content: string, pattern: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === pattern);
}

/**
 * Merge `pattern` into the Phronia block of a `.gitignore` payload.
 *
 * Idempotent: an existing block is extended in place (no duplicate lines), a
 * missing block is appended at the end, and surrounding user content is
 * returned untouched.
 */
export function upsertManagedGitignoreBlock(
  content: string,
  pattern: string,
): string {
  const start = content.indexOf(GITIGNORE_BLOCK_START);
  const end =
    start === -1 ? -1 : content.indexOf(GITIGNORE_BLOCK_END, start);

  if (start !== -1 && end !== -1) {
    const block = content.slice(start, end + GITIGNORE_BLOCK_END.length);
    if (block.split(/\r?\n/).some((line) => line.trim() === pattern)) {
      return content;
    }
    const bodyStart = start + GITIGNORE_BLOCK_START.length;
    const body = content.slice(bodyStart, end);
    const separator = body.endsWith("\n") || body === "" ? "" : "\n";
    const updatedBlock =
      content.slice(start, bodyStart) +
      body +
      separator +
      `${pattern}\n` +
      GITIGNORE_BLOCK_END;
    return content.slice(0, start) + updatedBlock + content.slice(end + GITIGNORE_BLOCK_END.length);
  }

  const trimmed = content.replace(/\s+$/, "");
  const prefix = trimmed === "" ? "" : `${trimmed}\n\n`;
  return [
    `${prefix}${GITIGNORE_BLOCK_START}`,
    "# Task worktrees created by `phronia task workspace ensure`",
    pattern,
    GITIGNORE_BLOCK_END,
    "",
  ].join("\n");
}

function canCreateFile(target: string): boolean {
  try {
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Phantom entries for paths that will be under the worktree root but are not
 * ignored yet.
 *
 * `git status` reports an untracked directory as a single entry (`.gitignore`),
 * so writing the ignore rule inside the gate does not close the gate: the gate
 * already read status, and the next `ensure` sees the now-untracked
 * `.gitignore` and refuses with `WORKSPACE_DIRTY_UNCLAIMED`. Folding both names
 * into the dirty set keeps the gate honest without weakening it — the user is
 * still asked to commit, they just get the actionable path.
 */
export function gitignorePendingPaths(options: {
  readonly mainRoot: string;
  readonly root: WorktreeRoot;
  readonly git?: Pick<GitPort, "checkIgnore">;
}): readonly string[] {
  const { root } = options;
  const relative = root.relativeFromRepo;
  if (root.outsideRepo || relative === null) return [];
  if (isIgnored(options.git, options.mainRoot, relative, "")) {
    return [];
  }
  const pending: string[] = [relative];
  const ignoreFile = path.join(options.mainRoot, ".gitignore");
  if (fs.existsSync(ignoreFile) && !isTracked(options.mainRoot, ".gitignore")) {
    pending.push(".gitignore");
  }
  return pending;
}

function isTracked(cwd: string, relative: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
