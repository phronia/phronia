/**
 * Read-only runtime facts for dispatch admission and breadcrumbs.
 *
 * Invariant: reading facts never throws and never writes. Missing, corrupt, or
 * unknown-schema files degrade to null/empty plus a stable diagnostic; a
 * non-git checkout degrades the git-derived fields and sets
 * `factsReliable=false`. Callers decide whether an unreliable read becomes an
 * advisory guard (it must never become a block on its own).
 *
 * Cost model: a standard checkout is read purely from the filesystem
 * (`<root>/.git` as a directory or `gitdir:` file, `commondir`, `HEAD`). Git is
 * spawned only for a non-standard layout, and `status --porcelain` runs only
 * when a claim exists — the common single-task/no-claim turn makes zero git
 * calls. Paths come from `sharedRuntimePaths`/`taskLeasePath`, so this module
 * cannot drift from the CLI's writer.
 */

import path from "node:path";
import { diagnostic, type Diagnostic } from "./diagnostics.js";
import { nodeFs, readJson, readText, type FsLike } from "./fs.js";
import {
  defaultGitExec,
  type GitExec,
  type GitResult,
} from "./git.js";
import {
  isSupportedSchemaVersion,
  readSchemaVersion,
  resolveCommonDir,
  sharedRuntimePaths,
  taskLeasePath,
  type SharedRuntimePaths,
} from "./shared-runtime.js";

export interface RuntimeFactsOptions {
  /** Explicit project root (never `process.cwd()`). */
  readonly root: string;
  readonly exec?: GitExec;
  readonly io?: FsLike;
  /** Epoch seconds used for TTL staleness. */
  readonly now?: number;
  /**
   * Read `mainDirty` (the claim-gated `git status --porcelain`).
   *
   * Defaults to true so a caller that forgets still gets complete facts.
   * Breadcrumbs pass false: they never render dirtiness, and paying for a
   * status spawn on every user prompt is pure waste. When false, `mainDirty`
   * is null and that is not an unreliable-facts signal.
   */
  readonly includeMainDirty?: boolean;
}

export interface RuntimeClaim {
  readonly taskRef: string | null;
  readonly ownerRef: string;
  readonly sessionKey: string | null;
  readonly state: string | null;
  readonly workspace: string | null;
  readonly heartbeatAt: string | null;
  readonly ttlSeconds: number | null;
  readonly stale: boolean;
  readonly path: string;
}

export interface RuntimeWorktree {
  /** Null for provisional/empty entries; they are not registered to a task. */
  readonly taskRef: string | null;
  readonly path: string;
  readonly branch: string;
  readonly kind: "phronia" | "platform";
  readonly provisional: boolean;
}

export interface RuntimeLease {
  readonly taskRef: string;
  readonly ownerType: "session" | "subagent" | "task";
  readonly ownerId: string;
  readonly sessionKey: string | null;
  readonly workspace: string | null;
  readonly heartbeatAt: string | null;
  readonly ttlSeconds: number | null;
  readonly stale: boolean;
  /** Canonical lease path derived with the same rule as the CLI writer. */
  readonly path: string;
}

export interface RuntimeFacts {
  /** Main worktree root; null when git could not report it. */
  readonly mainRoot: string | null;
  /**
   * Current worktree root. The fast layout path uses `root`; the git fallback
   * uses `rev-parse --show-toplevel`. Null on failure. `projectRoot` may be a
   * subdirectory, so checkout comparisons must use this value.
   */
  readonly toplevel: string | null;
  readonly isLinkedWorktree: boolean;
  /** Current branch; empty for detached HEAD or a failed read. */
  readonly branch: string;
  /**
   * Main checkout dirtiness. Status is claim-gated and opt-in:
   * - no claim read, or `includeMainDirty: false` → null (expected);
   * - claim read + status failure → null and `factsReliable=false`.
   */
  readonly mainDirty: boolean | null;
  readonly claim: RuntimeClaim | null;
  readonly worktrees: readonly RuntimeWorktree[];
  readonly leases: readonly RuntimeLease[];
  readonly diagnostics: readonly Diagnostic[];
  readonly factsReliable: boolean;
}

type RuntimeFileStatus = "ok" | "missing" | "invalid" | "unsupported";

interface RuntimeFileResult<T> {
  readonly status: RuntimeFileStatus;
  readonly value: T | null;
  readonly version: number | null;
}

/** Resolved checkout layout used by both the fast and fallback readers. */
interface Layout {
  readonly commonDir: string;
  readonly gitdir: string;
  readonly toplevel: string;
  readonly mainRoot: string;
  readonly branch: string;
  readonly isLinkedWorktree: boolean;
}

type FastLayoutResult =
  | { readonly ok: true; readonly layout: Layout }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Parsed gitdir, if the `.git` file was readable; used for HEAD. */
      readonly gitdir: string | null;
    };

export function readRuntimeFacts(options: RuntimeFactsOptions): RuntimeFacts {
  const root = path.resolve(options.root);
  const io = options.io ?? nodeFs;
  const exec = options.exec ?? defaultGitExec;
  const now = options.now ?? Date.now() / 1000;
  const diagnostics: Diagnostic[] = [];
  let reliable = true;

  const fast = readFastLayout(io, root);
  const layout = fast.ok
    ? fast.layout
    : readFallbackLayout(
        root,
        exec,
        io,
        fast.gitdir,
        fast.reason,
        diagnostics,
      );

  if (layout === null) {
    return {
      mainRoot: null,
      toplevel: null,
      isLinkedWorktree: false,
      branch: "",
      mainDirty: null,
      claim: null,
      worktrees: [],
      leases: [],
      diagnostics,
      factsReliable: false,
    };
  }

  const paths = sharedRuntimePaths(layout.commonDir);
  const claim = readClaim(io, paths.workspaceClaim, now, diagnostics, () => {
    reliable = false;
  });

  // Dirty status is only relevant to the stale-claim decision. Without a
  // claim — or when the caller explicitly opts out — it is not read, and
  // `null` is expected rather than an unreliable signal.
  const includeMainDirty = options.includeMainDirty !== false;
  const mainDirty =
    !includeMainDirty || claim === null
      ? null
      : readMainDirty(layout.mainRoot, exec, diagnostics);
  if (includeMainDirty && claim !== null && mainDirty === null) {
    reliable = false;
  }

  const worktrees = readWorktrees(io, paths.worktrees, diagnostics, () => {
    reliable = false;
  });

  const leases = readLeases(io, paths, now, diagnostics);

  return {
    mainRoot: layout.mainRoot,
    toplevel: layout.toplevel,
    isLinkedWorktree: layout.isLinkedWorktree,
    branch: layout.branch,
    mainDirty,
    claim,
    worktrees,
    leases,
    diagnostics,
    factsReliable: reliable,
  };
}

/**
 * Pure-filesystem layout read for standard checkouts.
 *
 * Handles a `.git` directory and a linked worktree's `.git` file (with
 * `commondir`), and derives the branch from `HEAD`. Returns a fallback reason
 * for bare repositories, submodules (`modules`), a missing/unreadable `.git`,
 * or a non-standard common dir.
 */
function readFastLayout(io: FsLike, root: string): FastLayoutResult {
  const gitPath = path.join(root, ".git");
  const gitStat = statOf(io, gitPath);
  if (gitStat === null) {
    return fallback("no .git entry", null);
  }

  let gitdir: string;
  if (gitStat.isDirectory()) {
    gitdir = path.resolve(gitPath);
  } else if (gitStat.isFile()) {
    const content = readText(io, gitPath);
    if (content === null) {
      return fallback(".git file is unreadable", null);
    }
    const raw = parseGitdirLine(content);
    if (raw === null) {
      return fallback(".git file has no gitdir line", null);
    }
    gitdir = path.resolve(root, raw);
    if (statOf(io, gitdir)?.isDirectory() !== true) {
      return fallback("gitdir is not a readable directory", gitdir);
    }
  } else {
    return fallback(".git is neither a file nor a directory", null);
  }

  let commonDir = gitdir;
  const commondirPath = path.join(gitdir, "commondir");
  if (statOf(io, commondirPath)?.isFile() === true) {
    const raw = readText(io, commondirPath);
    if (raw === null) {
      return fallback("commondir is unreadable", gitdir);
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      return fallback("commondir is empty", gitdir);
    }
    commonDir = path.resolve(gitdir, trimmed);
  }

  if (path.basename(commonDir) !== ".git") {
    return fallback("common dir is not a .git directory", gitdir);
  }

  const branch = readHeadBranch(io, gitdir);
  if (branch === null) {
    return fallback("HEAD is unreadable", gitdir);
  }

  const toplevel = path.resolve(root);
  const mainRoot = path.dirname(commonDir);
  return {
    ok: true,
    layout: {
      commonDir,
      gitdir,
      toplevel,
      mainRoot,
      branch,
      isLinkedWorktree: toplevel !== path.resolve(mainRoot),
    },
  };
}

/**
 * Combined `rev-parse` fallback for bare/submodule/non-standard layouts.
 *
 * One spawn returns both paths; the branch is still parsed from the gitdir's
 * `HEAD` (no `branch --show-current` spawning).
 */
function readFallbackLayout(
  root: string,
  exec: GitExec,
  io: FsLike,
  fallbackGitdir: string | null,
  reason: string,
  diagnostics: Diagnostic[],
): Layout | null {
  const result = safeExec(
    exec,
    ["rev-parse", "--git-common-dir", "--show-toplevel"],
    root,
  );
  if (result?.status !== 0) {
    diagnostics.push(
      diagnostic(
        "state.runtime.git_unavailable",
        "warn",
        `cannot resolve git layout for ${root}; runtime facts are unavailable`,
        {
          path: root,
          details: {
            reason,
            next: "run this command from inside a git repository",
          },
        },
      ),
    );
    return null;
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    diagnostics.push(
      diagnostic(
        "state.runtime.git_layout_invalid",
        "warn",
        "git rev-parse did not return both the common dir and worktree root",
        {
          path: root,
          details: {
            reason,
            next: "run git rev-parse --git-common-dir --show-toplevel",
          },
        },
      ),
    );
    return null;
  }

  let commonDir: string;
  try {
    commonDir = resolveCommonDir(lines[0], root);
  } catch {
    diagnostics.push(
      diagnostic(
        "state.runtime.git_layout_invalid",
        "warn",
        "git reported an empty git-common-dir",
        { path: root, details: { reason } },
      ),
    );
    return null;
  }

  const toplevel = path.resolve(root, lines[1]);
  const gitdir = fallbackGitdir ?? commonDir;
  const branch = readHeadBranch(io, gitdir) ?? "";
  const mainRoot = mainRootFromCommonDirValue(commonDir) ?? toplevel;

  diagnostics.push(
    diagnostic(
      "state.runtime.git_fallback",
      "info",
      `non-standard git layout (${reason}); used one rev-parse fallback`,
      { path: root, details: { reason, gitCalls: 1 } },
    ),
  );

  return {
    commonDir,
    gitdir,
    toplevel,
    mainRoot,
    branch,
    isLinkedWorktree: path.resolve(toplevel) !== path.resolve(mainRoot),
  };
}

function fallback(reason: string, gitdir: string | null): FastLayoutResult {
  return { ok: false, reason, gitdir };
}

function parseGitdirLine(content: string): string | null {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith("gitdir:"));
  if (line === undefined) {
    return null;
  }
  const value = line.slice(line.indexOf(":") + 1).trim();
  return value === "" ? null : value;
}

/** Branch label from HEAD, or null when HEAD cannot be read. */
function readHeadBranch(io: FsLike, gitdir: string): string | null {
  const head = readText(io, path.join(gitdir, "HEAD"));
  if (head === null) {
    return null;
  }
  const trimmed = head.trim();
  const prefix = "ref: refs/heads/";
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : "";
}

function statOf(
  io: FsLike,
  target: string,
): { isDirectory(): boolean; isFile(): boolean } | null {
  try {
    return io.statSync(target);
  } catch {
    return null;
  }
}

function safeExec(
  exec: GitExec,
  args: readonly string[],
  cwd: string,
): GitResult | null {
  try {
    return exec(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Main worktree root derivable from the common dir alone.
 *
 * `<repo>/.git` → `<repo>`. Linked worktrees expose the common dir as the
 * main repository's `.git` path, so the directory before `.git` is the main
 * tree. Submodules (`<super>/.git/modules/<name>`) and non-standard layouts
 * return null; the caller falls back to `rev-parse --show-toplevel`.
 */
function mainRootFromCommonDirValue(commonDir: string): string | null {
  const normalized = path.resolve(commonDir);
  const parts = normalized.split(path.sep);
  const gitIndex = parts.lastIndexOf(".git");
  if (gitIndex < 0 || parts[gitIndex + 1] === "modules") {
    return null;
  }
  const main = parts.slice(0, gitIndex).join(path.sep);
  return main === "" ? path.sep : main;
}

function readMainDirty(
  mainRoot: string,
  exec: GitExec,
  diagnostics: Diagnostic[],
): boolean | null {
  const result = safeExec(exec, ["status", "--porcelain"], mainRoot);
  if (result?.status !== 0) {
    diagnostics.push(
      diagnostic(
        "state.runtime.git_status_failed",
        "warn",
        `git could not report status for ${mainRoot}`,
        {
          path: mainRoot,
          details: { next: "check that the main worktree is readable" },
        },
      ),
    );
    return null;
  }
  return result.stdout.split(/\r?\n/).some((line) => line.trim().length > 0);
}

function readClaim(
  io: FsLike,
  file: string,
  now: number,
  diagnostics: Diagnostic[],
  markUnreliable: () => void,
): RuntimeClaim | null {
  const read = readRuntimeFile<Record<string, unknown>>(io, file);
  switch (read.status) {
    case "missing":
      diagnostics.push(
        diagnostic(
          "state.runtime.claim_missing",
          "info",
          "no workspace claim file; the main checkout is unclaimed",
          { path: file },
        ),
      );
      return null;
    case "invalid":
      markUnreliable();
      diagnostics.push(
        diagnostic(
          "state.runtime.claim_invalid",
          "warn",
          `${file} is not valid JSON`,
          {
            path: file,
            details: { next: `inspect or remove ${file}` },
          },
        ),
      );
      return null;
    case "unsupported":
      markUnreliable();
      diagnostics.push(
        diagnostic(
          "state.runtime.schema_unsupported",
          "warn",
          `${file} uses unsupported schemaVersion ${String(read.version)}`,
          {
            path: file,
            details: {
              schemaVersion: read.version,
              next: "run phronia update (this build supports schemaVersion 1)",
            },
          },
        ),
      );
      return null;
    case "ok": {
      const claim = toClaim(read.value, file, now);
      if (claim === null) {
        markUnreliable();
        diagnostics.push(
          diagnostic(
            "state.runtime.claim_invalid",
            "warn",
            `${file} is not a workspace claim record`,
            {
              path: file,
              details: { next: `inspect or remove ${file}` },
            },
          ),
        );
      }
      return claim;
    }
    default:
      return null;
  }
}

function readWorktrees(
  io: FsLike,
  file: string,
  diagnostics: Diagnostic[],
  markUnreliable: () => void,
): readonly RuntimeWorktree[] {
  const read = readRuntimeFile<Record<string, unknown>>(io, file);
  switch (read.status) {
    case "missing":
      diagnostics.push(
        diagnostic(
          "state.runtime.worktrees_missing",
          "info",
          "no worktree registry; no task is bound to a worktree",
          { path: file },
        ),
      );
      return [];
    case "invalid":
      markUnreliable();
      diagnostics.push(
        diagnostic(
          "state.runtime.worktrees_invalid",
          "warn",
          `${file} is not valid JSON`,
          {
            path: file,
            details: {
              next: "run phronia task worktree prune to rebuild the registry",
            },
          },
        ),
      );
      return [];
    case "unsupported":
      markUnreliable();
      diagnostics.push(
        diagnostic(
          "state.runtime.schema_unsupported",
          "warn",
          `${file} uses unsupported schemaVersion ${String(read.version)}`,
          {
            path: file,
            details: {
              schemaVersion: read.version,
              next: "run phronia update (this build supports schemaVersion 1)",
            },
          },
        ),
      );
      return [];
    case "ok":
      return parseWorktrees(io, read.value, diagnostics, markUnreliable);
    default:
      return [];
  }
}

function parseWorktrees(
  io: FsLike,
  value: Record<string, unknown> | null,
  diagnostics: Diagnostic[],
  markUnreliable: () => void,
): readonly RuntimeWorktree[] {
  const raw = value?.worktrees;
  if (!Array.isArray(raw)) {
    markUnreliable();
    diagnostics.push(
      diagnostic(
        "state.runtime.worktrees_invalid",
        "warn",
        "worktree registry has no worktrees array",
        {
          details: {
            next: "run phronia task worktree prune to rebuild the registry",
          },
        },
      ),
    );
    return [];
  }
  const worktrees: RuntimeWorktree[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const worktree = toWorktree(entry);
    if (worktree === null) {
      continue;
    }
    if (!io.existsSync(worktree.path)) {
      diagnostics.push(
        diagnostic(
          "state.runtime.worktree_missing",
          "warn",
          `worktree ${worktree.path} no longer exists; treating it as unregistered`,
          {
            path: worktree.path,
            details: {
              taskRef: worktree.taskRef,
              next: "run phronia task worktree prune",
            },
          },
        ),
      );
      continue;
    }
    worktrees.push(worktree);
  }
  return worktrees;
}

function readLeases(
  io: FsLike,
  paths: SharedRuntimePaths,
  now: number,
  diagnostics: Diagnostic[],
): readonly RuntimeLease[] {
  let entries: string[];
  try {
    entries = io.readdirSync(paths.leases);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      diagnostics.push(
        diagnostic(
          "state.runtime.leases_missing",
          "info",
          "no lease directory; no task lease is active",
          { path: paths.leases },
        ),
      );
    } else {
      diagnostics.push(
        diagnostic(
          "state.runtime.lease_dir_unreadable",
          "warn",
          `cannot read ${paths.leases}`,
          {
            path: paths.leases,
            details: { next: "check permissions on the shared runtime" },
          },
        ),
      );
    }
    return [];
  }

  const leases: RuntimeLease[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = path.join(paths.leases, entry);
    const read = readRuntimeFile<Record<string, unknown>>(io, file);
    if (read.status === "missing") {
      continue;
    }
    if (read.status !== "ok") {
      diagnostics.push(
        diagnostic(
          read.status === "unsupported"
            ? "state.runtime.schema_unsupported"
            : "state.runtime.lease_invalid",
          "warn",
          `${file} could not be read as a task lease`,
          {
            path: file,
            details: {
              schemaVersion: read.version,
              next: `inspect or remove ${file}`,
            },
          },
        ),
      );
      continue;
    }
    const lease = toLease(read.value, now, paths);
    if (lease === null) {
      diagnostics.push(
        diagnostic(
          "state.runtime.lease_invalid",
          "warn",
          `${file} is not a task lease record`,
          {
            path: file,
            details: { next: `inspect or remove ${file}` },
          },
        ),
      );
      continue;
    }
    leases.push(lease);
  }
  return leases;
}

function readRuntimeFile<T>(
  io: FsLike,
  file: string,
): RuntimeFileResult<T> {
  if (!io.existsSync(file)) {
    return { status: "missing", value: null, version: null };
  }
  const value = readJson<T>(io, file);
  if (value === null) {
    return { status: "invalid", value: null, version: null };
  }
  const version = readSchemaVersion(value);
  if (!isSupportedSchemaVersion(version)) {
    return { status: "unsupported", value: null, version };
  }
  return { status: "ok", value, version };
}

function toClaim(
  raw: Record<string, unknown> | null,
  file: string,
  now: number,
): RuntimeClaim | null {
  if (raw === null) {
    return null;
  }
  const ownerRef = stringField(raw.ownerRef);
  const heartbeatAt = stringField(raw.heartbeatAt);
  const ttlSeconds = numberField(raw.ttlSeconds);
  // A claim without a heartbeat/TTL cannot be proven fresh or stale. Treat it
  // as corrupt (null + diagnostic) rather than letting it block forever.
  if (ownerRef === null || heartbeatAt === null || ttlSeconds === null) {
    return null;
  }
  return {
    taskRef: stringField(raw.taskRef),
    ownerRef,
    sessionKey: stringField(raw.sessionKey),
    state: stringField(raw.state),
    workspace: stringField(raw.workspace),
    heartbeatAt,
    ttlSeconds,
    stale: isRecordStale(heartbeatAt, ttlSeconds, now),
    path: file,
  };
}

function toWorktree(raw: Record<string, unknown>): RuntimeWorktree | null {
  const worktreePath = stringField(raw.path);
  if (worktreePath === null) {
    return null;
  }
  const provisional = raw.provisional === true;
  return {
    taskRef: provisional ? null : stringField(raw.taskRef),
    path: worktreePath,
    branch: stringField(raw.branch) ?? "",
    kind: raw.kind === "platform" ? "platform" : "phronia",
    provisional,
  };
}

function toLease(
  raw: Record<string, unknown> | null,
  now: number,
  paths: SharedRuntimePaths,
): RuntimeLease | null {
  if (raw === null) {
    return null;
  }
  const taskRef = stringField(raw.taskRef);
  const ownerId = stringField(raw.ownerId);
  const ownerType = raw.ownerType;
  if (
    taskRef === null ||
    ownerId === null ||
    (ownerType !== "session" && ownerType !== "subagent" && ownerType !== "task")
  ) {
    return null;
  }
  const heartbeatAt = stringField(raw.heartbeatAt);
  const ttlSeconds = numberField(raw.ttlSeconds);
  return {
    taskRef,
    ownerType,
    ownerId,
    sessionKey: stringField(raw.sessionKey),
    workspace: stringField(raw.workspace),
    heartbeatAt,
    ttlSeconds,
    stale: isRecordStale(heartbeatAt, ttlSeconds, now),
    path: taskLeasePath(paths, taskRef),
  };
}

function isRecordStale(
  heartbeatAt: string | null,
  ttlSeconds: number | null,
  now: number,
): boolean {
  if (heartbeatAt === null || ttlSeconds === null || ttlSeconds <= 0) {
    return false;
  }
  const heartbeat = Date.parse(heartbeatAt);
  if (!Number.isFinite(heartbeat)) {
    return false;
  }
  return now > heartbeat / 1000 + ttlSeconds;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}
