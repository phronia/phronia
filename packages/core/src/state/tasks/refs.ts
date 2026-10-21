/**
 * Task reference normalization and containment.
 *
 * Ported from `common/active_task.py` / `common/paths.py`. Two containment
 * bases are required: the repository root and the real path of the workflow
 * directory, because `.phronia` may itself be a symlink into a shared store
 * (#567). A ref that escapes both is refused, never stored.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import { isDirectory, realPath, type FsLike } from "../fs.js";

export interface ResolvedTaskRef {
  /** In-repo POSIX-style reference (what gets stored). */
  lexical: string;
  /** Absolute real path (what gets checked for containment). */
  real: string;
}

export function normalizeTaskRef(taskRef: string): string {
  const trimmed = taskRef.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  let normalized = trimmed.replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("tasks/")) {
    return `${LAYOUT.rootDirName}/${normalized}`;
  }
  return normalized;
}

export function resolveTaskRef(
  taskRef: string,
  root: string,
  io: FsLike,
): ResolvedTaskRef | null {
  const normalized = normalizeTaskRef(taskRef);
  if (!normalized) {
    return null;
  }

  const rootReal = resolveLoose(io, root);
  const workflowReal = resolveLoose(io, path.join(root, LAYOUT.rootDirName));

  let candidate: string;
  if (path.isAbsolute(normalized)) {
    candidate = normalized;
  } else if (normalized.startsWith(`${LAYOUT.rootDirName}/`)) {
    candidate = path.join(root, normalized);
  } else {
    candidate = path.join(root, LAYOUT.rootDirName, "tasks", normalized);
  }

  const resolvedReal = resolveLoose(io, candidate);

  if (isInside(resolvedReal, rootReal)) {
    return {
      lexical: toPosix(path.join(root, path.relative(rootReal, resolvedReal))),
      real: resolvedReal,
    };
  }
  if (isInside(resolvedReal, workflowReal)) {
    return {
      lexical: toPosix(
        path.join(root, LAYOUT.rootDirName, path.relative(workflowReal, resolvedReal)),
      ),
      real: resolvedReal,
    };
  }
  return null;
}

/** Canonical stored ref: requires the directory to exist. */
export function canonicalTaskRef(
  taskRef: string,
  root: string,
  io: FsLike,
): string | null {
  const resolved = resolveTaskRef(taskRef, root, io);
  if (!resolved || !isDirectory(io, resolved.real)) {
    return null;
  }
  const rootReal = resolveLoose(io, root);
  const lexicalAbsolute = path.isAbsolute(resolved.lexical)
    ? resolved.lexical
    : path.join(root, resolved.lexical);
  const relative = path.relative(rootReal, path.resolve(lexicalAbsolute));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return toPosix(path.join(relative));
}

/** Repo-relative ref for a path that need not exist (rename/repoint). */
export function relativeTaskRef(
  taskRef: string,
  root: string,
  io: FsLike,
): string {
  const normalized = normalizeTaskRef(taskRef);
  if (!normalized) {
    return "";
  }
  if (!path.isAbsolute(normalized)) {
    return normalized;
  }
  const rootReal = resolveLoose(io, root);
  const workflowReal = resolveLoose(io, path.join(root, LAYOUT.rootDirName));
  const resolved = resolveLoose(io, normalized);
  if (isInside(resolved, rootReal)) {
    return toPosix(path.relative(rootReal, resolved));
  }
  if (isInside(resolved, workflowReal)) {
    return toPosix(
      path.join(LAYOUT.rootDirName, path.relative(workflowReal, resolved)),
    );
  }
  return "";
}

export function taskRefsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
  root: string,
  io: FsLike,
): boolean {
  if (!left || !right) {
    return false;
  }
  const leftResolved = resolveTaskRef(left, root, io);
  const rightResolved = resolveTaskRef(right, root, io);
  if (leftResolved && rightResolved) {
    return leftResolved.real === rightResolved.real;
  }
  return normalizeTaskRef(left) === normalizeTaskRef(right);
}

function isInside(child: string, base: string): boolean {
  const relative = path.relative(base, child);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

/**
 * Resolve a path that may not exist, following symlinks through the nearest
 * existing ancestor. `fs.realpathSync` throws on missing paths; pathlib's
 * `resolve(strict=False)` does not.
 */
function resolveLoose(io: FsLike, target: string): string {
  const absolute = path.resolve(target);
  if (io.existsSync(absolute)) {
    return realPath(io, absolute) ?? absolute;
  }
  const segments: string[] = [];
  let current = absolute;
  while (!io.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return absolute;
    }
    segments.unshift(path.basename(current));
    current = parent;
  }
  const resolvedParent = realPath(io, current) ?? current;
  return path.join(resolvedParent, ...segments);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
