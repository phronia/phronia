import fs from "node:fs";
import path from "node:path";

/**
 * Retire legacy `trellis-*` entries inside managed directory roots during
 * `phronia adopt`.
 *
 * The work is split into plan/apply for two reasons:
 *
 * - `adopt --dry-run` must predict the same outcome without writing anything;
 * - apply re-validates the disk before every mutation, which is the
 *   filesystem-safety rule for rename-onto-existing and recursive deletes.
 *
 * Only directories are ever walked, and callers pass `getManagedDirs()` output
 * — a file root here would make `readdir` throw ENOTDIR.
 */

export interface LegacyRetirementOptions {
  /** Project root. Every reported path is posix and relative to it. */
  cwd: string;
  /** Managed directory roots, relative to `cwd` (from `getManagedDirs`). */
  roots: readonly string[];
  /**
   * Posix paths (relative to `cwd`) that are already gone (apply) or slated
   * for deletion (dry-run). A directory holding only such files counts as
   * empty.
   */
  removedFiles?: ReadonlySet<string>;
  /** Legacy name prefix. Defaults to `trellis-`. */
  prefix?: string;
  /** Replacement prefix. Defaults to `phronia-`. */
  replacement?: string;
}

export interface LegacyRename {
  /** Posix path relative to the project root. */
  from: string;
  /** Posix path relative to the project root. */
  to: string;
}

export interface LegacyRetirementPlan {
  /** Entries to move to their `phronia-*` name. */
  renames: LegacyRename[];
  /** Empty legacy trees to delete. */
  prunes: string[];
  /** Legacy entries holding user content whose `phronia-*` target already exists. */
  conflicts: string[];
}

export interface LegacyRetirementResult {
  renamed: LegacyRename[];
  pruned: string[];
  conflicts: string[];
}

const DEFAULT_PREFIX = "trellis-";
const DEFAULT_REPLACEMENT = "phronia-";

export function planLegacyRetirement(
  options: LegacyRetirementOptions,
): LegacyRetirementPlan {
  const state = resolveOptions(options);
  const plan: LegacyRetirementPlan = { renames: [], prunes: [], conflicts: [] };

  for (const root of state.roots) {
    visitDirectory(state, root, plan);
  }

  return plan;
}

/**
 * Execute a plan. Every action is re-checked against the filesystem; an action
 * that can no longer be applied safely degrades to a conflict instead of
 * guessing.
 */
export function applyLegacyRetirement(
  options: LegacyRetirementOptions,
  plan: LegacyRetirementPlan,
): LegacyRetirementResult {
  const state = resolveOptions(options);
  const result: LegacyRetirementResult = {
    renamed: [],
    pruned: [],
    conflicts: [],
  };

  for (const rename of plan.renames) {
    const fromAbs = state.abs(rename.from);
    const toAbs = state.abs(rename.to);
    if (!fs.existsSync(fromAbs)) {
      continue;
    }
    if (fs.existsSync(toAbs)) {
      result.conflicts.push(rename.from);
      continue;
    }
    fs.renameSync(fromAbs, toAbs);
    result.renamed.push(rename);
  }

  for (const entry of plan.prunes) {
    const abs = state.abs(entry);
    if (!fs.existsSync(abs) || !isDirectory(abs)) {
      continue;
    }
    if (pruneEmptyTree(abs)) {
      result.pruned.push(entry);
    } else {
      result.conflicts.push(entry);
    }
  }

  for (const entry of plan.conflicts) {
    if (fs.existsSync(state.abs(entry))) {
      result.conflicts.push(entry);
    }
  }

  return result;
}

interface ResolvedOptions {
  cwd: string;
  roots: string[];
  prefix: string;
  replacement: string;
  removedFiles: ReadonlySet<string>;
  abs(relativePosix: string): string;
}

function resolveOptions(options: LegacyRetirementOptions): ResolvedOptions {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  if (prefix.length === 0) {
    throw new Error("legacy entry prefix must not be empty");
  }
  const cwd = path.resolve(options.cwd);
  const roots = [
    ...new Set(
      options.roots
        .map((root) => root.replace(/\\/g, "/"))
        .filter((root) => root.length > 0 && root !== "."),
    ),
  ].sort((left, right) => left.localeCompare(right));

  return {
    cwd,
    roots,
    prefix,
    replacement: options.replacement ?? DEFAULT_REPLACEMENT,
    removedFiles: options.removedFiles ?? new Set<string>(),
    abs: (relativePosix) =>
      path.join(cwd, ...relativePosix.split("/").filter(Boolean)),
  };
}

function visitDirectory(
  state: ResolvedOptions,
  relativeRoot: string,
  plan: LegacyRetirementPlan,
): void {
  const rootAbs = state.abs(relativeRoot);
  if (!fs.existsSync(rootAbs) || !isDirectory(rootAbs)) {
    return;
  }
  walk(state, relativeRoot, plan);
}

function walk(
  state: ResolvedOptions,
  relativeDir: string,
  plan: LegacyRetirementPlan,
): void {
  const dirAbs = state.abs(relativeDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return; // Unreadable directory: nothing to retire, never guess.
  }

  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const relativeEntry = `${relativeDir}/${entry.name}`;
    const absEntry = state.abs(relativeEntry);

    if (entry.isFile()) {
      if (entry.name.startsWith(state.prefix)) {
        recordFileVerdict(state, relativeEntry, plan);
      }
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name.startsWith(state.prefix)) {
      recordDirectoryVerdict(state, relativeEntry, absEntry, plan);
      continue;
    }

    if (entry.name === ".git") {
      continue;
    }

    walk(state, relativeEntry, plan);
  }
}

function recordFileVerdict(
  state: ResolvedOptions,
  relativeEntry: string,
  plan: LegacyRetirementPlan,
): void {
  const target = renamedSibling(state, relativeEntry);
  if (fs.existsSync(state.abs(target))) {
    plan.conflicts.push(relativeEntry);
    return;
  }
  plan.renames.push({ from: relativeEntry, to: target });
}

function recordDirectoryVerdict(
  state: ResolvedOptions,
  relativeEntry: string,
  absEntry: string,
  plan: LegacyRetirementPlan,
): void {
  if (!subtreeHasContent(state, relativeEntry, absEntry)) {
    plan.prunes.push(relativeEntry);
    return;
  }
  const target = renamedSibling(state, relativeEntry);
  if (fs.existsSync(state.abs(target))) {
    plan.conflicts.push(relativeEntry);
    return;
  }
  plan.renames.push({ from: relativeEntry, to: target });
}

function renamedSibling(state: ResolvedOptions, relativeEntry: string): string {
  const dir = path.posix.dirname(relativeEntry);
  const name = path.posix.basename(relativeEntry);
  const next = `${state.replacement}${name.slice(state.prefix.length)}`;
  return dir === "." ? next : `${dir}/${next}`;
}

/**
 * True when the tree still holds anything worth keeping: a regular file that
 * is not slated for deletion, a symlink, or a special entry. Empty nested
 * directories do not count as content.
 */
function subtreeHasContent(
  state: ResolvedOptions,
  relativeDir: string,
  dirAbs: string,
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return true; // Unreadable: treat as content so nothing is deleted.
  }
  for (const entry of entries) {
    const relativeEntry = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (subtreeHasContent(state, relativeEntry, path.join(dirAbs, entry.name))) {
        return true;
      }
      continue;
    }
    if (entry.isFile()) {
      if (!state.removedFiles.has(relativeEntry)) {
        return true;
      }
      continue;
    }
    return true; // Symlink or special entry: preserve conservatively.
  }
  return false;
}

/**
 * Delete an empty tree bottom-up. Returns false (without deleting anything it
 * could not prove empty) when a file shows up during the walk.
 */
function pruneEmptyTree(dirAbs: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const childAbs = path.join(dirAbs, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (!pruneEmptyTree(childAbs)) {
        return false;
      }
      continue;
    }
    return false;
  }
  try {
    fs.rmdirSync(dirAbs);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(absPath: string): boolean {
  try {
    return fs.lstatSync(absPath).isDirectory();
  } catch {
    return false;
  }
}
