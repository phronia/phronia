/**
 * Shared-runtime layout for cross-worktree coordination (design.md §1, §3.2,
 * §19).
 *
 * Coordination state belongs to the repository, not to one checkout.
 * `git rev-parse --git-common-dir` resolves to the same directory for the main
 * worktree and every linked worktree, so `<git-common-dir>/phronia/` is where
 * the integration lock, queue, worktree registry, workspace claim, task index,
 * and leases live.
 *
 * This module only computes paths and validates the file envelope. It performs
 * no IO, spawns no processes, and never reads `process.cwd()`; the CLI adapter
 * (`packages/cli/src/adapters/shared-runtime.ts`) owns those concerns.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { LAYOUT } from "../layout/index.js";

/** Directory name under `<git-common-dir>` that holds the shared runtime. */
export const SHARED_RUNTIME_DIR_NAME = "phronia";

/** Current on-disk schema version for every shared-runtime JSON file. */
export const SHARED_RUNTIME_SCHEMA_VERSION = 1 as const;

/** Versions this build can read. Unknown versions must be rejected. */
export const SUPPORTED_RUNTIME_SCHEMA_VERSIONS: readonly number[] =
  Object.freeze([SHARED_RUNTIME_SCHEMA_VERSION]);

export interface SharedRuntimePaths {
  /** `<git-common-dir>/phronia` (or the legacy fallback root). */
  readonly root: string;
  /** `integration.lock` — who is integrating. */
  readonly integrationLock: string;
  /** `integration.json` — waiting queue plus the last result. */
  readonly integration: string;
  /** `worktrees.json` — task ↔ worktree mapping (rebuildable). */
  readonly worktrees: string;
  /** `workspace.claim.json` — who owns the main checkout. */
  readonly workspaceClaim: string;
  /** `tasks.index.json` — cross-session task projection (rebuildable). */
  readonly tasksIndex: string;
  /** `leases/` — per-task leases (`O_EXCL`). */
  readonly leases: string;
  /** `logs/` — optional shared log directory. */
  readonly logs: string;
}

/**
 * Resolve `git rev-parse --git-common-dir` output against the cwd.
 *
 * Git prints a relative path (usually `.git`, but `.git/worktrees/<name>` is
 * not used for `--git-common-dir`) when the repository is discovered from a
 * working directory inside it. Relative output is relative to the process cwd,
 * not to the repository root, so the caller must pass the same cwd it used to
 * run git.
 */
export function resolveCommonDir(raw: string, cwd: string): string {
  const value = raw.trim();
  if (value === "") {
    throw new Error("git-common-dir is empty");
  }
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(cwd, value);
}

/** Paths for the shared runtime rooted at `<commonDir>/phronia`. */
export function sharedRuntimePaths(commonDir: string): SharedRuntimePaths {
  return sharedRuntimePathsFromRoot(
    path.join(path.resolve(commonDir), SHARED_RUNTIME_DIR_NAME),
  );
}

/** Paths for an arbitrary runtime root (used by the fallback location). */
export function sharedRuntimePathsFromRoot(root: string): SharedRuntimePaths {
  const resolved = path.resolve(root);
  return Object.freeze({
    root: resolved,
    integrationLock: path.join(resolved, "integration.lock"),
    integration: path.join(resolved, "integration.json"),
    worktrees: path.join(resolved, "worktrees.json"),
    workspaceClaim: path.join(resolved, "workspace.claim.json"),
    tasksIndex: path.join(resolved, "tasks.index.json"),
    leases: path.join(resolved, "leases"),
    logs: path.join(resolved, "logs"),
  });
}

/** Legacy per-checkout worktree registry (read-only migration source). */
export function legacyWorktreeRegistryPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), LAYOUT.paths.worktreeRegistry);
}

/**
 * Stable, path-safe lease file key for a task ref.
 *
 * Task refs can contain `/`, spaces, and non-ASCII characters, and Windows
 * paths are length-limited. A truncated SHA-256 keeps the filename stable
 * across platforms while remaining collision-resistant in practice.
 */
export function taskLeaseKey(taskRef: string): string {
  return createHash("sha256").update(taskRef, "utf8").digest("hex").slice(0, 16);
}

/** `<runtime>/leases/<hash>.json`. */
export function taskLeasePath(
  paths: SharedRuntimePaths,
  taskRef: string,
): string {
  return path.join(paths.leases, `${taskLeaseKey(taskRef)}.json`);
}

/** `<runtime>/logs/<slug>-<stamp>.log`. */
export function runtimeLogPath(
  paths: SharedRuntimePaths,
  label: string,
  stamp: string,
): string {
  return path.join(paths.logs, `${safeSlug(label)}-${safeSlug(stamp)}.log`);
}

/** Lowercase path-safe slug; empty input becomes `runtime`. */
export function safeSlug(value: string, maxLength = 64): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, maxLength)
    .replace(/^[.-]+|[.-]+$/g, "");
  return slug === "" ? "runtime" : slug;
}

/** True when a value is a schema version this build understands. */
export function isSupportedSchemaVersion(
  value: unknown,
  supported: readonly number[] = SUPPORTED_RUNTIME_SCHEMA_VERSIONS,
): boolean {
  return typeof value === "number" && supported.includes(value);
}

/**
 * Read the numeric schema version from an unknown JSON value.
 *
 * Returns null for missing or non-numeric versions; callers should treat that
 * as an unsupported file rather than guessing.
 */
export function readSchemaVersion(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const version = (value as Record<string, unknown>).schemaVersion;
  return typeof version === "number" && Number.isFinite(version)
    ? version
    : null;
}
