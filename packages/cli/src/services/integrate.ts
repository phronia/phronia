/**
 * Integration service: local serial landing, remote handoff, conflict
 * classification, queueing, recovery, and `task commit` ownership.
 *
 * Design references: §3.2, §6, §7, §8, §18.3, §19, §20.1-20.6, §21, §25.
 *
 * Invariants enforced here:
 * - the main checkout is never moved on verification failure or conflict;
 * - the three mutual exclusions are acquired in the fixed order
 *   task lease -> workspace claim -> integration lock and released in reverse;
 * - the integration lock and queue live in `<git-common-dir>/phronia/`;
 * - a remote flow only pushes and opens a change request — it never merges;
 * - conflicts are classified and routed, never auto-resolved.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyConflict,
  dequeueTask,
  emptyTaskRecord,
  enqueueTask,
  footprintsOverlap,
  normalizeFootprint,
  outcomeForConflict,
  peekQueue,
  queuePosition,
  resolveIntegrationMode,
  TASK_RECORD_FIELD_ORDER,
  writeTaskRecord,
  type ConflictClassification,
  type Footprint,
  type IntegrationMode,
  type IntegrationModeResolution,
  type IntegrationOutcome,
  type QueueEntry,
  type ResolvedMode,
} from "@phronia/core/task";
import {
  openState,
  packagePathMap,
  type ConfigView,
  type SharedRuntimePaths,
  type StateReader,
  type TaskRecordView,
} from "@phronia/core/state";
import {
  createGitPort,
  GitError,
  type GitPort,
  type WorktreeInfo,
} from "../adapters/git.js";
import {
  createForgePort,
  type ForgePort,
} from "../adapters/forge.js";
import {
  createLeaseStore,
  isLeaseBusy,
  isLeaseStale,
  LeaseError,
  type LeaseHandle,
  type LeaseRecord,
  type LeaseStore,
} from "../adapters/lease.js";
import {
  ensureSharedRuntime,
  loadWorktreeRegistry,
  readRuntimeJson,
  resolveSharedRuntime,
  writeRuntimeJson,
  type WorktreeRegistryEntry,
} from "../adapters/shared-runtime.js";
import { acquireTaskLease, releaseTaskLease } from "./lease.js";
import { tokenize } from "./workspace.js";

const DEFAULT_VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_LOCK_TTL_SECONDS = 30 * 60;
const LOCK_HEARTBEAT_MARGIN_SECONDS = 120;
const WAIT_POLL_MS = 500;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_TAIL_CHARS = 4000;
const ACTIVE_TASK_STATUSES = new Set(["planning", "in_progress", "blocked"]);

export interface ModeChoiceContext {
  readonly resolution: IntegrationModeResolution;
  readonly taskRef: string;
  readonly baseBranch: string;
  readonly dryRun: boolean;
}

export interface IntegrateOptions {
  readonly cwd: string;
  readonly taskRef?: string | null;
  readonly mode?: IntegrationMode;
  readonly base?: string;
  readonly queue?: boolean;
  readonly wait?: boolean;
  readonly drain?: boolean;
  readonly verify?: readonly string[];
  readonly noVerify?: boolean;
  readonly timeout?: string;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly handoff?: boolean;
  readonly dryRun?: boolean;
  readonly recover?: boolean;
  readonly rollback?: boolean;
  readonly force?: boolean;
  /** Remote only: fetch the base and detect a merged change request. */
  readonly sync?: boolean;
  readonly sessionKey?: string;
  readonly ownerId?: string;
  readonly git?: GitPort;
  readonly forge?: ForgePort;
  readonly now?: () => Date;
  readonly hostname?: string;
  readonly pid?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly chooseMode?: (context: ModeChoiceContext) => ResolvedMode | null;
  readonly confirmRollback?: () => boolean;
  /** Internal guard so `--drain` cannot recurse. */
  readonly fromDrain?: boolean;
}

export interface IntegrateSuccess {
  readonly ok: true;
  readonly mode: ResolvedMode | null;
  readonly modeReason: string | null;
  readonly outcome: IntegrationOutcome;
  readonly baseSha: string | null;
  readonly commit: string | null;
  readonly prUrl: string | null;
  readonly conflict: ConflictClassification | null;
  readonly logPath: string | null;
  readonly next: string | null;
  readonly taskRef: string | null;
  readonly baseBranch: string | null;
  readonly branch: string | null;
  readonly workspace: string | null;
  readonly queued?: boolean;
  readonly queuePosition?: number | null;
  readonly handoffPath?: string | null;
  readonly compareUrl?: string | null;
  readonly manualCommand?: string | null;
  readonly sync?: "merged" | "closed" | "open" | "conflicting" | "unknown" | null;
  readonly dryRun?: boolean;
  readonly warnings?: readonly string[];
  readonly results?: readonly DrainItemResult[];
}

export interface IntegrateFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly next: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly mode?: ResolvedMode | null;
  readonly modeReason?: string | null;
  readonly outcome?: IntegrationOutcome;
  readonly baseSha?: string | null;
  readonly commit?: string | null;
  readonly prUrl?: string | null;
  readonly conflict?: ConflictClassification | null;
  readonly logPath?: string | null;
  readonly taskRef?: string | null;
  readonly baseBranch?: string | null;
  readonly workspace?: string | null;
  readonly handoffPath?: string | null;
  readonly compareUrl?: string | null;
  readonly manualCommand?: string | null;
}

export type IntegrateResult = IntegrateSuccess | IntegrateFailure;

export interface DrainItemResult {
  readonly taskRef: string;
  readonly ok: boolean;
  readonly mode: ResolvedMode | null;
  readonly outcome: IntegrationOutcome | null;
  readonly code?: string;
  readonly message?: string;
}

export interface CommitTaskOptions {
  readonly cwd: string;
  readonly message?: string;
  readonly git?: GitPort;
  readonly now?: () => Date;
}

export interface CommitTaskSuccess {
  readonly ok: true;
  readonly taskRef: string;
  readonly workspace: string;
  readonly commit: string | null;
  readonly committed: boolean;
  readonly message: string;
}

export type CommitTaskResult = CommitTaskSuccess | IntegrateFailure;

class IntegrationInputError extends Error {
  readonly code: string;
  readonly next: string;

  constructor(code: string, message: string, next: string) {
    super(message);
    this.name = "IntegrationInputError";
    this.code = code;
    this.next = next;
  }
}

interface IntegrationContext {
  readonly cwd: string;
  readonly mainRoot: string;
  readonly git: GitPort;
  readonly paths: SharedRuntimePaths;
  readonly config: ConfigView;
  readonly state: StateReader;
  readonly now: () => Date;
  readonly host: string;
  readonly pid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly registry: readonly WorktreeRegistryEntry[];
  readonly view: TaskRecordView;
  readonly ref: string;
  readonly taskId: string;
  readonly workspace: string;
  readonly taskUsesMain: boolean;
  readonly taskBranch: string | null;
  readonly baseBranch: string;
  readonly originUrl: string | null;
  readonly forge: ForgePort;
}

interface WorkspaceClaimRecord extends LeaseRecord {
  schemaVersion: number;
  ownerType: "session" | "task";
  ownerRef: string;
  sessionKey?: string;
  taskRef: string | null;
  workspace: string;
  branch: string;
  host: string;
  pid: number;
  state: string;
  acquiredAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
}

interface IntegrationLockRecord extends LeaseRecord {
  schemaVersion: number;
  owner: string;
  taskRef: string;
  host: string;
  pid: number;
  phase: "acquiring" | "rebasing" | "verifying" | "merging" | "done";
  baseBranch: string;
  preLandSha: string;
  postLandSha: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
}

interface IntegrationMeta {
  readonly mode: IntegrationMode | null;
  readonly outcome: IntegrationOutcome;
  readonly baseSha: string | null;
  readonly commit: string | null;
  readonly prUrl: string | null;
  readonly verified: boolean;
  readonly lastError: string | null;
  readonly logRef: string | null;
  readonly updatedAt: string | null;
}

interface PhaseState {
  readonly claim: LeaseHandle<WorkspaceClaimRecord> | null;
  readonly lock: LeaseHandle<IntegrationLockRecord>;
  claimStore: LeaseStore<WorkspaceClaimRecord> | null;
  lockStore: LeaseStore<IntegrationLockRecord>;
}

interface VerifyOutcome {
  readonly ok: boolean;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly outputTail: string;
  readonly logText: string;
  readonly logPath: string | null;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function integrateTask(options: IntegrateOptions): IntegrateResult {
  try {
    if (options.drain === true) {
      return drainQueue(options);
    }
    return integrateOne(options);
  } catch (error) {
    return failure(
      error instanceof GitError ? error.code : "INTEGRATE_FAILED",
      errorMessage(error),
      "inspect the repository state and retry",
    );
  }
}

export function commitTask(
  taskRef: string,
  options: CommitTaskOptions,
): CommitTaskResult {
  const git = options.git ?? createGitPort();
  let mainRoot: string;
  try {
    mainRoot = git.mainWorktreeRoot(path.resolve(options.cwd));
  } catch (error) {
    return failure(
      "GIT_UNAVAILABLE",
      `cannot resolve a git worktree: ${errorMessage(error)}`,
      "run this command inside a git repository",
    );
  }

  const resolution = resolveSharedRuntime({ cwd: mainRoot, git });
  ensureSharedRuntime(resolution.paths);
  const registry = loadWorktreeRegistry({
    projectRoot: mainRoot,
    paths: resolution.paths,
    git,
    write: false,
  });
  const canonical = canonicalRef(taskRef);
  const entry = registry.registry.worktrees.find(
    (candidate) => canonicalRef(candidate.taskRef) === canonical,
  );

  if (entry === undefined || entry.path === "") {
    return failure(
      "COMMIT_WRONG_WORKSPACE",
      `task ${canonical} has no task worktree; commit its changes in the checkout where it lives`,
      "run `phronia task workspace ensure <ref>` first if this task should be isolated",
    );
  }
  const workspace = path.resolve(entry.path);
  if (path.resolve(options.cwd) !== workspace) {
    return failure(
      "COMMIT_WRONG_WORKSPACE",
      `task ${canonical} is worked on in ${workspace}, not in ${path.resolve(options.cwd)}`,
      `cd ${workspace} && phronia task commit ${canonical}`,
      { workspace },
    );
  }
  if (!isClean(git, mainRoot)) {
    return failure(
      "INTEGRATE_DIRTY_CHECKOUT",
      "the main checkout has uncommitted changes; refusing to commit a worktree task over them",
      "commit or stash the main checkout changes first",
      { workspace: mainRoot },
    );
  }
  if (!isClean(git, workspace)) {
    // The worktree is dirty by design; this branch only guards a detached or
    // broken checkout below.
  }

  const branch = safeBranch(git, workspace);
  if (branch === "") {
    return failure(
      "COMMIT_WRONG_WORKSPACE",
      `the task worktree ${workspace} has a detached HEAD`,
      "checkout the task branch in that worktree and retry",
      { workspace },
    );
  }

  const dirty = git.status(workspace).dirtyPaths;
  if (dirty === 0) {
    return {
      ok: true,
      taskRef: canonical,
      workspace,
      commit: git.head(workspace),
      committed: false,
      message: "nothing to commit; the task worktree is already clean",
    };
  }

  const taskId = entry.taskId ?? basename(canonical);
  const message =
    options.message?.trim() !== undefined && options.message.trim() !== ""
      ? options.message.trim()
      : `chore(task): ${taskId}`;
  const result = runGit(workspace, ["add", "-A"]);
  if (!result.ok) {
    return failure(
      "GIT_FAILED",
      `git add -A failed in ${workspace}: ${result.detail}`,
      "inspect the worktree and retry",
      { workspace },
    );
  }
  const committed = runGit(workspace, ["commit", "-m", message]);
  if (!committed.ok) {
    return failure(
      "GIT_FAILED",
      `git commit failed in ${workspace}: ${committed.detail}`,
      "fix hooks/identity or commit manually in the task worktree",
      { workspace },
    );
  }
  return {
    ok: true,
    taskRef: canonical,
    workspace,
    commit: safeHead(git, workspace),
    committed: true,
    message: `committed ${canonical} in ${workspace}`,
  };
}

function integrateOne(options: IntegrateOptions): IntegrateResult {
  const taskRef = options.taskRef ?? null;
  if (taskRef === null || taskRef.trim() === "") {
    return failure(
      "TASK_NOT_FOUND",
      "no task reference was provided",
      "pass a task ref: phronia task integrate <ref>",
    );
  }

  let context: IntegrationContext;
  try {
    context = loadContext(taskRef, options);
  } catch (error) {
    if (error instanceof IntegrationInputError) {
      return failure(error.code, error.message, error.next);
    }
    return failure(
      error instanceof GitError ? error.code : "GIT_UNAVAILABLE",
      `cannot resolve the repository and task: ${errorMessage(error)}`,
      "run this command inside the repository and check that the task exists",
    );
  }

  const mode = resolveMode(context, options);
  if (!mode.ok) return mode.failure;

  if (options.recover === true) {
    return recoverIntegration(context, options, mode.resolution);
  }

  if (options.dryRun === true) {
    return dryRunResult(context, options, mode.resolution, mode.mode);
  }

  if (mode.mode === "remote") {
    return runRemote(context, options, mode.resolution, mode.mode);
  }
  return runLocal(context, options, mode.resolution, mode.mode);
}

function loadContext(
  taskRef: string,
  options: IntegrateOptions,
): IntegrationContext {
  const cwd = path.resolve(options.cwd);
  const git = options.git ?? createGitPort();
  const mainRoot = git.mainWorktreeRoot(cwd);
  const resolution = resolveSharedRuntime({ cwd: mainRoot, git });
  if (options.dryRun !== true) {
    ensureSharedRuntime(resolution.paths);
  }
  const state = openState({
    root: mainRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const config = state.config();
  const registryLoad = loadWorktreeRegistry({
    projectRoot: mainRoot,
    paths: resolution.paths,
    git,
    write: false,
  });
  const view = readTaskView(state, registryLoad.registry.worktrees, taskRef);
  if (view === null) {
    throw new IntegrationInputError(
      "TASK_NOT_FOUND",
      `task not found: ${taskRef}`,
      "check the task ref, or create the task in this repository first",
    );
  }
  const requestedRef = canonicalRef(taskRef);
  const entry = registryLoad.registry.worktrees.find(
    (candidate) => canonicalRef(candidate.taskRef) === requestedRef,
  );
  // A worktree task's physical directory lives under
  // `.phronia/worktrees/<id>/.phronia/tasks/...`; deriving the ref from
  // `path.relative(mainRoot, view.dir)` would produce that nested path. Prefer
  // the registry's canonical taskRef (or the view's stored ref).
  const ref =
    entry !== undefined
      ? canonicalRef(entry.taskRef)
      : canonicalRefForView(view, mainRoot);
  const legacyWorktree =
    typeof view.raw.worktree_path === "string" && view.raw.worktree_path !== ""
      ? view.raw.worktree_path
      : null;
  const workspace = path.resolve(entry?.path ?? legacyWorktree ?? mainRoot);
  const taskUsesMain = workspace === path.resolve(mainRoot);
  const taskBranch = taskUsesMain
    ? null
    : (entry?.branch ??
      (typeof view.raw.branch === "string" ? view.raw.branch : null));
  const originUrl = readOriginUrl(mainRoot);
  const forge =
    options.forge ??
    createForgePort({
      cwd: mainRoot,
      originUrl: originUrl ?? null,
    });
  const now = options.now ?? ((): Date => new Date());
  const base = resolveBaseBranch(
    mainRoot,
    view,
    config,
    options.base,
    git,
  );
  if (!base.ok) {
    throw new IntegrationInputError(
      "INTEGRATE_BASE_INVALID",
      base.message,
      "pass --base <branch>, or create the integration branch",
    );
  }

  return {
    cwd,
    mainRoot,
    git,
    paths: resolution.paths,
    config,
    state,
    now,
    host: options.hostname ?? hostname(),
    pid: options.pid ?? process.pid,
    env: options.env ?? process.env,
    registry: registryLoad.registry.worktrees,
    view,
    ref,
    taskId: view.id,
    workspace,
    taskUsesMain,
    taskBranch,
    baseBranch: base.branch,
    originUrl,
    forge,
  };
}

// ---------------------------------------------------------------------------
// Mode resolution and confirmation
// ---------------------------------------------------------------------------

type ModeResult =
  | { readonly ok: true; readonly mode: ResolvedMode; readonly resolution: IntegrationModeResolution }
  | { readonly ok: false; readonly failure: IntegrateFailure };

function resolveMode(
  context: IntegrationContext,
  options: IntegrateOptions,
): ModeResult {
  const integration = readIntegrationMeta(context.view.meta);
  const projectMode =
    context.config.parallel.integration.mode === "auto"
      ? null
      : context.config.parallel.integration.mode;
  const cliMode =
    options.mode === undefined || options.mode === "auto" ? null : options.mode;
  const resolution = resolveIntegrationMode({
    taskMode: integration.mode,
    cliMode,
    projectMode,
    hasOrigin: context.originUrl !== null,
    forgeCliAvailable: safeForgeAvailable(context.forge),
    confirm: context.config.parallel.integration.confirm,
    taskUsesMain: context.taskUsesMain,
  });

  const invalid = resolution.diagnostics.find(
    (item) => item.severity === "error" && item.details?.next !== undefined,
  );
  if (resolution.invalid || invalid !== undefined) {
    const next =
      typeof invalid?.details?.next === "string"
        ? invalid.details.next
        : "use --mode local, or create a worktree for this task first";
    return {
      ok: false,
      failure: withMode(
        failure(
          invalid?.code ?? "INTEGRATE_MODE_INVALID",
          invalid?.message ?? "the requested integration mode is not available",
          next,
        ),
        resolution.mode,
        resolution.reason,
      ),
    };
  }

  const ask = options.interactive === true || (options.yes !== true && resolution.shouldAsk);
  let mode = resolution.mode;
  let reason = resolution.reason;
  if (ask) {
    const choice = options.chooseMode?.({
      resolution,
      taskRef: context.ref,
      baseBranch: context.baseBranch,
      dryRun: options.dryRun === true,
    });
    if (choice === null || choice === undefined) {
      return {
        ok: false,
        failure: withMode(
          failure(
            "INTEGRATE_CANCELLED",
            "no integration mode was chosen",
            "re-run with --mode local|remote, or --yes to accept the resolved mode",
          ),
          resolution.mode,
          resolution.reason,
        ),
      };
    }
    mode = choice;
    reason = `mode=${mode} (selected; ${resolution.reason})`;
    const recorded = recordMode(context, mode, options);
    if (!recorded.ok) return { ok: false, failure: recorded.failure };
  }

  return { ok: true, mode, resolution: { ...resolution, mode, reason } };
}

function recordMode(
  context: IntegrationContext,
  mode: ResolvedMode,
  options: IntegrateOptions,
): { readonly ok: true } | { readonly ok: false; readonly failure: IntegrateFailure } {
  const target = taskRecordDirectory(context);
  if (target === null) {
    return { ok: true };
  }
  const existing = readIntegrationMeta(context.view.meta);
  const written = writeOutcomeRecord(context, target, {
    mode,
    outcome: existing.outcome,
    baseSha: existing.baseSha,
    commit: existing.commit,
    prUrl: existing.prUrl,
    verified: existing.verified,
    lastError: existing.lastError,
    logRef: existing.logRef,
  }, {}, options);
  if (!written.ok) return { ok: false, failure: written.failure };
  const committed = commitTaskJson(context, target);
  if (!committed.ok) {
    return {
      ok: false,
      failure: failure(
        "INTEGRATE_MODE_RECORD_FAILED",
        `recorded mode=${mode} but could not commit task.json: ${committed.detail}`,
        "commit or stash the working tree, then retry",
        { workspace: context.workspace },
      ),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Local flow
// ---------------------------------------------------------------------------

function runLocal(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
): IntegrateResult {
  const precondition = localPreconditions(context, options);
  if (precondition !== null) {
    return withMode(precondition, mode, resolution.reason);
  }

  if (options.wait === true) {
    return waitAndRunLocal(context, options, resolution, mode);
  }
  if (options.queue === true) {
    const attempt = runLocalAttempt(context, options, resolution, mode);
    if (attempt.ok) {
      dequeueCompleted(context, options);
      return attempt;
    }
    if (isBusyCode(attempt.code)) {
      return enqueueWaiting(context, options, mode, resolution.reason);
    }
    dequeueCompleted(context, options);
    return attempt;
  }

  const attempt = runLocalAttempt(context, options, resolution, mode);
  if (attempt.ok || !isBusyCode(attempt.code)) {
    dequeueCompleted(context, options);
  }
  return attempt;
}

function localPreconditions(
  context: IntegrationContext,
  options: IntegrateOptions,
): IntegrateFailure | null {
  const git = context.git;
  if (safeIsBare(git, context.mainRoot)) {
    return failure(
      "GIT_FAILED",
      "cannot integrate from a bare repository",
      "run the command from a normal checkout",
    );
  }
  const mainBranch = safeBranch(git, context.mainRoot);
  if (mainBranch === "") {
    return failure(
      "INTEGRATE_DETACHED_HEAD",
      "the main checkout is on a detached HEAD",
      `git checkout ${context.baseBranch} in ${context.mainRoot}`,
    );
  }
  if (mainBranch !== context.baseBranch) {
    return failure(
      "INTEGRATE_WRONG_BRANCH",
      `the main checkout is on ${mainBranch}, but the integration branch is ${context.baseBranch}`,
      `git -C ${context.mainRoot} checkout ${context.baseBranch}, or pass --base ${mainBranch}`,
    );
  }
  const mainStatus = git.status(context.mainRoot);
  if (!mainStatus.clean) {
    return failure(
      "INTEGRATE_DIRTY_CHECKOUT",
      `the main checkout has ${mainStatus.dirtyPaths} uncommitted path(s)`,
      "commit or stash them in the main checkout, then retry",
      { dirtyPaths: mainStatus.dirtyPaths },
    );
  }

  if (!context.taskUsesMain) {
    if (!fs.existsSync(context.workspace)) {
      return failure(
        "INTEGRATE_WORKTREE_MISSING",
        `the registered task worktree is missing: ${context.workspace}`,
        "re-create it with `phronia task workspace ensure <ref>` or `phronia task worktree add <ref>`",
        { workspace: context.workspace },
      );
    }
    const worktreeBranch = safeBranch(git, context.workspace);
    if (worktreeBranch === "") {
      return failure(
        "INTEGRATE_DETACHED_HEAD",
        `the task worktree ${context.workspace} is on a detached HEAD`,
        "checkout the task branch in that worktree and retry",
        { workspace: context.workspace },
      );
    }
    if (
      context.taskBranch !== null &&
      context.taskBranch !== "" &&
      worktreeBranch !== context.taskBranch
    ) {
      return failure(
        "INTEGRATE_WRONG_BRANCH",
        `the task worktree is on ${worktreeBranch}, expected ${context.taskBranch}`,
        `git -C ${context.workspace} checkout ${context.taskBranch}`,
        { workspace: context.workspace, branch: worktreeBranch },
      );
    }
    const worktreeStatus = git.status(context.workspace);
    if (!worktreeStatus.clean) {
      return failure(
        "INTEGRATE_DIRTY_CHECKOUT",
        `the task worktree has ${worktreeStatus.dirtyPaths} uncommitted path(s)`,
        `cd ${context.workspace} && phronia task commit ${context.ref}`,
        { workspace: context.workspace, dirtyPaths: worktreeStatus.dirtyPaths },
      );
    }
    const artifacts = taskArtifactsCommitted(context, worktreeBranch);
    if (!artifacts) {
      return failure(
        "TASK_ARTIFACTS_UNCOMMITTED",
        `task artifacts for ${context.ref} are not committed on ${worktreeBranch}`,
        `cd ${context.workspace} && phronia task commit ${context.ref}`,
        { workspace: context.workspace, branch: worktreeBranch },
      );
    }
  } else {
    const artifacts = taskArtifactsCommitted(context, context.baseBranch);
    if (!artifacts) {
      return failure(
        "TASK_ARTIFACTS_UNCOMMITTED",
        `task artifacts for ${context.ref} are not committed on ${context.baseBranch}`,
        `commit ${context.ref}/task.json before integrating`,
      );
    }
  }

  if (options.noVerify !== true && verifyCommands(context, options).length === 0) {
    return failure(
      "INTEGRATE_NO_VERIFY",
      "no verification command is configured",
      "configure parallel.integration.verify, pass --verify <cmd>, or explicitly pass --no-verify",
    );
  }
  return null;
}

function waitAndRunLocal(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
): IntegrateResult {
  const timeoutMs = resolveWaitTimeout(context, options);
  if (timeoutMs === null) {
    return withMode(
      failure(
        "CONFIG_INVALID",
        `invalid --timeout value: ${options.timeout ?? ""}`,
        "use a duration such as 30m or 90s",
      ),
      mode,
      resolution.reason,
    );
  }
  const queued = enqueueWaiting(context, options, mode, resolution.reason);
  if (!queued.ok) return queued;
  const deadline = context.now().getTime() + timeoutMs;

  const queue = readQueue(context.paths);
  const position = queuePosition(queue, context.ref);
  if (position !== null && position > 0) {
    // Keep waiting below.
  }

  while (context.now().getTime() <= deadline) {
    const currentQueue = readQueue(context.paths);
    const currentPosition = queuePosition(currentQueue, context.ref);
    if (currentPosition === null || currentPosition === 0) {
      const attempt = runLocalAttempt(context, options, resolution, mode);
      if (attempt.ok || !isBusyCode(attempt.code)) {
        dequeueCompleted(context, options);
        return attempt;
      }
    }
    sleepSync(WAIT_POLL_MS);
  }

  const finalQueue = readQueue(context.paths);
  return withMode(
    failure(
      "INTEGRATE_LOCK_BUSY",
      "timed out waiting for the integration queue/lock",
      "retry with a larger --timeout, or finish the current integrator",
      { queuePosition: queuePosition(finalQueue, context.ref) },
    ),
    mode,
    resolution.reason,
  );
}

function runLocalAttempt(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
): IntegrateResult {
  const lease = acquireIntegratorLease(context, options);
  if (!lease.ok) {
    return withMode(
      failure("LEASE_BUSY", lease.message, lease.next, lease.details),
      mode,
      resolution.reason,
    );
  }

  let claimHandle: LeaseHandle<WorkspaceClaimRecord> | null = null;
  let claimStore: LeaseStore<WorkspaceClaimRecord> | null = null;
  let lockHandle: LeaseHandle<IntegrationLockRecord> | null = null;
  let lockStore: LeaseStore<IntegrationLockRecord> | null = null;
  try {
    const claim = acquireMainClaim(context, options);
    if (!claim.ok) {
      return withMode(claim, mode, resolution.reason);
    }
    claimHandle = claim.handle;
    claimStore = claim.store;

    const baseSha = safeHead(context.git, context.mainRoot);
    if (baseSha === null) {
      return withMode(
        failure("GIT_FAILED", "cannot read the integration branch head", "check the repository state"),
        mode,
        resolution.reason,
      );
    }
    const lock = acquireIntegrationLock(context, options, baseSha);
    if (!lock.ok) {
      return withMode(lock, mode, resolution.reason);
    }
    lockHandle = lock.handle;
    lockStore = lock.store;
    const phase: PhaseState = {
      claim: claimHandle,
      claimStore,
      lock: lockHandle,
      lockStore,
    };
    return executeLocal(context, options, resolution, mode, phase);
  } finally {
    if (lockHandle !== null && lockStore !== null) {
      safeRelease(lockStore, lockHandle);
    }
    if (claimHandle !== null && claimStore !== null) {
      safeRelease(claimStore, claimHandle);
    }
    releaseTaskLease(context.ref, {
      cwd: context.mainRoot,
      ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
      force: true,
    });
  }
}

interface LeaseSuccess {
  readonly ok: true;
  readonly ownerId: string;
}

function acquireIntegratorLease(
  context: IntegrationContext,
  options: IntegrateOptions,
): LeaseSuccess | IntegrateFailure {
  const ownerId = options.ownerId ?? `task:${context.ref}`;
  const acquired = acquireTaskLease(context.ref, {
    cwd: context.mainRoot,
    ownerType: "task",
    ownerId,
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    workspace: context.workspace,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!acquired.ok) {
    return failure(acquired.code, acquired.message, acquired.next, acquired.details);
  }
  return { ok: true, ownerId };
}

type ClaimResult =
  | {
      readonly ok: true;
      readonly handle: LeaseHandle<WorkspaceClaimRecord>;
      readonly store: LeaseStore<WorkspaceClaimRecord>;
    }
  | IntegrateFailure;

function acquireMainClaim(
  context: IntegrationContext,
  options: IntegrateOptions,
): ClaimResult {
  if (context.taskUsesMain && options.queue === true && options.wait !== true) {
    // The task's own main claim is the only claim it can use; a busy main means
    // another task owns it.
  }
  if (safeIsBare(context.git, context.mainRoot)) {
    return failure("GIT_FAILED", "cannot claim a bare repository", "use a normal checkout");
  }
  const store = createLeaseStore<WorkspaceClaimRecord>({
    path: context.paths.workspaceClaim,
    now: context.now,
    host: context.host,
    pid: context.pid,
    defaultTtlSeconds: 7200,
    liveness: "ttl",
    reclaimWhen: () => false,
  });
  const existing = readClaim(context);
  if (existing !== null) {
    const stale = isLeaseStale(existing, context.now(), { liveness: "ttl" });
    const sameSession =
      options.sessionKey !== undefined &&
      existing.sessionKey !== undefined &&
      existing.sessionKey === options.sessionKey;
    const sameTask =
      canonicalRefOrNull(existing.taskRef) === context.ref ||
      existing.ownerRef === `task:${context.ref}` ||
      existing.ownerRef === (options.ownerId ?? `task:${context.ref}`) ||
      (existing.taskRef === null && sameSession);
    if (!stale) {
      if (sameTask) {
        const handle: LeaseHandle<WorkspaceClaimRecord> = {
          path: store.path,
          record: existing,
        };
        try {
          store.heartbeat(handle, { state: "integrating" });
          return { ok: true, handle, store };
        } catch {
          return failure(
            "WORKSPACE_CLAIM_BUSY",
            `lost the main checkout claim while refreshing it (${describeClaim(existing)})`,
            "retry the integration; another process may have reclaimed the checkout",
            { owner: claimDetails(existing) },
          );
        }
      }
      return failure(
        "WORKSPACE_CLAIM_BUSY",
        `the main checkout is owned by ${describeClaim(existing)}`,
        "wait for the owner (`--wait`), finish that task, or use --mode remote",
        { owner: claimDetails(existing) },
      );
    }

    const dirty = !isClean(context.git, context.mainRoot);
    if (dirty) {
      return failure(
        "WORKSPACE_CLAIM_STALE_DIRTY",
        `the stale claim from ${describeClaim(existing)} left uncommitted changes; never reclaim automatically`,
        "ask the previous owner to commit/stash, or run `phronia task workspace reclaim` explicitly",
        { owner: claimDetails(existing) },
      );
    }
    const ownerStatus = taskStatus(context.state, existing.taskRef);
    const ownerActive = ownerStatus !== null && ACTIVE_TASK_STATUSES.has(ownerStatus);
    if (ownerActive && !sameTask && options.force !== true) {
      return failure(
        "WORKSPACE_CLAIM_STALE_OWNED",
        `the stale claim belongs to ${describeClaim(existing)}, whose task is still ${ownerStatus ?? "active"}`,
        "use `phronia task workspace reclaim` explicitly, or wait for the owner",
        { owner: claimDetails(existing) },
      );
    }
    const reclaimed = tryAcquireClaim(context, store, options, true);
    if (!reclaimed.ok) return reclaimed;
    return reclaimed;
  }

  return tryAcquireClaim(context, store, options, false);
}

function tryAcquireClaim(
  context: IntegrationContext,
  store: LeaseStore<WorkspaceClaimRecord>,
  options: IntegrateOptions,
  reclaim: boolean,
): ClaimResult {
  const ownerId = options.ownerId ?? `task:${context.ref}`;
  const nowIso = context.now().toISOString();
  const record: WorkspaceClaimRecord = {
    schemaVersion: 1,
    ownerType: "task",
    ownerRef: ownerId,
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    taskRef: context.ref,
    workspace: context.mainRoot,
    branch: context.baseBranch,
    host: context.host,
    pid: context.pid,
    state: "integrating",
    acquiredAt: nowIso,
    heartbeatAt: nowIso,
    ttlSeconds: 7200,
  };
  const acquireStore = reclaim
    ? createLeaseStore<WorkspaceClaimRecord>({
        path: context.paths.workspaceClaim,
        now: context.now,
        host: context.host,
        pid: context.pid,
        defaultTtlSeconds: 7200,
        liveness: "ttl",
        reclaimWhen: (candidate, at) =>
          isLeaseStale(candidate, at, { liveness: "ttl" }),
      })
    : store;
  try {
    const acquired = acquireStore.acquire(record);
    if (isLeaseBusy(acquired)) {
      return failure(
        "WORKSPACE_CLAIM_BUSY",
        `the main checkout is owned by ${describeClaim(acquired.busy)}`,
        "wait for the owner (`--wait`), finish that task, or use --mode remote",
        { owner: claimDetails(acquired.busy) },
      );
    }
    return { ok: true, handle: acquired, store: acquireStore };
  } catch (error) {
    return failure(
      "WORKSPACE_CLAIM_BUSY",
      `cannot claim the main checkout: ${errorMessage(error)}`,
      "inspect the shared runtime permissions and retry",
    );
  }
}

type LockResult =
  | {
      readonly ok: true;
      readonly handle: LeaseHandle<IntegrationLockRecord>;
      readonly store: LeaseStore<IntegrationLockRecord>;
    }
  | IntegrateFailure;

function acquireIntegrationLock(
  context: IntegrationContext,
  options: IntegrateOptions,
  preLandSha: string,
): LockResult {
  const ttl = lockTtlSeconds(context, options);
  const store = createLeaseStore<IntegrationLockRecord>({
    path: context.paths.integrationLock,
    now: context.now,
    host: context.host,
    pid: context.pid,
    defaultTtlSeconds: ttl,
    liveness: "ttl",
  });
  const nowIso = context.now().toISOString();
  const record: IntegrationLockRecord = {
    schemaVersion: 1,
    owner: context.ref,
    taskRef: context.ref,
    host: context.host,
    pid: context.pid,
    phase: "acquiring",
    baseBranch: context.baseBranch,
    preLandSha,
    postLandSha: null,
    acquiredAt: nowIso,
    heartbeatAt: nowIso,
    ttlSeconds: ttl,
  };
  try {
    const acquired = store.acquire(record);
    if (isLeaseBusy(acquired)) {
      return failure(
        "INTEGRATE_LOCK_BUSY",
        `another integration is in progress: ${String(acquired.busy.owner ?? acquired.busy.taskRef ?? "unknown")} (${String(acquired.busy.phase ?? "acquiring")})`,
        "use --queue, --wait, or retry after the current integration finishes",
        {
          owner: acquired.busy.owner ?? null,
          phase: acquired.busy.phase ?? null,
          baseBranch: acquired.busy.baseBranch ?? null,
          preLandSha: acquired.busy.preLandSha ?? null,
        },
      );
    }
    return { ok: true, handle: acquired, store };
  } catch (error) {
    if (error instanceof LeaseError) {
      return failure(error.code, error.message, "inspect the shared runtime and retry");
    }
    return failure(
      "INTEGRATE_LOCK_BUSY",
      `cannot acquire the integration lock: ${errorMessage(error)}`,
      "inspect the shared runtime permissions and retry",
    );
  }
}

function executeLocal(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
  phase: PhaseState,
): IntegrateResult {
  const maxAttempts = Math.max(1, context.config.parallel.integration.maxAttempts);
  const verify = planVerification(context, options);
  if (!verify.ok) return withMode(verify.failure, mode, resolution.reason);

  const runWarnings: string[] = [];
  if (context.originUrl !== null) {
    const fetched = context.git.fetch(
      context.mainRoot,
      "origin",
      context.baseBranch,
    );
    if (!fetched.ok) {
      runWarnings.push(
        `git fetch origin ${context.baseBranch} failed (offline or unreachable); integrating against the local base: ${fetched.detail ?? "unknown error"}`,
      );
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const preLandSha = safeHead(context.git, context.mainRoot);
    if (preLandSha === null) {
      return withMode(
        failure("GIT_FAILED", "cannot read the integration branch head", "check the repository state"),
        mode,
        resolution.reason,
      );
    }
    heartbeatLock(phase, { phase: "rebasing", preLandSha, postLandSha: null });

    if (!context.taskUsesMain) {
      const rebase = rebaseTaskWorktree(context, phase);
      if (!rebase.ok) {
        if (rebase.classification === null) {
          return withMode(
            failure(
              "INTEGRATE_CONFLICT",
              "the rebase failed without a conflict classification",
              "inspect the task worktree and retry",
            ),
            mode,
            resolution.reason,
          );
        }
        const resolved = handleRebaseConflict(
          context,
          options,
          resolution,
          mode,
          phase,
          rebase.classification,
          preLandSha,
        );
        if (resolved === null) {
          // Generated files were regenerated; fall through to verification.
        } else {
          return resolved;
        }
      }
    }

    heartbeatLock(phase, { phase: "verifying" });
    const verified = runVerification(context, options);
    if (!verified.ok) {
      const classification = classifyConflict({
        conflictFiles: [],
        verificationFailed: true,
        generatedPatterns: context.config.parallel.conflicts.generated,
        alwaysSerialPatterns: context.config.parallel.conflicts.alwaysSerial,
        footprint: taskFootprint(context),
        mechanicalMaxFiles: context.config.parallel.conflicts.mechanicalMaxFiles,
        regenerateConfigured:
          context.config.parallel.conflicts.regenerate.length > 0,
      });
      const outcome = outcomeForConflict("semantic", {
        handoff: options.handoff === true,
      });
      const logRef = relativeTo(context.mainRoot, verified.logPath);
      const written = writeOutcome(context, {
        mode,
        outcome,
        baseSha: preLandSha,
        commit: safeHead(context.git, context.workspace) ?? null,
        prUrl: null,
        verified: false,
        lastError: `verification failed: ${verified.command ?? "unknown command"}`,
        logRef,
      }, options);
      const handoffPath =
        options.handoff === true
          ? writeHandoff(context, {
              mode,
              outcome,
              classification,
              baseSha: preLandSha,
              taskHead: safeHead(context.git, context.workspace) ?? null,
              verification: verified,
              workspace: context.workspace,
            })
          : null;
      return withMode(
        failure(
          "INTEGRATE_VERIFY_FAILED",
          `verification failed after a clean rebase: ${verified.command ?? "unknown command"}`,
          `inspect ${verified.logPath ?? "the verification log"}, fix the task, then retry`,
          {
            command: verified.command,
            exitCode: verified.exitCode,
            outputTail: verified.outputTail,
            metaWritten: written.ok,
            outcome,
          },
          {
            outcome,
            conflict: classification,
            logPath: verified.logPath,
            baseSha: preLandSha,
            handoffPath,
          },
        ),
        mode,
        resolution.reason,
      );
    }

    heartbeatLock(phase, { phase: "merging" });
    const currentBase = safeHead(context.git, context.mainRoot);
    if (currentBase !== preLandSha) {
      if (attempt < maxAttempts) continue;
      return finishRace(context, options, mode, resolution, preLandSha);
    }

    let commit = safeHead(context.git, context.workspace) ?? currentBase;
    if (!context.taskUsesMain) {
      if (context.taskBranch === null || context.taskBranch === "") {
        return withMode(
          failure(
            "INTEGRATE_WRONG_BRANCH",
            "the task worktree has no branch to fast-forward",
            "checkout the task branch in the worktree and retry",
          ),
          mode,
          resolution.reason,
        );
      }
      const branchHead = safeHead(context.git, context.workspace);
      if (branchHead !== null) commit = branchHead;
      const merged = context.git.mergeFf(context.mainRoot, context.taskBranch);
      if (!merged.ok) {
        const moved = safeHead(context.git, context.mainRoot) !== preLandSha;
        if (moved && attempt < maxAttempts) continue;
        if (moved) return finishRace(context, options, mode, resolution, preLandSha);
        const classification = classifyConflict({
          conflictFiles: [],
          baseMoved: false,
          generatedPatterns: context.config.parallel.conflicts.generated,
          alwaysSerialPatterns: context.config.parallel.conflicts.alwaysSerial,
          footprint: taskFootprint(context),
          mechanicalMaxFiles: context.config.parallel.conflicts.mechanicalMaxFiles,
        });
        const outcome = outcomeForConflict(classification.kind);
        const written = writeOutcome(context, {
          mode,
          outcome,
          baseSha: preLandSha,
          commit,
          prUrl: null,
          verified: verify.verified,
          lastError: merged.detail ?? "fast-forward failed",
          logRef: relativeTo(context.mainRoot, verified.logPath),
        }, options);
        return withMode(
          failure(
            "INTEGRATE_CONFLICT",
            `fast-forward failed: ${merged.detail ?? "unknown error"}`,
            "resolve the divergence in the task worktree, then retry",
            { metaWritten: written.ok, outcome },
            { outcome, conflict: classification, logPath: verified.logPath },
          ),
          mode,
          resolution.reason,
        );
      }
    }

    const postLandSha = safeHead(context.git, context.mainRoot);
    heartbeatLock(phase, { phase: "done", postLandSha });
    const written = writeOutcome(context, {
      mode,
      outcome: "landed",
      baseSha: preLandSha,
      commit,
      prUrl: null,
      verified: verify.verified,
      lastError: null,
      logRef: relativeTo(context.mainRoot, verified.logPath),
    }, options, landedTaskDirectory(context));
    if (!written.ok) {
      return withMode(
        failure(
          "INTEGRATE_OUTCOME_WRITE_FAILED",
          written.failure.message,
          written.failure.next,
          { baseSha: preLandSha, commit },
          { outcome: "landed", baseSha: preLandSha, commit },
        ),
        mode,
        resolution.reason,
      );
    }
    const bookkeeping = context.git.status(context.mainRoot);
    let warnings: readonly string[] | undefined;
    if (!bookkeeping.clean) {
      // Metadata written into the landed task record. Commit only that file so
      // the main checkout stays clean; verification already covered the code.
      const metaCommit = commitTaskJson(
        context,
        path.join(context.mainRoot, context.ref),
      );
      if (metaCommit.ok) {
        const finalSha = safeHead(context.git, context.mainRoot);
        if (finalSha !== null) {
          heartbeatLock(phase, { phase: "done", postLandSha: finalSha });
        }
      } else {
        warnings = [
          `landed, but the integration metadata was left uncommitted: ${metaCommit.detail}`,
        ];
      }
    }

    writeLastResult(context, {
      outcome: "landed",
      commit,
      at: context.now().toISOString(),
    });
    return {
      ok: true,
      mode,
      modeReason: resolution.reason,
      outcome: "landed",
      baseSha: preLandSha,
      commit,
      prUrl: null,
      conflict: null,
      logPath: verified.logPath,
      next: null,
      taskRef: context.ref,
      baseBranch: context.baseBranch,
      branch: context.taskBranch,
      workspace: context.workspace,
      ...(runWarnings.length === 0 && warnings === undefined
        ? {}
        : { warnings: [...runWarnings, ...(warnings ?? [])] }),
    };
  }

  return withMode(
    failure(
      "INTEGRATE_BASE_MOVED",
      "the integration branch kept moving; gave up after the configured attempts",
      "retry the integration, or queue it",
    ),
    mode,
    resolution.reason,
  );
}

interface RebaseOutcome {
  readonly ok: boolean;
  readonly classification: ConflictClassification | null;
  readonly outputTail: string;
}

function rebaseTaskWorktree(
  context: IntegrationContext,
  phase: PhaseState,
): RebaseOutcome {
  abortInProgressRebase(context);
  heartbeatLock(phase, { phase: "rebasing" });
  const result = context.git.rebase(context.workspace, context.baseBranch);
  if (result.ok) {
    return { ok: true, classification: null, outputTail: "" };
  }
  const addAdd = readAddAddFiles(context.workspace, result.conflicts);
  const classification = classifyConflict({
    conflictFiles: result.conflicts,
    addAddFiles: addAdd,
    generatedPatterns: context.config.parallel.conflicts.generated,
    alwaysSerialPatterns: context.config.parallel.conflicts.alwaysSerial,
    footprint: taskFootprint(context),
    mechanicalMaxFiles: context.config.parallel.conflicts.mechanicalMaxFiles,
    regenerateConfigured: context.config.parallel.conflicts.regenerate.length > 0,
  });
  context.git.rebaseAbort(context.workspace);
  return {
    ok: false,
    classification,
    outputTail: tail(result.detail ?? ""),
  };
}

/**
 * Handle a rebase conflict. Returns null when a generated conflict was
 * regenerated and the caller should retry the rebase; otherwise returns the
 * terminal result.
 */
function handleRebaseConflict(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
  phase: PhaseState,
  classification: ConflictClassification,
  preLandSha: string,
): IntegrateResult | null {
  const regenerate = context.config.parallel.conflicts.regenerate;
  if (classification.kind === "generated" && regenerate.length > 0) {
    const regenerated = runCommandsIn(context.workspace, regenerate, context, options);
    if (regenerated.ok) {
      commitAllIfDirty(
        context.workspace,
        `chore(task): regenerate artifacts for ${context.taskId}`,
      );
      const retry = context.git.rebase(context.workspace, context.baseBranch);
      if (retry.ok) {
        heartbeatLock(phase, { phase: "rebasing" });
        return null;
      }
      const addAdd = readAddAddFiles(context.workspace, retry.conflicts);
      const again = classifyConflict({
        conflictFiles: retry.conflicts,
        addAddFiles: addAdd,
        generatedPatterns: context.config.parallel.conflicts.generated,
        alwaysSerialPatterns: context.config.parallel.conflicts.alwaysSerial,
        footprint: taskFootprint(context),
        mechanicalMaxFiles: context.config.parallel.conflicts.mechanicalMaxFiles,
      });
      context.git.rebaseAbort(context.workspace);
      return finishConflict(context, options, resolution, mode, again, preLandSha, {
        outcome: "needs_human",
        verification: null,
      });
    }
  }

  const outcome = outcomeForConflict(classification.kind, {
    handoff: options.handoff === true,
  });
  return finishConflict(context, options, resolution, mode, classification, preLandSha, {
    outcome,
    verification: null,
  });
}

function finishConflict(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
  classification: ConflictClassification,
  preLandSha: string,
  details: {
    readonly outcome: IntegrationOutcome;
    readonly verification: VerifyOutcome | null;
  },
): IntegrateResult {
  const taskHead = safeHead(context.git, context.workspace);
  const logPath = details.verification?.logPath ?? null;
  const written = writeOutcome(context, {
    mode,
    outcome: details.outcome,
    baseSha: preLandSha,
    commit: taskHead,
    prUrl: null,
    verified: false,
    lastError: classification.reason,
    logRef: relativeTo(context.mainRoot, logPath),
  }, options);
  const handoffPath =
    options.handoff === true
      ? writeHandoff(context, {
          mode,
          outcome: details.outcome,
          classification,
          baseSha: preLandSha,
          taskHead,
          verification: details.verification,
          workspace: context.workspace,
        })
      : null;
  return withMode(
    failure(
      "INTEGRATE_CONFLICT",
      `rebase conflict: ${classification.reason}`,
      classification.next,
      {
        kind: classification.kind,
        files: classification.files,
        reason: classification.reason,
        metaWritten: written.ok,
        handoffPath,
      },
      {
        outcome: details.outcome,
        conflict: classification,
        logPath,
        baseSha: preLandSha,
        commit: taskHead,
        handoffPath,
      },
    ),
    mode,
    resolution.reason,
  );
}

function finishRace(
  context: IntegrationContext,
  options: IntegrateOptions,
  mode: ResolvedMode,
  resolution: IntegrationModeResolution,
  preLandSha: string,
): IntegrateResult {
  const classification = classifyConflict({
    conflictFiles: [],
    baseMoved: true,
    generatedPatterns: context.config.parallel.conflicts.generated,
    alwaysSerialPatterns: context.config.parallel.conflicts.alwaysSerial,
    footprint: taskFootprint(context),
    mechanicalMaxFiles: context.config.parallel.conflicts.mechanicalMaxFiles,
  });
  const written = writeOutcome(context, {
    mode,
    outcome: "blocked",
    baseSha: preLandSha,
    commit: safeHead(context.git, context.workspace),
    prUrl: null,
    verified: false,
    lastError: classification.reason,
    logRef: null,
  }, options);
  return withMode(
    failure(
      "INTEGRATE_BASE_MOVED",
      "the integration branch moved while landing and retries were exhausted",
      "retry `phronia task integrate <ref>`, or queue it with --queue",
      { metaWritten: written.ok },
      { outcome: "blocked", conflict: classification, baseSha: preLandSha },
    ),
    mode,
    resolution.reason,
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface VerificationPlan {
  readonly ok: true;
  readonly commands: readonly string[];
  readonly verified: boolean;
  readonly timeoutMs: number;
}

type VerificationPlanResult =
  | VerificationPlan
  | { readonly ok: false; readonly failure: IntegrateFailure };

function planVerification(
  context: IntegrationContext,
  options: IntegrateOptions,
): VerificationPlanResult {
  const commands = verifyCommands(context, options);
  const timeoutMs = resolveVerifyTimeout(context, options);
  if (timeoutMs === null) {
    return {
      ok: false,
      failure: failure(
        "CONFIG_INVALID",
        `invalid verification timeout: ${options.timeout ?? context.config.parallel.integration.timeout}`,
        "use a duration such as 30m or 90s",
      ),
    };
  }
  if (options.noVerify === true) {
    return { ok: true, commands: [], verified: false, timeoutMs };
  }
  return { ok: true, commands, verified: commands.length > 0, timeoutMs };
}

function verifyCommands(
  context: IntegrationContext,
  options: IntegrateOptions,
): readonly string[] {
  if (options.noVerify === true) return [];
  const explicit = options.verify ?? [];
  if (explicit.length > 0) return explicit;
  return context.config.parallel.integration.verify;
}

function runVerification(
  context: IntegrationContext,
  options: IntegrateOptions,
): VerifyOutcome {
  const plan = planVerification(context, options);
  if (!plan.ok) {
    return {
      ok: false,
      command: null,
      exitCode: null,
      outputTail: plan.failure.message,
      logText: "",
      logPath: null,
    };
  }
  const cwd = context.taskUsesMain ? context.mainRoot : context.workspace;
  const logPath = verificationLogPath(context);
  const chunks: string[] = [];
  chunks.push(
    `# integration verification\n# task: ${context.ref}\n# cwd: ${cwd}\n# base: ${context.baseBranch}\n`,
  );

  if (plan.commands.length === 0) {
    chunks.push("# no verification commands (explicit --no-verify)\n");
    writeLog(logPath, chunks.join(""));
    return {
      ok: true,
      command: null,
      exitCode: null,
      outputTail: "",
      logText: chunks.join(""),
      logPath,
    };
  }

  for (const command of plan.commands) {
    const argv = tokenize(command);
    if (argv.length === 0) continue;
    chunks.push(`$ ${command}\n`);
    const started = Date.now();
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: plan.timeoutMs,
      maxBuffer: MAX_LOG_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...context.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const exitCode = typeof result.status === "number" ? result.status : 1;
    const output = `${bufferText(result.stdout)}${bufferText(result.stderr)}`;
    chunks.push(output);
    if (output.trim() === "" && result.error !== undefined && result.error !== null) {
      chunks.push(`${result.error.message}\n`);
    }
    const duration = Date.now() - started;
    chunks.push(`\n# exit ${String(exitCode)} in ${duration}ms\n`);
    writeLog(logPath, chunks.join(""));
    if (exitCode !== 0) {
      return {
        ok: false,
        command,
        exitCode,
        outputTail: tail(redact(output)),
        logText: chunks.join(""),
        logPath,
      };
    }
  }

  const logText = chunks.join("");
  writeLog(logPath, logText);
  return {
    ok: true,
    command: null,
    exitCode: 0,
    outputTail: tail(redact(logText)),
    logText,
    logPath,
  };
}

function verificationLogPath(context: IntegrationContext): string {
  const stamp = context.now().toISOString().replace(/[:.]/g, "-");
  return path.join(
    context.mainRoot,
    ".phronia",
    ".runtime",
    "integration-logs",
    `${context.taskId}-${stamp}.log`,
  );
}

function writeLog(target: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, capLog(redact(content)), "utf8");
  } catch {
    // A missing log must not mask the real integration result.
  }
}

function capLog(content: string): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= MAX_LOG_BYTES) return content;
  const tailBuffer = buffer.subarray(buffer.length - MAX_LOG_BYTES);
  return `# log truncated; keeping the tail\n${tailBuffer.toString("utf8")}`;
}

// ---------------------------------------------------------------------------
// Remote flow
// ---------------------------------------------------------------------------

function runRemote(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
): IntegrateResult {
  if (context.originUrl === null) {
    return withMode(
      failure(
        "INTEGRATE_REMOTE_UNAVAILABLE",
        "remote integration needs an origin remote",
        "use --mode local, or add an origin remote",
      ),
      mode,
      resolution.reason,
    );
  }
  if (context.taskUsesMain) {
    return withMode(
      failure(
        "INTEGRATE_MODE_INVALID",
        "a task using the main checkout has no independent branch to push",
        "use --mode local, or move the task to a worktree first",
      ),
      mode,
      resolution.reason,
    );
  }
  if (context.taskBranch === null || context.taskBranch === "") {
    return withMode(
      failure(
        "INTEGRATE_WRONG_BRANCH",
        "the task worktree has no branch to push",
        "checkout the task branch in the worktree and retry",
      ),
      mode,
      resolution.reason,
    );
  }
  if (!fs.existsSync(context.workspace)) {
    return withMode(
      failure(
        "INTEGRATE_WORKTREE_MISSING",
        `the registered task worktree is missing: ${context.workspace}`,
        "re-create it with `phronia task workspace ensure <ref>`",
      ),
      mode,
      resolution.reason,
    );
  }
  const status = context.git.status(context.workspace);
  if (!status.clean) {
    return withMode(
      failure(
        "INTEGRATE_DIRTY_CHECKOUT",
        `the task worktree has ${status.dirtyPaths} uncommitted path(s); remote mode only pushes committed work`,
        `cd ${context.workspace} && phronia task commit ${context.ref}`,
        { dirtyPaths: status.dirtyPaths },
      ),
      mode,
      resolution.reason,
    );
  }

  const lease = acquireIntegratorLease(context, options);
  if (!lease.ok) {
    return withMode(
      failure("LEASE_BUSY", lease.message, lease.next, lease.details),
      mode,
      resolution.reason,
    );
  }
  try {
    const pushed = context.git.push(
      context.workspace,
      "origin",
      context.taskBranch,
    );
    if (!pushed.ok) {
      return withMode(
        failure(
          "INTEGRATE_PUSH_FAILED",
          `git push failed: ${pushed.detail ?? "unknown error"}`,
          "resolve the push error (auth/divergence), then retry",
          { branch: context.taskBranch },
        ),
        mode,
        resolution.reason,
      );
    }

    const branchHead = safeHead(context.git, context.workspace);
    const baseSha = safeHead(context.git, context.mainRoot);
    const forgeAvailable = safeForgeAvailable(context.forge);
    const existing = forgeAvailable
      ? context.forge.viewChangeRequest(context.taskBranch)
      : null;
    const created =
      existing?.url !== null && existing?.url !== undefined
        ? { url: existing.url }
        : forgeAvailable
          ? context.forge.createChangeRequest({
              branch: context.taskBranch,
              base: context.baseBranch,
              title: context.view.title,
              body: `Task: ${context.view.title} (${context.ref})`,
            })
          : null;
    const prUrl = created?.url ?? null;
    const compareUrl =
      prUrl === null
        ? context.forge.compareUrl({
            base: context.baseBranch,
            head: context.taskBranch,
          })
        : null;
    const manualCommand =
      prUrl === null
        ? context.forge.kind === "gitlab"
          ? `git push -u origin ${context.taskBranch} && glab mr create --source-branch ${context.taskBranch} --target-branch ${context.baseBranch} --title "${context.view.title}"`
          : `git push -u origin ${context.taskBranch} && gh pr create --base ${context.baseBranch} --head ${context.taskBranch} --title "${context.view.title}"`
        : null;

    if (options.sync === true) {
      return syncRemote(context, options, resolution, mode, {
        baseSha,
        branchHead,
        prUrl,
      });
    }

    const written = writeOutcome(context, {
      mode,
      outcome: "pushed",
      baseSha,
      commit: branchHead,
      prUrl,
      verified: false,
      lastError: null,
      logRef: null,
    }, options);
    let warnings: readonly string[] = [];
    if (written.ok && prUrl !== null) {
      const recordDir = taskRecordDirectory(context);
      const committed =
        recordDir === null
          ? { ok: true as const }
          : commitTaskJson(context, recordDir);
      if (committed.ok) {
        const secondPush = context.git.push(
          context.workspace,
          "origin",
          context.taskBranch,
        );
        if (!secondPush.ok) {
          warnings = [
            `PR created, but pushing the recorded pr_url failed: ${secondPush.detail ?? "unknown error"}`,
          ];
        }
      } else {
        warnings = [
          `PR created, but the task record update could not be committed: ${committed.detail}`,
        ];
      }
    }
    writeLastResult(context, {
      outcome: "pushed",
      commit: branchHead,
      at: context.now().toISOString(),
    });
    return {
      ok: true,
      mode,
      modeReason: resolution.reason,
      outcome: "pushed",
      baseSha,
      commit: branchHead,
      prUrl,
      conflict: null,
      logPath: null,
      next:
        prUrl === null
          ? "open the change request with the compare URL or the printed command; Phronia will not merge"
          : "wait for the remote merge queue; run `phronia task integrate <ref> --mode remote --sync` to refresh the outcome",
      taskRef: context.ref,
      baseBranch: context.baseBranch,
      branch: context.taskBranch,
      workspace: context.workspace,
      compareUrl,
      manualCommand,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  } finally {
    releaseTaskLease(context.ref, {
      cwd: context.mainRoot,
      ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
      force: true,
    });
  }
}

function syncRemote(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
  state: {
    readonly baseSha: string | null;
    readonly branchHead: string | null;
    readonly prUrl: string | null;
  },
): IntegrateResult {
  const fetched = context.git.fetch(context.mainRoot, "origin", context.baseBranch);
  const remoteBase = `origin/${context.baseBranch}`;
  let ancestor = false;
  if (state.branchHead !== null) {
    try {
      ancestor = context.git.isAncestor(
        context.mainRoot,
        state.branchHead,
        remoteBase,
      );
    } catch {
      ancestor = false;
    }
  }

  const view = safeForgeAvailable(context.forge)
    ? context.forge.viewChangeRequest(context.taskBranch ?? "")
    : null;
  const syncState =
    view === null
      ? "unknown"
      : view.state === "merged"
        ? "merged"
        : view.state === "closed"
          ? "closed"
          : view.mergeState !== null &&
              /conflict|dirty|blocked/i.test(view.mergeState)
            ? "conflicting"
            : "open";

  let outcome: IntegrationOutcome = "pushed";
  if (ancestor || syncState === "merged") {
    outcome = "landed";
  } else if (syncState === "closed") {
    outcome = "needs_human";
  } else if (syncState === "conflicting" || syncState === "open") {
    outcome = "blocked";
  }

  const written = writeOutcome(context, {
    mode,
    outcome,
    baseSha: state.baseSha,
    commit: state.branchHead,
    prUrl: state.prUrl ?? view?.url ?? null,
    verified: outcome === "landed",
    lastError:
      outcome === "needs_human"
        ? "the remote change request was closed without merging"
        : outcome === "blocked"
          ? "the remote change request is still open or has conflicts"
          : null,
    logRef: null,
  }, options);

  void fetched;
  return {
    ok: true,
    mode,
    modeReason: resolution.reason,
    outcome,
    baseSha: state.baseSha,
    commit: state.branchHead,
    prUrl: state.prUrl ?? view?.url ?? null,
    conflict: null,
    logPath: null,
    next:
      outcome === "landed"
        ? null
        : outcome === "needs_human"
          ? "decide whether to reopen/repair the change request"
          : "wait for the remote merge queue, then run --sync again",
    taskRef: context.ref,
    baseBranch: context.baseBranch,
    branch: context.taskBranch,
    workspace: context.workspace,
    sync: syncState,
    ...(written.ok ? {} : { warnings: ["the task record could not be updated"] }),
  };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function enqueueWaiting(
  context: IntegrationContext,
  options: IntegrateOptions,
  mode: ResolvedMode,
  reason: string,
): IntegrateResult {
  const queue = readQueue(context.paths);
  const entry: QueueEntry = {
    taskRef: context.ref,
    enqueuedAt: context.now().toISOString(),
    mode,
    baseBranch: context.baseBranch,
  };
  const result = enqueueTask(queue, entry);
  writeQueue(context.paths, result.queue);
  return {
    ok: true,
    mode,
    modeReason: `${reason}; queued at position ${String(
      queuePosition(result.queue, context.ref) ?? 0,
    )}`,
    outcome: "none",
    baseSha: null,
    commit: null,
    prUrl: null,
    conflict: null,
    logPath: null,
    next: "run `phronia task integrate --drain`, or `phronia task integrate <ref> --wait`",
    taskRef: context.ref,
    baseBranch: context.baseBranch,
    branch: context.taskBranch,
    workspace: context.workspace,
    queued: true,
    queuePosition: queuePosition(result.queue, context.ref),
  };
}

function dequeueCompleted(
  context: IntegrationContext,
  options: IntegrateOptions,
): void {
  void options;
  const queue = readQueue(context.paths);
  if (!queue.some((entry) => entry.taskRef === context.ref)) return;
  const result = dequeueTask(queue, context.ref);
  writeQueue(context.paths, result.queue);
}

function drainQueue(options: IntegrateOptions): IntegrateResult {
  const taskRef = options.taskRef ?? null;
  let baseContext: IntegrationContext | null = null;
  try {
    const probeRef = taskRef ?? firstTaskRef(options);
    if (probeRef === null) {
      return {
        ok: true,
        mode: null,
        modeReason: null,
        outcome: "none",
        baseSha: null,
        commit: null,
        prUrl: null,
        conflict: null,
        logPath: null,
        next: "nothing queued",
        taskRef: null,
        baseBranch: null,
        branch: null,
        workspace: null,
        results: [],
      };
    }
    baseContext = loadContext(probeRef, options);
  } catch (error) {
    return failure(
      "GIT_UNAVAILABLE",
      `cannot resolve the repository for --drain: ${errorMessage(error)}`,
      "run this command inside the repository",
    );
  }

  if (taskRef !== null) {
    const current = readQueue(baseContext.paths);
    if (!current.some((entry) => entry.taskRef === canonicalRef(taskRef))) {
      const entry: QueueEntry = {
        taskRef: canonicalRef(taskRef),
        enqueuedAt: baseContext.now().toISOString(),
        mode: options.mode ?? "auto",
        baseBranch: baseContext.baseBranch,
      };
      writeQueue(baseContext.paths, enqueueTask(current, entry).queue);
    }
  }

  const results: DrainItemResult[] = [];
  let last: IntegrateSuccess | null = null;
  for (;;) {
    const queue = readQueue(baseContext.paths);
    const head = peekQueue(queue);
    if (head === null) break;
    const result = integrateOne({
      ...options,
      taskRef: head.taskRef,
      drain: false,
      wait: false,
      queue: false,
      fromDrain: true,
    });
    const busy =
      !result.ok &&
      (result.code === "INTEGRATE_LOCK_BUSY" ||
        result.code === "WORKSPACE_CLAIM_BUSY" ||
        result.code === "LEASE_BUSY");
    if (!busy) {
      const after = readQueue(baseContext.paths);
      writeQueue(baseContext.paths, dequeueTask(after, head.taskRef).queue);
    }
    results.push({
      taskRef: head.taskRef,
      ok: result.ok,
      mode: result.mode ?? null,
      outcome: result.outcome ?? null,
      ...(result.ok ? {} : { code: result.code, message: result.message }),
    });
    if (result.ok) last = result;
    if (busy) {
      break;
    }
  }

  const failed = results.filter((item) => !item.ok).length;
  return {
    ok: true,
    mode: last?.mode ?? null,
    modeReason: last?.modeReason ?? null,
    outcome: last?.outcome ?? "none",
    baseSha: last?.baseSha ?? null,
    commit: last?.commit ?? null,
    prUrl: last?.prUrl ?? null,
    conflict: null,
    logPath: null,
    next: failed === 0 ? "queue drained" : `${failed} queued task(s) were blocked; inspect the results`,
    taskRef: null,
    baseBranch: last?.baseBranch ?? null,
    branch: null,
    workspace: null,
    results,
    ...(failed === 0 ? {} : { warnings: [`${failed} task(s) failed`] }),
  };
}

function firstTaskRef(options: IntegrateOptions): string | null {
  try {
    const git = options.git ?? createGitPort();
    const mainRoot = git.mainWorktreeRoot(path.resolve(options.cwd));
    const resolution = resolveSharedRuntime({ cwd: mainRoot, git });
    const queue = readQueue(resolution.paths);
    return peekQueue(queue)?.taskRef ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function recoverIntegration(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
): IntegrateResult {
  const store = createLeaseStore<IntegrationLockRecord>({
    path: context.paths.integrationLock,
    now: context.now,
    host: context.host,
    pid: context.pid,
    defaultTtlSeconds: DEFAULT_LOCK_TTL_SECONDS,
    liveness: "ttl",
  });
  const lock = store.read();
  if (lock === null) {
    return recoverWithoutLock(context, options, resolution);
  }
  const stale = isLeaseStale(lock, context.now(), { liveness: "ttl" });
  if (!stale) {
    return withMode(
      failure(
        "INTEGRATE_LOCK_BUSY",
        `the integration lock is still live (${String(lock.owner)} / ${String(lock.phase)})`,
        "wait for the owner, or retry after its TTL expires",
        lock as unknown as Record<string, unknown>,
      ),
      null,
      resolution.reason,
    );
  }

  if (options.rollback === true) {
    return rollbackIntegration(context, options, lock, store);
  }

  const phase = lock.phase;
  const baseSha = safeHead(context.git, context.mainRoot);
  const preLandSha = typeof lock.preLandSha === "string" ? lock.preLandSha : null;
  const postLandSha =
    typeof lock.postLandSha === "string" ? lock.postLandSha : null;

  if (phase === "merging") {
    const taskHead = safeHead(context.git, context.workspace);
    const landed =
      baseSha !== null &&
      ((postLandSha !== null && baseSha === postLandSha) ||
        (taskHead !== null && isAncestor(context.git, context.mainRoot, taskHead, context.baseBranch)));
    if (landed) {
      const written = writeOutcome(context, {
        mode: "local",
        outcome: "landed",
        baseSha: preLandSha,
        commit: taskHead,
        prUrl: null,
        verified: true,
        lastError: null,
        logRef: null,
      }, options, landedTaskDirectory(context));
      if (written.ok) commitLandedRecord(context);
      releaseStaleLock(store, lock);
      return withMode(
        written.ok
          ? {
              ok: true,
              mode: "local",
              modeReason: "recovered a completed fast-forward",
              outcome: "landed",
              baseSha: preLandSha,
              commit: taskHead,
              prUrl: null,
              conflict: null,
              logPath: null,
              next: null,
              taskRef: context.ref,
              baseBranch: context.baseBranch,
              branch: context.taskBranch,
              workspace: context.workspace,
            }
          : written.failure,
        "local",
        resolution.reason,
      );
    }
    if (baseSha !== null && baseSha === preLandSha) {
      releaseStaleLock(store, lock);
      return retryAfterRecovery(context, options, resolution);
    }
    return recoverNeedsHuman(
      context,
      options,
      lock,
      "the integration branch is neither preLandSha nor postLandSha",
      store,
    );
  }

  if (phase === "rebasing" || phase === "verifying" || phase === "acquiring") {
    if (baseSha !== null && baseSha === preLandSha) {
      abortInProgressRebase(context);
      releaseStaleLock(store, lock);
      return retryAfterRecovery(context, options, resolution);
    }
    return recoverNeedsHuman(
      context,
      options,
      lock,
      "the integration branch moved while the lock was stuck in rebasing/verifying",
      store,
    );
  }

  releaseStaleLock(store, lock);
  return withMode(
    {
      ok: true,
      mode: "local",
      modeReason: "cleared a completed integration lock",
      outcome: "none",
      baseSha,
      commit: null,
      prUrl: null,
      conflict: null,
      logPath: null,
      next: "nothing to recover",
      taskRef: context.ref,
      baseBranch: context.baseBranch,
      branch: context.taskBranch,
      workspace: context.workspace,
    },
    "local",
    resolution.reason,
  );
}

function recoverWithoutLock(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
): IntegrateResult {
  const baseSha = safeHead(context.git, context.mainRoot);
  const taskHead = safeHead(context.git, context.workspace);
  if (
    baseSha !== null &&
    taskHead !== null &&
    isAncestor(context.git, context.mainRoot, taskHead, context.baseBranch)
  ) {
    const written = writeOutcome(context, {
      mode: options.mode === "remote" ? "remote" : "local",
      outcome: "landed",
      baseSha,
      commit: taskHead,
      prUrl: null,
      verified: false,
      lastError: null,
      logRef: null,
    }, options, landedTaskDirectory(context));
    if (written.ok) commitLandedRecord(context);
    return withMode(
      written.ok
        ? {
            ok: true,
            mode: options.mode === "remote" ? "remote" : "local",
            modeReason: "task commit is already an ancestor of the integration branch",
            outcome: "landed",
            baseSha,
            commit: taskHead,
            prUrl: null,
            conflict: null,
            logPath: null,
            next: null,
            taskRef: context.ref,
            baseBranch: context.baseBranch,
            branch: context.taskBranch,
            workspace: context.workspace,
          }
        : written.failure,
      options.mode === "remote" ? "remote" : "local",
      resolution.reason,
    );
  }
  return withMode(
    {
      ok: true,
      mode: null,
      modeReason: "no integration lock to recover",
      outcome: readIntegrationMeta(context.view.meta).outcome,
      baseSha,
      commit: taskHead,
      prUrl: null,
      conflict: null,
      logPath: null,
      next: "nothing to recover",
      taskRef: context.ref,
      baseBranch: context.baseBranch,
      branch: context.taskBranch,
      workspace: context.workspace,
    },
    null,
    resolution.reason,
  );
}

function retryAfterRecovery(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
): IntegrateResult {
  const mode = resolveModeNameFromOptions(options, resolution);
  if (mode === "remote") {
    return runRemote(context, { ...options, recover: false }, resolution, mode);
  }
  return runLocal(context, { ...options, recover: false }, resolution, mode);
}

function recoverNeedsHuman(
  context: IntegrationContext,
  options: IntegrateOptions,
  lock: IntegrationLockRecord,
  reason: string,
  store: LeaseStore<IntegrationLockRecord>,
): IntegrateResult {
  const written = writeOutcome(context, {
    mode: "local",
    outcome: "needs_human",
    baseSha: typeof lock.preLandSha === "string" ? lock.preLandSha : null,
    commit: safeHead(context.git, context.workspace),
    prUrl: null,
    verified: false,
    lastError: reason,
    logRef: null,
  }, options);
  releaseStaleLock(store, lock);
  return withMode(
    failure(
      "INTEGRATE_RECOVER_NEEDS_HUMAN",
      `cannot recover automatically: ${reason}`,
      "inspect the base branch and the task worktree, then decide whether to rollback",
      { metaWritten: written.ok, lock: lock as unknown as Record<string, unknown> },
      { outcome: "needs_human" },
    ),
    "local",
    "recovery",
  );
}

function rollbackIntegration(
  context: IntegrationContext,
  options: IntegrateOptions,
  lock: IntegrationLockRecord,
  store: LeaseStore<IntegrationLockRecord>,
): IntegrateResult {
  const confirmed = options.yes === true || options.confirmRollback?.() === true;
  if (!confirmed) {
    return withMode(
      failure(
        "INTEGRATE_ROLLBACK_CONFIRM",
        "rollback moves the integration branch back with `git reset --hard`",
        "re-run with --yes (or confirm interactively) if this is intended",
        { preLandSha: lock.preLandSha },
      ),
      "local",
      "rollback",
    );
  }
  const preLandSha = typeof lock.preLandSha === "string" ? lock.preLandSha : "";
  if (preLandSha === "") {
    return withMode(
      failure(
        "INTEGRATE_RECOVER_NEEDS_HUMAN",
        "the lock does not record preLandSha; refusing to reset",
        "inspect the reflog and recover manually",
      ),
      "local",
      "rollback",
    );
  }
  const reset = runGit(context.mainRoot, ["reset", "--hard", preLandSha]);
  if (!reset.ok) {
    return withMode(
      failure(
        "GIT_FAILED",
        `git reset --hard ${preLandSha} failed: ${reset.detail}`,
        "inspect the repository state and retry",
      ),
      "local",
      "rollback",
    );
  }
  writeOutcome(context, {
    mode: "local",
    outcome: "none",
    baseSha: preLandSha,
    commit: null,
    prUrl: null,
    verified: false,
    lastError: "rolled back to preLandSha",
    logRef: null,
  }, options);
  releaseStaleLock(store, lock);
  return withMode(
    {
      ok: true,
      mode: "local",
      modeReason: "rolled back after explicit confirmation",
      outcome: "none",
      baseSha: preLandSha,
      commit: null,
      prUrl: null,
      conflict: null,
      logPath: null,
      next: "re-run the integration when the task is ready",
      taskRef: context.ref,
      baseBranch: context.baseBranch,
      branch: context.taskBranch,
      workspace: context.workspace,
    },
    "local",
    "rollback",
  );
}

function releaseStaleLock(
  store: LeaseStore<IntegrationLockRecord>,
  lock: IntegrationLockRecord,
): void {
  try {
    store.release({ path: store.path, record: lock });
  } catch {
    // A stale lock that cannot be removed is still reported by the next run.
  }
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

function dryRunResult(
  context: IntegrationContext,
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
  mode: ResolvedMode,
): IntegrateResult {
  const verify = verifyCommands(context, options);
  const lock = readLock(context);
  const queue = readQueue(context.paths);
  const baseSha = safeHead(context.git, context.mainRoot);
  const wouldRun =
    mode === "remote"
      ? [
          `git push -u origin ${context.taskBranch ?? "<task-branch>"}`,
          "create a pull/merge request (never merge)",
        ]
      : context.taskUsesMain
        ? ["verify in the main checkout", "write the task outcome"]
        : [
            `git -C ${context.workspace} rebase ${context.baseBranch}`,
            `verify in ${context.workspace}`,
            `git -C ${context.mainRoot} merge --ff-only ${context.taskBranch ?? "<task-branch>"}`,
            "write the task outcome",
          ];
  const result: IntegrateSuccess = {
    ok: true,
    mode,
    modeReason: resolution.reason,
    outcome: readIntegrationMeta(context.view.meta).outcome,
    baseSha,
    commit: safeHead(context.git, context.workspace),
    prUrl: null,
    conflict: null,
    logPath: null,
    next: null,
    taskRef: context.ref,
    baseBranch: context.baseBranch,
    branch: context.taskBranch,
    workspace: context.workspace,
    dryRun: true,
    warnings: [
      `lock: ${lock === null ? "free" : `${String(lock.owner ?? "unknown")} (${String(lock.phase ?? "unknown")})`}`,
      `queue position: ${String(queuePosition(queue, context.ref) ?? "not queued")}`,
      `verify: ${verify.length === 0 ? "none (pass --no-verify)" : verify.join(" && ")}`,
      `would run: ${wouldRun.join("; ")}`,
    ],
  };
  return result;
}

// ---------------------------------------------------------------------------
// Task records
// ---------------------------------------------------------------------------

function readIntegrationMeta(meta: Readonly<Record<string, unknown>>): IntegrationMeta {
  const integration = isRecord(meta.integration) ? meta.integration : {};
  const rawMode = integration.mode;
  const rawOutcome = integration.outcome;
  return {
    mode:
      rawMode === "local" || rawMode === "remote" || rawMode === "auto"
        ? rawMode
        : null,
    outcome:
      rawOutcome === "none" ||
      rawOutcome === "landed" ||
      rawOutcome === "pushed" ||
      rawOutcome === "blocked" ||
      rawOutcome === "needs_human"
        ? rawOutcome
        : "none",
    baseSha:
      typeof integration.base_sha === "string" ? integration.base_sha : null,
    commit: typeof integration.commit === "string" ? integration.commit : null,
    prUrl: typeof integration.pr_url === "string" ? integration.pr_url : null,
    verified: integration.verified === true,
    lastError:
      typeof integration.last_error === "string" ? integration.last_error : null,
    logRef: typeof integration.log_ref === "string" ? integration.log_ref : null,
    updatedAt:
      typeof integration.updated_at === "string" ? integration.updated_at : null,
  };
}

interface OutcomePatch {
  readonly mode: ResolvedMode;
  readonly outcome: IntegrationOutcome;
  readonly baseSha: string | null;
  readonly commit: string | null;
  readonly prUrl: string | null;
  readonly verified: boolean | null;
  readonly lastError: string | null;
  readonly logRef: string | null;
}

type WrittenOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: IntegrateFailure };

function writeOutcome(
  context: IntegrationContext,
  patch: OutcomePatch,
  _options: IntegrateOptions,
  targetOverride?: string | null,
): WrittenOutcome {
  const target = targetOverride ?? taskRecordDirectory(context);
  if (target === null) {
    return {
      ok: false,
      failure: failure(
        "TASK_NOT_FOUND",
        `cannot locate task.json for ${context.ref}`,
        "check the task worktree/control plane",
      ),
    };
  }
  return writeOutcomeRecord(context, target, patch, {
    commit: patch.commit,
    prUrl: patch.prUrl,
  }, _options);
}

function writeOutcomeRecord(
  context: IntegrationContext,
  taskDir: string,
  patch: OutcomePatch,
  topLevel: { readonly commit?: string | null; readonly prUrl?: string | null },
  _options: IntegrateOptions,
): WrittenOutcome {
  const file = path.join(taskDir, "task.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      failure: failure(
        "TASK_RECORD_INVALID",
        `cannot read ${file}: ${errorMessage(error)}`,
        "repair the task record and retry",
        { taskDir },
      ),
    };
  }

  const record = emptyTaskRecord();
  const bag = record as unknown as Record<string, unknown>;
  for (const field of TASK_RECORD_FIELD_ORDER) {
    if (field === "meta") continue;
    if (Object.hasOwn(raw, field)) {
      bag[field] = raw[field];
    }
  }
  bag.commit = topLevel.commit ?? raw.commit ?? null;
  bag.pr_url = topLevel.prUrl ?? raw.pr_url ?? null;
  const existingMeta = isRecord(raw.meta) ? raw.meta : {};
  const existingIntegration = isRecord(existingMeta.integration)
    ? existingMeta.integration
    : {};
  record.meta = {
    ...existingMeta,
    integration: {
      ...existingIntegration,
      mode: patch.mode,
      outcome: patch.outcome,
      base_sha: patch.baseSha,
      commit: patch.commit,
      pr_url: patch.prUrl,
      verified:
        patch.verified ??
        (typeof existingIntegration.verified === "boolean"
          ? existingIntegration.verified
          : false),
      last_error: patch.lastError,
      log_ref: patch.logRef,
      updated_at: context.now().toISOString(),
    },
  };

  try {
    writeTaskRecord({ taskDir, record });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      failure: failure(
        "TASK_RECORD_WRITE_FAILED",
        `cannot write ${file}: ${errorMessage(error)}`,
        "check filesystem permissions and retry",
        { taskDir },
      ),
    };
  }
}

/**
 * The record lives in the task worktree while the task is branch-local, and in
 * the main checkout once it has landed. Prefer the worktree so failure states
 * travel with the task branch.
 */
function taskRecordDirectory(context: IntegrationContext): string | null {
  if (!context.taskUsesMain && fs.existsSync(path.join(context.workspace, context.ref, "task.json"))) {
    return path.join(context.workspace, context.ref);
  }
  if (fs.existsSync(path.join(context.view.dir, "task.json"))) {
    return context.view.dir;
  }
  if (fs.existsSync(path.join(context.mainRoot, context.ref, "task.json"))) {
    return path.join(context.mainRoot, context.ref);
  }
  return null;
}

/**
 * After a fast-forward the landed record belongs to the integration branch, so
 * the outcome must be written in the main checkout (the task worktree is now
 * behind the landing commit).
 */
function landedTaskDirectory(context: IntegrationContext): string | null {
  const mainDir = path.join(context.mainRoot, context.ref);
  if (fs.existsSync(path.join(mainDir, "task.json"))) return mainDir;
  return taskRecordDirectory(context);
}

function commitLandedRecord(context: IntegrationContext): void {
  const dir = landedTaskDirectory(context);
  if (dir !== null) commitTaskJson(context, dir);
}

function commitTaskJson(
  context: IntegrationContext,
  taskDir: string,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  const workspace = path.resolve(context.workspace);
  const main = path.resolve(context.mainRoot);
  const target = path.resolve(taskDir);
  const base = isInside(workspace, target)
    ? workspace
    : isInside(main, target)
      ? main
      : null;
  if (base === null) return { ok: true };
  const relative = path.relative(base, target);
  if (relative === "") return { ok: true };
  const file = path.join(relative, "task.json").replace(/\\/g, "/");
  const status = runGit(base, ["status", "--porcelain", "--", file]);
  if (!status.ok || status.output.trim() === "") return { ok: true };
  const added = runGit(base, ["add", "--", file]);
  if (!added.ok) return { ok: false, detail: added.detail };
  const committed = runGit(base, [
    "commit",
    "-m",
    `chore(task): record integration state for ${context.taskId}`,
    "--",
    file,
  ]);
  if (!committed.ok && !/nothing to commit/i.test(committed.detail)) {
    return { ok: false, detail: committed.detail };
  }
  return { ok: true };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ---------------------------------------------------------------------------
// Handoff and logs
// ---------------------------------------------------------------------------

function writeHandoff(
  context: IntegrationContext,
  input: {
    readonly mode: ResolvedMode;
    readonly outcome: IntegrationOutcome;
    readonly classification: ConflictClassification;
    readonly baseSha: string | null;
    readonly taskHead: string | null;
    readonly verification: VerifyOutcome | null;
    readonly workspace: string;
  },
): string | null {
  const target = path.join(
    context.mainRoot,
    ".phronia",
    ".runtime",
    "integration-handoff.md",
  );
  const overlapping = overlappingTasks(context);
  const content = [
    "# Integration handoff",
    "",
    `- Task: ${context.ref}`,
    `- Title: ${context.view.title}`,
    `- Mode: ${input.mode}`,
    `- Outcome: ${input.outcome}`,
    `- Base: ${context.baseBranch} @ ${input.baseSha ?? "unknown"}`,
    `- Task head: ${input.taskHead ?? "unknown"}`,
    `- Workspace: ${input.workspace}`,
    `- Classification: ${input.classification.kind}`,
    `- Reason: ${input.classification.reason}`,
    `- Conflict files: ${
      input.classification.files.length === 0
        ? "none (clean rebase)"
        : input.classification.files.join(", ")
    }`,
    "",
    "## Verification",
    "",
    input.verification === null
      ? "_No verification ran._"
      : [
          `- Command: ${input.verification.command ?? "none"}`,
          `- Exit code: ${String(input.verification.exitCode)}`,
          `- Log: ${input.verification.logPath ?? "none"}`,
          "",
          "Output tail:",
          "",
          "```text",
          input.verification.outputTail,
          "```",
        ].join("\n"),
    "",
    "## Overlapping tasks",
    "",
    overlapping.length === 0
      ? "_No overlapping active tasks were found._"
      : overlapping.map((ref) => `- ${ref}`).join("\n"),
    "",
    "## Next",
    "",
    input.classification.next,
    "",
    "## Next-step prompt",
    "",
    "```text",
    `Task ${context.ref} could not be integrated automatically (${input.classification.kind}).`,
    `Work in ${input.workspace}. Do not blindly rewrite conflict markers.`,
    `1. Inspect the conflict/verification output above.`,
    `2. Make the intended code change and commit it with \`phronia task commit ${context.ref}\`.`,
    `3. Re-run \`phronia task integrate ${context.ref}\`.`,
    "```",
    "",
  ].join("\n");

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, redact(content), "utf8");
    return target;
  } catch {
    return null;
  }
}

function overlappingTasks(context: IntegrationContext): readonly string[] {
  const own = taskFootprint(context);
  const refs: string[] = [];
  for (const summary of context.state.tasks.list()) {
    const ref = canonicalRef(summary.ref);
    if (ref === context.ref) continue;
    const view = context.state.tasks.read(ref);
    if (view === null) continue;
    if (view.status !== null && !ACTIVE_TASK_STATUSES.has(view.status)) continue;
    const footprint = footprintForView(view, context.config);
    if (footprintsOverlap(own, footprint)) refs.push(ref);
    if (refs.length >= 10) break;
  }
  return refs;
}

function taskFootprint(context: IntegrationContext): Footprint {
  return footprintForView(context.view, context.config);
}

function footprintForView(
  view: TaskRecordView,
  config: ConfigView,
): Footprint {
  return normalizeFootprint(
    {
      meta: view.meta,
      relatedFiles: view.relatedFiles,
      package: view.package,
      scope: typeof view.raw.scope === "string" ? view.raw.scope : null,
    },
    { packagePaths: packagePathMap(config) },
  );
}

// ---------------------------------------------------------------------------
// Queue/runtime helpers
// ---------------------------------------------------------------------------

function readQueue(paths: SharedRuntimePaths): readonly QueueEntry[] {
  const read = readRuntimeJson<{ queue?: unknown }>(paths.integration);
  if (!read.ok || !isRecord(read.value)) return [];
  const queue = read.value.queue;
  if (!Array.isArray(queue)) return [];
  return queue
    .filter(isQueueEntry)
    .map((entry) => ({ ...entry, taskRef: canonicalRef(entry.taskRef) }));
}

function writeQueue(paths: SharedRuntimePaths, queue: readonly QueueEntry[]): void {
  const read = readRuntimeJson<Record<string, unknown>>(paths.integration);
  const last = read.ok && isRecord(read.value) ? read.value.last : undefined;
  writeRuntimeJson(paths.integration, {
    schemaVersion: 1,
    queue,
    ...(last === undefined ? {} : { last }),
  });
}

function writeLastResult(
  context: IntegrationContext,
  last: { readonly outcome: IntegrationOutcome; readonly commit: string | null; readonly at: string },
): void {
  const read = readRuntimeJson<Record<string, unknown>>(context.paths.integration);
  const queue = read.ok ? readQueue(context.paths) : [];
  writeRuntimeJson(context.paths.integration, {
    schemaVersion: 1,
    queue,
    last: { taskRef: context.ref, ...last },
  });
}

function readLock(
  context: IntegrationContext,
): IntegrationLockRecord | null {
  const read = readRuntimeJson<IntegrationLockRecord>(context.paths.integrationLock);
  if (!read.ok || read.value === null) return null;
  if (typeof read.value.preLandSha !== "string") return null;
  return read.value;
}

// ---------------------------------------------------------------------------
// Task/base resolution
// ---------------------------------------------------------------------------

function readTaskView(
  state: StateReader,
  registry: readonly WorktreeRegistryEntry[],
  taskRef: string,
): TaskRecordView | null {
  const canonical = canonicalRef(taskRef);
  // A task worktree is the active record for a branch-local task: mode/outcome
  // written there must win over an older control-plane copy in main.
  const entry = registry.find(
    (candidate) => canonicalRef(candidate.taskRef) === canonical,
  );
  if (entry !== undefined && entry.path !== "") {
    const dir = path.isAbsolute(canonical)
      ? canonical
      : path.join(entry.path, canonical);
    const local = readTaskViewFromDir(canonical, dir);
    if (local !== null) return local;
  }
  return state.tasks.read(taskRef);
}

function readTaskViewFromDir(
  ref: string,
  dir: string,
): TaskRecordView | null {
  const file = path.join(dir, "task.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      ref,
      dir,
      id: typeof raw.id === "string" ? raw.id : basename(ref),
      name: typeof raw.name === "string" ? raw.name : basename(ref),
      title:
        typeof raw.title === "string" && raw.title.trim() !== ""
          ? raw.title
          : basename(ref),
      status: typeof raw.status === "string" ? raw.status : null,
      package: typeof raw.package === "string" ? raw.package : null,
      branch: typeof raw.branch === "string" ? raw.branch : null,
      baseBranch: typeof raw.base_branch === "string" ? raw.base_branch : null,
      parent: null,
      children: [],
      relatedFiles: Array.isArray(raw.relatedFiles)
        ? raw.relatedFiles.filter((item): item is string => typeof item === "string")
        : [],
      meta: isRecord(raw.meta) ? raw.meta : {},
      raw,
    };
  } catch {
    return null;
  }
}

function resolveBaseBranch(
  mainRoot: string,
  view: TaskRecordView,
  config: ConfigView,
  explicit: string | undefined,
  git: GitPort,
): { readonly ok: true; readonly branch: string } | { readonly ok: false; readonly message: string } {
  const candidates: string[] = [];
  if (explicit !== undefined && explicit.trim() !== "") candidates.push(explicit.trim());
  const configured = config.parallel.integration.branch;
  if (configured !== null && configured !== "") candidates.push(configured);
  if (view.baseBranch !== null && view.baseBranch !== "") candidates.push(view.baseBranch);
  const current = safeBranch(git, mainRoot);
  if (current !== "") candidates.push(current);
  candidates.push("main", "master");

  for (const candidate of candidates) {
    const local = candidate.startsWith("origin/") ? candidate.slice("origin/".length) : candidate;
    if (refExists(git, mainRoot, `refs/heads/${local}`)) return { ok: true, branch: local };
  }
  return {
    ok: false,
    message:
      "cannot determine a local integration branch; pass --base <branch> or create main/master",
  };
}

function canonicalRefForView(view: TaskRecordView, mainRoot: string): string {
  const stored = canonicalRef(view.ref);
  if (stored.startsWith(".phronia/tasks/")) {
    return stored;
  }
  const relative = path.relative(mainRoot, view.dir);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return canonicalRef(relative);
  }
  return stored.startsWith(".phronia/") || path.isAbsolute(stored)
    ? stored
    : canonicalRef(`.phronia/tasks/${view.id}`);
}

function taskArtifactsCommitted(
  context: IntegrationContext,
  branch: string,
): boolean {
  try {
    context.git.resolveRef(
      context.mainRoot,
      `${branch}:${path.join(context.ref, "task.json").replace(/\\/g, "/")}`,
    );
    return true;
  } catch {
    return false;
  }
}

function taskStatus(state: StateReader, taskRef: string | null): string | null {
  if (taskRef === null || taskRef === "") return null;
  return state.tasks.read(taskRef)?.status ?? null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isBusyCode(code: string): boolean {
  return (
    code === "INTEGRATE_LOCK_BUSY" ||
    code === "WORKSPACE_CLAIM_BUSY" ||
    code === "LEASE_BUSY"
  );
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function heartbeatLock(
  phase: PhaseState,
  patch: Partial<IntegrationLockRecord>,
): void {
  try {
    phase.lockStore.heartbeat(phase.lock, patch);
  } catch {
    // Losing the lock is caught by the CAS/final write; do not mask it here.
  }
}

function safeRelease<T extends LeaseRecord>(
  store: LeaseStore<T>,
  handle: LeaseHandle<T>,
): void {
  try {
    store.release(handle);
  } catch {
    // A leftover lock is recoverable via --recover.
  }
}

function readClaim(context: IntegrationContext): WorkspaceClaimRecord | null {
  const read = readRuntimeJson<WorkspaceClaimRecord>(context.paths.workspaceClaim);
  if (!read.ok || read.value === null) return null;
  if (typeof read.value.ownerRef !== "string") return null;
  return read.value;
}

function describeClaim(claim: WorkspaceClaimRecord): string {
  if (claim.taskRef !== null && claim.taskRef !== "") return canonicalRef(claim.taskRef);
  return claim.ownerRef;
}

function claimDetails(claim: WorkspaceClaimRecord): Record<string, unknown> {
  return {
    ownerType: claim.ownerType,
    ownerRef: claim.ownerRef,
    taskRef: claim.taskRef,
    workspace: claim.workspace,
    state: claim.state,
    acquiredAt: claim.acquiredAt,
    heartbeatAt: claim.heartbeatAt,
    ttlSeconds: claim.ttlSeconds,
  };
}

function safeBranch(git: GitPort, cwd: string): string {
  try {
    return git.branch(cwd);
  } catch {
    return "";
  }
}

function safeHead(git: GitPort, cwd: string): string | null {
  try {
    return git.head(cwd);
  } catch {
    return null;
  }
}

function safeIsBare(git: GitPort, cwd: string): boolean {
  try {
    return git.isBare(cwd);
  } catch {
    return false;
  }
}

function safeForgeAvailable(forge: ForgePort): boolean {
  try {
    return forge.available();
  } catch {
    return false;
  }
}

function isClean(git: GitPort, cwd: string): boolean {
  try {
    return git.status(cwd).clean;
  } catch {
    return false;
  }
}

function refExists(git: GitPort, cwd: string, ref: string): boolean {
  try {
    git.resolveRef(cwd, ref);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(
  git: GitPort,
  cwd: string,
  ancestor: string,
  ref: string,
): boolean {
  try {
    return git.isAncestor(cwd, ancestor, ref);
  } catch {
    return false;
  }
}

function abortInProgressRebase(context: IntegrationContext): void {
  let gitDir = "";
  try {
    gitDir = execFileSync(
      "git",
      ["rev-parse", "--git-path", "rebase-merge"],
      { cwd: context.workspace, encoding: "utf8", timeout: 3000 },
    ).trim();
  } catch {
    return;
  }
  if (gitDir === "") return;
  const resolved = path.isAbsolute(gitDir)
    ? gitDir
    : path.resolve(context.workspace, gitDir);
  if (fs.existsSync(resolved)) {
    context.git.rebaseAbort(context.workspace);
    return;
  }
  try {
    const applyDir = execFileSync(
      "git",
      ["rev-parse", "--git-path", "rebase-apply"],
      { cwd: context.workspace, encoding: "utf8", timeout: 3000 },
    ).trim();
    const applyResolved = path.isAbsolute(applyDir)
      ? applyDir
      : path.resolve(context.workspace, applyDir);
    if (fs.existsSync(applyResolved)) context.git.rebaseAbort(context.workspace);
  } catch {
    // No rebase metadata: nothing to abort.
  }
}

/** `git ls-files -u` stages: stage 1 = base, 2 = ours, 3 = theirs. */
function readAddAddFiles(cwd: string, files: readonly string[]): readonly string[] {
  if (files.length === 0) return [];
  const result = runGit(cwd, ["ls-files", "-u", "--", ...files]);
  if (!result.ok) return [];
  const stages = new Map<string, Set<string>>();
  for (const line of result.output.split(/\r?\n/)) {
    const match = /^\d+\s+[0-9a-f]+\s+(\d)\t(.+)$/.exec(line);
    if (match === null) continue;
    const stage = match[1];
    const file = match[2];
    const set = stages.get(file) ?? new Set<string>();
    set.add(stage);
    stages.set(file, set);
  }
  const addAdd: string[] = [];
  for (const [file, values] of stages) {
    if (values.has("2") && values.has("3") && !values.has("1")) addAdd.push(file);
  }
  return addAdd;
}

interface GitRunResult {
  readonly ok: boolean;
  readonly output: string;
  readonly detail: string;
}

function runGit(cwd: string, args: readonly string[]): GitRunResult {
  try {
    const output = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output, detail: "" };
  } catch (error) {
    const failure = error as {
      status?: number | null;
      stdout?: string | Buffer | null;
      stderr?: string | Buffer | null;
      message?: string;
    };
    const detail = `${bufferText(failure.stderr)}${bufferText(failure.stdout)}`.trim();
    return {
      ok: false,
      output: bufferText(failure.stdout),
      detail: detail === "" ? (failure.message ?? "git command failed") : detail,
    };
  }
}

function runCommandsIn(
  cwd: string,
  commands: readonly string[],
  context: IntegrationContext,
  options: IntegrateOptions,
): { readonly ok: boolean } {
  const timeout = resolveVerifyTimeout(context, options) ?? DEFAULT_VERIFY_TIMEOUT_MS;
  for (const command of commands) {
    const argv = tokenize(command);
    if (argv.length === 0) continue;
    try {
      execFileSync(argv[0], argv.slice(1), {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: MAX_LOG_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return { ok: false };
    }
  }
  return { ok: true };
}

function commitAllIfDirty(cwd: string, message: string): void {
  const status = runGit(cwd, ["status", "--porcelain"]);
  if (!status.ok || status.output.trim() === "") return;
  const added = runGit(cwd, ["add", "-A"]);
  if (!added.ok) return;
  runGit(cwd, ["commit", "-m", message]);
}

function readOriginUrl(cwd: string): string | null {
  try {
    const output = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

function resolveVerifyTimeout(
  context: IntegrationContext,
  options: IntegrateOptions,
): number | null {
  const value = options.timeout ?? context.config.parallel.integration.timeout;
  return parseDurationMs(value) ?? (options.timeout === undefined ? DEFAULT_VERIFY_TIMEOUT_MS : null);
}

function resolveWaitTimeout(
  context: IntegrationContext,
  options: IntegrateOptions,
): number | null {
  const value = options.timeout;
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  return parseDurationMs(value);
}

function lockTtlSeconds(
  context: IntegrationContext,
  options: IntegrateOptions,
): number {
  const configured = parseDurationMs(context.config.parallel.integration.lockTtl);
  const base =
    configured === null
      ? DEFAULT_LOCK_TTL_SECONDS
      : Math.max(60, Math.ceil(configured / 1000));
  const verify = resolveVerifyTimeout(context, options) ?? DEFAULT_VERIFY_TIMEOUT_MS;
  return Math.max(base, Math.ceil(verify / 1000) + LOCK_HEARTBEAT_MARGIN_SECONDS);
}

export function parseDurationMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i.exec(trimmed);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] ?? "m").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return amount * multipliers[unit];
}

function resolveModeNameFromOptions(
  options: IntegrateOptions,
  resolution: IntegrationModeResolution,
): ResolvedMode {
  if (options.mode === "remote") return "remote";
  if (options.mode === "local") return "local";
  return resolution.mode;
}

function relativeTo(root: string, target: string | null): string | null {
  if (target === null) return null;
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return target;
  }
  return relative.replace(/\\/g, "/");
}

function canonicalRef(ref: string): string {
  let value = ref.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value === "" || path.isAbsolute(value)) return value;
  if (value.startsWith("tasks/")) return `.phronia/${value}`;
  if (!value.startsWith(".phronia/") && !value.includes("/")) {
    // A bare task id (`10-28-alpha`) refers to `.phronia/tasks/<id>`.
    return `.phronia/tasks/${value}`;
  }
  return value;
}

function canonicalRefOrNull(ref: string | null): string | null {
  return ref === null ? null : canonicalRef(ref);
}

function basename(ref: string): string {
  return ref.split("/").filter((part) => part !== "").at(-1) ?? ref;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueueEntry(value: unknown): value is QueueEntry {
  return (
    isRecord(value) &&
    typeof value.taskRef === "string" &&
    typeof value.enqueuedAt === "string"
  );
}

function bufferText(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function tail(value: string): string {
  return value.length <= MAX_TAIL_CHARS
    ? value
    : value.slice(value.length - MAX_TAIL_CHARS);
}

function redact(value: string): string {
  return value
    .replace(
      /([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*[:=]\s*[^\s]+/gi,
      "$1=<redacted>",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1<redacted>@")
    .replace(/([?&](?:token|access_token|key|secret|password)=)[^&\s]+/gi, "$1<redacted>");
}

function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown-host";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface FailureExtra {
  readonly outcome?: IntegrationOutcome;
  readonly conflict?: ConflictClassification | null;
  readonly logPath?: string | null;
  readonly baseSha?: string | null;
  readonly commit?: string | null;
  readonly prUrl?: string | null;
  readonly handoffPath?: string | null;
}

function failure(
  code: string,
  message: string,
  next: string,
  details?: Readonly<Record<string, unknown>>,
  extra: FailureExtra = {},
): IntegrateFailure {
  return {
    ok: false,
    code,
    message,
    next,
    ...(details === undefined ? {} : { details }),
    ...(extra.outcome === undefined ? {} : { outcome: extra.outcome }),
    ...(extra.conflict === undefined ? {} : { conflict: extra.conflict }),
    ...(extra.logPath === undefined ? {} : { logPath: extra.logPath }),
    ...(extra.baseSha === undefined ? {} : { baseSha: extra.baseSha }),
    ...(extra.commit === undefined ? {} : { commit: extra.commit }),
    ...(extra.prUrl === undefined ? {} : { prUrl: extra.prUrl }),
    ...(extra.handoffPath === undefined ? {} : { handoffPath: extra.handoffPath }),
  };
}

function withMode(
  result: IntegrateFailure,
  mode: ResolvedMode | null,
  reason: string | null,
): IntegrateFailure;
function withMode(
  result: IntegrateSuccess,
  mode: ResolvedMode | null,
  reason: string | null,
): IntegrateSuccess;
function withMode(
  result: IntegrateResult,
  mode: ResolvedMode | null,
  reason: string | null,
): IntegrateResult;
function withMode(
  result: IntegrateResult,
  mode: ResolvedMode | null,
  reason: string | null,
): IntegrateResult {
  if (result.ok) {
    return { ...result, mode: result.mode ?? mode, modeReason: result.modeReason ?? reason };
  }
  return {
    ...result,
    mode: result.mode ?? mode,
    modeReason: result.modeReason ?? reason,
  };
}

// Kept for diagnostics: the caller can render the three lock paths.
export function integrationRuntimePaths(cwd: string): SharedRuntimePaths {
  const git = createGitPort();
  const mainRoot = git.mainWorktreeRoot(path.resolve(cwd));
  return resolveSharedRuntime({ cwd: mainRoot, git }).paths;
}

// Exported for tests that need to assert a worktree's git metadata.
export type { WorktreeInfo };
