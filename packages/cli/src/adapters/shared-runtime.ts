/**
 * Shared-runtime adapter (design.md §1, §3.2, §19, §25.2).
 *
 * Resolves `<git-common-dir>/phronia/` (the only place all worktrees can see),
 * provides atomic JSON reads/writes, and migrates the legacy per-checkout
 * `.phronia/.runtime/worktrees.json` registry into the shared location.
 *
 * All writes are same-directory temp + rename; reads are tolerant and return
 * structured results instead of throwing. This module performs no printing
 * and never exits.
 */

import fs from "node:fs";
import path from "node:path";
import { LAYOUT } from "@phronia/core/layout";
import {
  diagnostic,
  isSupportedSchemaVersion,
  legacyWorktreeRegistryPath,
  readSchemaVersion,
  sharedRuntimePaths,
  sharedRuntimePathsFromRoot,
  SHARED_RUNTIME_SCHEMA_VERSION,
  SUPPORTED_RUNTIME_SCHEMA_VERSIONS,
  type Diagnostic,
  type SharedRuntimePaths,
} from "@phronia/core/state";
import type { GitPort, WorktreeInfo } from "./git.js";

export type RuntimeFileCode =
  | "RUNTIME_FILE_MISSING"
  | "RUNTIME_FILE_INVALID"
  | "RUNTIME_SCHEMA_UNSUPPORTED"
  | "RUNTIME_WRITE_FAILED";

export interface RuntimeReadResult<T> {
  readonly ok: boolean;
  readonly value: T | null;
  readonly path: string;
  readonly missing: boolean;
  readonly code: RuntimeFileCode | null;
  readonly message: string | null;
}

export interface RuntimeWriteResult {
  readonly ok: boolean;
  readonly path: string;
  readonly code: RuntimeFileCode | null;
  readonly message: string | null;
}

export interface SharedRuntimeResolution {
  readonly paths: SharedRuntimePaths;
  /** null when git could not be consulted and the fallback was used. */
  readonly commonDir: string | null;
  readonly fallback: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ResolveSharedRuntimeOptions {
  readonly cwd: string;
  readonly git: Pick<GitPort, "commonDir">;
  /** Defaults to `<cwd>/.phronia/.runtime`. */
  readonly fallbackRoot?: string;
}

export interface EnsureRuntimeResult {
  readonly ok: boolean;
  readonly created: readonly string[];
  readonly message: string | null;
}

export interface WorktreeRegistryEntry {
  taskRef: string;
  path: string;
  branch: string;
  kind?: "phronia" | "platform";
  provisional?: boolean;
  createdAt?: string;
  /** Legacy B11 field; preserved when migrating. */
  taskId?: string;
}

export interface WorktreeRegistry {
  schemaVersion: typeof SHARED_RUNTIME_SCHEMA_VERSION;
  worktrees: WorktreeRegistryEntry[];
}

export interface LoadWorktreeRegistryOptions {
  /** Main checkout root, used for the legacy path and git discovery. */
  readonly projectRoot: string;
  readonly paths: SharedRuntimePaths;
  /** Needed to rebuild when both registry files are missing. */
  readonly git?: Pick<GitPort, "worktreeList">;
  /** Defaults to true. `false` makes the load read-only (dry-run/tests). */
  readonly write?: boolean;
}

export interface WorktreeRegistryLoadResult {
  readonly registry: WorktreeRegistry;
  readonly migrated: boolean;
  readonly rebuilt: boolean;
  readonly wrote: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Resolve the shared runtime. Falls back to `<cwd>/.phronia/.runtime` with a
 * warning when git cannot report a common dir (non-repo, git missing).
 */
export function resolveSharedRuntime(
  options: ResolveSharedRuntimeOptions,
): SharedRuntimeResolution {
  const cwd = path.resolve(options.cwd);
  try {
    const commonDir = options.git.commonDir(cwd);
    return {
      paths: sharedRuntimePaths(commonDir),
      commonDir,
      fallback: false,
      diagnostics: [],
    };
  } catch (error) {
    const fallbackRoot =
      options.fallbackRoot ?? path.join(cwd, LAYOUT.paths.runtime);
    return {
      paths: sharedRuntimePathsFromRoot(fallbackRoot),
      commonDir: null,
      fallback: true,
      diagnostics: [
        diagnostic(
          "RUNTIME_SHARED_UNAVAILABLE",
          "warn",
          `cannot resolve git-common-dir (${errorMessage(error)}); using ${fallbackRoot}`,
          { path: fallbackRoot },
        ),
      ],
    };
  }
}

/** Create the shared root plus `leases/` and `logs/`. */
export function ensureSharedRuntime(
  paths: SharedRuntimePaths,
): EnsureRuntimeResult {
  const directories = [paths.root, paths.leases, paths.logs];
  const created: string[] = [];
  try {
    for (const directory of directories) {
      const existed = fs.existsSync(directory);
      fs.mkdirSync(directory, { recursive: true });
      if (!existed) {
        created.push(directory);
      }
    }
    return { ok: true, created, message: null };
  } catch (error) {
    return {
      ok: false,
      created,
      message: `cannot create shared runtime at ${paths.root}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Read and validate a JSON runtime file.
 *
 * Missing files are reported as `RUNTIME_FILE_MISSING` and are not errors for
 * rebuildable projections (registry, index). Malformed JSON or an unknown
 * `schemaVersion` is `RUNTIME_FILE_INVALID` / `RUNTIME_SCHEMA_UNSUPPORTED`.
 */
export function readRuntimeJson<T = unknown>(
  target: string,
  options: {
    readonly supportedVersions?: readonly number[];
  } = {},
): RuntimeReadResult<T> {
  const supported =
    options.supportedVersions ?? SUPPORTED_RUNTIME_SCHEMA_VERSIONS;
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return {
        ok: false,
        value: null,
        path: target,
        missing: true,
        code: "RUNTIME_FILE_MISSING",
        message: `${target} does not exist`,
      };
    }
    return {
      ok: false,
      value: null,
      path: target,
      missing: false,
      code: "RUNTIME_FILE_INVALID",
      message: `cannot read ${target}: ${errorMessage(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(content)) as unknown;
  } catch (error) {
    return {
      ok: false,
      value: null,
      path: target,
      missing: false,
      code: "RUNTIME_FILE_INVALID",
      message: `${target} is not valid JSON: ${errorMessage(error)}`,
    };
  }

  const version = readSchemaVersion(parsed);
  if (!isSupportedSchemaVersion(version, supported)) {
    return {
      ok: false,
      value: null,
      path: target,
      missing: false,
      code: "RUNTIME_SCHEMA_UNSUPPORTED",
      message:
        version === null
          ? `${target} has no numeric schemaVersion; expected ${supported.join(", ")}`
          : `${target} uses schemaVersion ${version}; this Phronia build supports ${supported.join(", ")}`,
    };
  }

  return {
    ok: true,
    value: parsed as T,
    path: target,
    missing: false,
    code: null,
    message: null,
  };
}

/**
 * Atomically write a JSON runtime file (same-directory temp + rename).
 *
 * `schemaVersion` defaults to the current version and is rejected when the
 * caller asks for an unsupported one.
 */
export function writeRuntimeJson(
  target: string,
  value: unknown,
): RuntimeWriteResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      path: target,
      code: "RUNTIME_FILE_INVALID",
      message: `refusing to write non-object JSON to ${target}`,
    };
  }

  const record = { ...(value as Record<string, unknown>) };
  if (record.schemaVersion === undefined) {
    record.schemaVersion = SHARED_RUNTIME_SCHEMA_VERSION;
  }
  if (!isSupportedSchemaVersion(record.schemaVersion)) {
    return {
      ok: false,
      path: target,
      code: "RUNTIME_SCHEMA_UNSUPPORTED",
      message: `refusing to write schemaVersion ${String(record.schemaVersion)} to ${target}`,
    };
  }

  const directory = path.dirname(target);
  const temp = path.join(
    directory,
    `${path.basename(target)}.${process.pid}.${randomSuffix()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fd = fs.openSync(temp, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
    return { ok: true, path: target, code: null, message: null };
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // Temp file may not exist.
    }
    return {
      ok: false,
      path: target,
      code: "RUNTIME_WRITE_FAILED",
      message: `cannot write ${target}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Load the worktree registry with legacy migration and git rebuild.
 *
 * Order:
 * 1. read `<common>/phronia/worktrees.json`;
 * 2. merge any legacy `.phronia/.runtime/worktrees.json` entries that the
 *    shared file does not already contain (shared file wins on conflict);
 * 3. when neither exists (or both are invalid), rebuild from
 *    `git worktree list --porcelain`;
 * 4. when both registries exist and git is available, drop merged entries
 *    whose worktree no longer appears in `git worktree list` (git wins on
 *    conflict, design.md §25.7);
 * 5. write only the shared location, and only when something changed.
 *
 * The legacy file is never modified or deleted, so rollback stays possible.
 */
export function loadWorktreeRegistry(
  options: LoadWorktreeRegistryOptions,
): WorktreeRegistryLoadResult {
  const diagnostics: Diagnostic[] = [];
  const sharedRead =
    readRuntimeJson<WorktreeRegistry>(options.paths.worktrees);
  const legacyPath = legacyWorktreeRegistryPath(options.projectRoot);
  const legacyRead = readRuntimeJson<WorktreeRegistry>(legacyPath);

  if (!sharedRead.ok && !sharedRead.missing) {
    diagnostics.push(
      diagnostic(
        sharedRead.code ?? "RUNTIME_FILE_INVALID",
        "warn",
        sharedRead.message ?? `cannot read ${options.paths.worktrees}`,
        { path: options.paths.worktrees },
      ),
    );
  }
  if (!legacyRead.ok && !legacyRead.missing) {
    diagnostics.push(
      diagnostic(
        legacyRead.code ?? "RUNTIME_FILE_INVALID",
        "warn",
        legacyRead.message ?? `cannot read ${legacyPath}`,
        { path: legacyPath },
      ),
    );
  }

  const originalSharedEntries = validEntries(sharedRead.value);
  let sharedEntries = originalSharedEntries;
  let legacyEntries = validEntries(legacyRead.value);
  let pruned = 0;

  if (sharedRead.ok && legacyRead.ok && options.git !== undefined) {
    const live = liveWorktreePaths(options.projectRoot, options.git);
    if (live === null) {
      diagnostics.push(
        diagnostic(
          "RUNTIME_WORKTREES_UNVERIFIED",
          "warn",
          "cannot verify the worktree registry with git; keeping the merged entries",
          { path: options.paths.worktrees },
        ),
      );
    } else {
      const before = sharedEntries.length + legacyEntries.length;
      sharedEntries = sharedEntries.filter((entry) =>
        live.has(comparablePath(entry.path)),
      );
      legacyEntries = legacyEntries.filter((entry) =>
        live.has(comparablePath(entry.path)),
      );
      pruned = before - sharedEntries.length - legacyEntries.length;
      if (pruned > 0) {
        diagnostics.push(
          diagnostic(
            "RUNTIME_WORKTREES_PRUNED",
            "info",
            `dropped ${pruned} worktree registry entr${
              pruned === 1 ? "y" : "ies"
            } no longer present in git worktree list`,
            { path: options.paths.worktrees },
          ),
        );
      }
    }
  }

  const entries: WorktreeRegistryEntry[] = [];
  const byTaskRef = new Map<string, WorktreeRegistryEntry>();
  const byPath = new Set<string>();

  const add = (entry: WorktreeRegistryEntry): boolean => {
    const normalized = normalizeEntry(entry);
    if (normalized.path === "") {
      return false;
    }
    if (byTaskRef.has(normalized.taskRef) || byPath.has(normalized.path)) {
      return false;
    }
    byTaskRef.set(normalized.taskRef, normalized);
    byPath.add(normalized.path);
    entries.push(normalized);
    return true;
  };

  for (const entry of sharedEntries) {
    add(entry);
  }

  let migrated = false;
  for (const entry of legacyEntries) {
    if (add(entry)) {
      migrated = true;
    }
  }

  let rebuilt = false;
  if (entries.length === 0 && options.git !== undefined) {
    const discovered = rebuildFromGit(options.projectRoot, options.git);
    for (const entry of discovered) {
      if (add(entry)) {
        rebuilt = true;
      }
    }
    if (rebuilt) {
      diagnostics.push(
        diagnostic(
          "RUNTIME_WORKTREES_REBUILT",
          "info",
          `worktree registry rebuilt from git (${entries.length} linked worktrees)`,
          { path: options.paths.worktrees },
        ),
      );
    }
  }

  if (migrated) {
    diagnostics.push(
      diagnostic(
        "RUNTIME_WORKTREES_MIGRATED",
        "info",
        `merged ${legacyEntries.length} legacy worktree entr${
          legacyEntries.length === 1 ? "y" : "ies"
        } into the shared registry; ${legacyPath} was left untouched`,
        { path: options.paths.worktrees },
      ),
    );
  }

  const registry: WorktreeRegistry = {
    schemaVersion: SHARED_RUNTIME_SCHEMA_VERSION,
    worktrees: entries,
  };

  const sharedPruned =
    originalSharedEntries.length - sharedEntries.length;
  const needsWrite =
    !sharedRead.ok || migrated || rebuilt || sharedPruned > 0;
  let wrote = false;
  if (needsWrite && options.write !== false) {
    const writeResult = writeRuntimeJson(options.paths.worktrees, registry);
    wrote = writeResult.ok;
    if (!writeResult.ok) {
      diagnostics.push(
        diagnostic(
          writeResult.code ?? "RUNTIME_WRITE_FAILED",
          "warn",
          writeResult.message ?? `cannot write ${options.paths.worktrees}`,
          { path: options.paths.worktrees },
        ),
      );
    }
  }

  return { registry, migrated, rebuilt, wrote, diagnostics };
}

function liveWorktreePaths(
  projectRoot: string,
  git: Pick<GitPort, "worktreeList">,
): ReadonlySet<string> | null {
  try {
    return new Set(
      git
        .worktreeList(projectRoot)
        .map((worktree) => comparablePath(worktree.path)),
    );
  } catch {
    return null;
  }
}

/** Resolve symlinks when possible so path comparisons match git output. */
function comparablePath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function rebuildFromGit(
  projectRoot: string,
  git: Pick<GitPort, "worktreeList">,
): readonly WorktreeRegistryEntry[] {
  let worktrees: readonly WorktreeInfo[];
  try {
    worktrees = git.worktreeList(projectRoot);
  } catch {
    return [];
  }
  const discovered: WorktreeRegistryEntry[] = [];
  // `git worktree list` prints the main worktree first; only linked worktrees
  // belong in the shared registry.
  for (const [index, worktree] of worktrees.entries()) {
    if (index === 0 || worktree.bare) {
      continue;
    }
    const branch = worktree.branch ?? "";
    const taskRef = taskRefFromBranch(branch);
    discovered.push({
      taskRef,
      path: path.resolve(worktree.path),
      branch,
      kind: branch.startsWith("phronia/") ? "phronia" : "platform",
      provisional: taskRef === "",
      createdAt: "",
    });
  }
  return discovered;
}

function taskRefFromBranch(branch: string): string {
  const prefix = "phronia/";
  if (!branch.startsWith(prefix)) {
    return "";
  }
  const name = branch.slice(prefix.length);
  return name === "" ? "" : `${LAYOUT.paths.tasks}/${name}`;
}

function normalizeEntry(entry: WorktreeRegistryEntry): WorktreeRegistryEntry {
  return {
    taskRef: typeof entry.taskRef === "string" ? entry.taskRef : "",
    path: typeof entry.path === "string" ? entry.path : "",
    branch: typeof entry.branch === "string" ? entry.branch : "",
    kind: entry.kind === "platform" ? "platform" : "phronia",
    ...(entry.provisional === true ? { provisional: true } : {}),
    ...(typeof entry.createdAt === "string" && entry.createdAt !== ""
      ? { createdAt: entry.createdAt }
      : {}),
    ...(typeof entry.taskId === "string" && entry.taskId !== ""
      ? { taskId: entry.taskId }
      : {}),
  };
}

function validEntries(value: WorktreeRegistry | null): readonly WorktreeRegistryEntry[] {
  return value !== null && Array.isArray(value.worktrees)
    ? value.worktrees.filter(
        (entry): entry is WorktreeRegistryEntry =>
          typeof entry === "object" && entry !== null,
      )
    : [];
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
