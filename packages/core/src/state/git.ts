/**
 * Git state reads used by session-start.
 *
 * Every probe has a short timeout and fails to an empty value: a session must
 * still start when git is missing, the directory is not a repository, or the
 * command hangs.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveCommonDir } from "./shared-runtime.js";

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GitExec = (args: readonly string[], cwd: string) => GitResult;

export const GIT_TIMEOUT_MS = 3000;

export const defaultGitExec: GitExec = (args, cwd) => {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export interface GitState {
  branch: string;
  /** null when `git status --porcelain` failed. */
  dirtyPaths: number | null;
  clean: boolean | null;
}

export function readGitState(root: string, exec: GitExec = defaultGitExec): GitState {
  const branch = exec(["branch", "--show-current"], root);
  const status = exec(["status", "--porcelain"], root);
  const dirtyPaths =
    status.status === 0
      ? status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length
      : null;
  return {
    branch: branch.status === 0 ? branch.stdout.trim() : "",
    dirtyPaths,
    clean: dirtyPaths === null ? null : dirtyPaths === 0,
  };
}

const worktreeCache = new Map<string, string | null>();

/**
 * `git rev-parse --git-common-dir` resolved against `root`.
 *
 * The common dir is the same from every worktree of one repository, so it is
 * the root of cross-worktree coordination state. Returns null when git is
 * missing, the directory is not a repository, or the command fails/times out.
 *
 * Deliberately uncached: hooks are one-shot processes, and a stale common dir
 * would point at the wrong repository after a checkout move.
 */
export function gitCommonDir(
  root: string,
  exec: GitExec = defaultGitExec,
): string | null {
  const result = exec(["rev-parse", "--git-common-dir"], root);
  if (result.status !== 0) {
    return null;
  }
  const raw = result.stdout.trim();
  if (raw === "") {
    return null;
  }
  try {
    return resolveCommonDir(raw, path.resolve(root));
  } catch {
    return null;
  }
}

/**
 * Root of the main working tree when `root` is a linked worktree.
 *
 * Git identifies the main tree (first `worktree list --porcelain` record);
 * deriving it from the `.git` layout leaks identity for bare repositories that
 * happen to sit inside an unrelated checkout.
 */
export function mainWorktreeRoot(
  root: string,
  exec: GitExec = defaultGitExec,
): string | null {
  const cacheKey = path.resolve(root);
  if (worktreeCache.has(cacheKey)) {
    return worktreeCache.get(cacheKey) ?? null;
  }
  const result = probeMainWorktreeRoot(cacheKey, exec);
  worktreeCache.set(cacheKey, result);
  return result;
}

export function resetGitCache(): void {
  worktreeCache.clear();
}

function probeMainWorktreeRoot(root: string, exec: GitExec): string | null {
  const listing = exec(["worktree", "list", "--porcelain"], root);
  const toplevel = exec(["rev-parse", "--show-toplevel"], root);
  if (listing.status !== 0 || toplevel.status !== 0) {
    return null;
  }
  const lines = listing.stdout.split(/\r?\n/);
  const first = lines[0] ?? "";
  if (!first.startsWith("worktree ")) {
    return null;
  }
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) {
      break;
    }
    if (line.trim() === "bare") {
      return null;
    }
  }
  try {
    const mainRoot = path.resolve(first.slice("worktree ".length).trim());
    const currentRoot = path.resolve(toplevel.stdout.trim());
    return mainRoot === currentRoot ? null : mainRoot;
  } catch {
    return null;
  }
}
