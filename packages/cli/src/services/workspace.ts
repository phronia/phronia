/**
 * Workspace service: task-level isolation, atomic main-checkout claims, and
 * the worktree primitives (`add/list/attach/remove/prune`).
 *
 * Business decisions come from W1 (`decideWorkspace`); atomic file operations
 * come from W2 (`LeaseStore`, `GitPort`, shared-runtime registry). This module
 * only gathers context, executes the decision, and returns the CLI contract
 * (`code` + `next`).
 *
 * References: design.md §4.2-§4.6, §13, §18.3, §19.6, §21.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideWorkspace,
  readParallelMeta,
  worktreeSlug,
  type TaskLease,
  type WorkspaceClaim,
  type WorkspaceDecision,
  type WorkspaceWorktree,
} from "@phronia/core/task";
import {
  openState,
  type ConfigView,
  type TaskRecordView,
} from "@phronia/core/state";
import {
  createGitPort,
  GitError,
  type GitPort,
  type WorktreeInfo,
} from "../adapters/git.js";
import {
  createLeaseStore,
  isLeaseStale,
  type LeaseHandle,
  type LeaseRecord,
  type LeaseStore,
  LeaseError,
} from "../adapters/lease.js";
import {
  ensureSharedRuntime,
  loadWorktreeRegistry,
  readRuntimeJson,
  resolveSharedRuntime,
  writeRuntimeJson,
  type WorktreeRegistryEntry,
  type WorktreeRegistryLoadResult,
} from "../adapters/shared-runtime.js";
import { listTaskLeases } from "./lease.js";

const DEFAULT_CLAIM_TTL_SECONDS = 7200;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const ACTIVE_TASK_STATUSES = new Set(["planning", "in_progress", "blocked"]);

export interface WorkspaceFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly next: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceClaimRecord extends LeaseRecord {
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

export interface WorkspaceDependencies {
  readonly cwd: string;
  readonly git?: GitPort;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
  readonly host?: string;
  readonly pid?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to true; `prepare` with `--dry-run` is not implemented, so tests
   * mostly use this for status-style reads. */
  readonly writeRegistry?: boolean;
}

export interface PrepareWorkspaceOptions extends WorkspaceDependencies {
  /** `--for-new-task "<title>"`: create a provisional workspace when main is busy. */
  readonly forNewTask?: string;
  readonly force?: boolean;
  readonly reuseDirty?: boolean;
  readonly sessionKey?: string;
  readonly ownerId?: string;
}

export interface EnsureWorkspaceOptions extends WorkspaceDependencies {
  readonly taskRef: string;
  readonly path?: string;
  readonly force?: boolean;
  readonly reuseDirty?: boolean;
  readonly copyTask?: boolean;
  readonly copy?: readonly string[];
  readonly postCreate?: readonly string[];
  readonly sessionKey?: string;
}

export interface BindWorkspaceOptions extends WorkspaceDependencies {
  readonly taskRef: string;
  readonly path?: string;
}

export interface ReleaseWorkspaceOptions extends WorkspaceDependencies {
  readonly force?: boolean;
  readonly sessionKey?: string;
}

export interface ReclaimWorkspaceOptions extends WorkspaceDependencies {
  readonly force?: boolean;
  readonly sessionKey?: string;
  readonly ttlSeconds?: number;
}

export interface WorkspaceSuccess {
  readonly ok: true;
  readonly decision: WorkspaceDecision;
  readonly workspace: string | null;
  readonly claim: WorkspaceClaimRecord | null;
  readonly lease: TaskLease | null;
  readonly warnings: readonly string[];
  readonly provisional?: {
    readonly title: string;
    readonly path: string;
    readonly branch: string;
  };
}

export type WorkspaceResult = WorkspaceSuccess | WorkspaceFailure;

export interface WorktreeRecord {
  taskRef: string;
  taskId: string;
  path: string;
  branch: string;
  createdAt: string;
  kind?: "phronia" | "platform";
  provisional?: boolean;
}

export interface WorktreeOptions {
  readonly cwd: string;
  readonly git?: GitPort;
  readonly now?: () => Date;
  readonly force?: boolean;
  readonly path?: string;
  readonly branch?: string;
  readonly base?: string;
  readonly deleteBranch?: boolean;
  readonly copy?: readonly string[];
  readonly postCreate?: readonly string[];
}

export interface WorktreeResult {
  readonly ok: boolean;
  readonly message: string;
  readonly record?: WorktreeRecord;
  readonly code?: string;
  readonly next?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AttachWorktreeOptions {
  readonly cwd: string;
  readonly git?: GitPort;
  readonly path?: string;
}

export type AttachWorktreeResult = WorktreeResult;

export interface PruneOptions {
  readonly cwd: string;
  readonly git?: GitPort;
  readonly now?: () => Date;
  readonly dryRun?: boolean;
  readonly olderThan?: string;
  readonly deleteBranch?: boolean;
}

export interface PruneKept {
  readonly taskRef: string;
  readonly path: string;
  readonly reason: string;
}

export interface PruneResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly removed: readonly WorktreeRecord[];
  readonly kept: readonly PruneKept[];
  readonly message: string;
}

interface WorkspaceContext {
  readonly cwd: string;
  readonly mainRoot: string;
  readonly git: GitPort;
  readonly config: ConfigView;
  readonly paths: ReturnType<typeof resolveSharedRuntime>["paths"];
  readonly registryLoad: WorktreeRegistryLoadResult;
  readonly now: Date;
  readonly nowFn: () => Date;
  readonly host: string;
  readonly pid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writeRegistry: boolean;
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

export function prepareWorkspace(
  options: PrepareWorkspaceOptions,
): WorkspaceResult {
  let context: WorkspaceContext;
  try {
    context = loadContext(options, options.writeRegistry !== false);
  } catch (error) {
    return gitFailure(error);
  }

  const sessionKey = sessionKeyFor(context, options.sessionKey);
  if (sessionKey === null) return sessionUnknown("prepare a workspace");
  const ownerRef = options.ownerId ?? `session:${sessionKey}`;
  const dirty = isMainDirty(context);
  const current = readClaim(context);
  const claimStale =
    current !== null ? isLeaseStale(current, context.now, { liveness: "ttl" }) : false;
  const ownerStatus =
    current !== null && current.taskRef !== null
      ? taskStatus(context, current.taskRef)
      : null;
  const ownerActive =
    ownerStatus !== null && ACTIVE_TASK_STATUSES.has(ownerStatus);

  if (current !== null && !claimStale) {
    if (current.sessionKey === sessionKey && current.taskRef === null) {
      const refreshed = heartbeatClaim(context, current, {
        state: "planning",
        ownerRef,
      });
      return success(
        { kind: "reuse-current", reason: "this session already owns the main checkout" },
        context.mainRoot,
        refreshed,
        null,
      );
    }
    return busyOrProvisional(context, options, sessionKey, ownerRef, {
      code: "WORKSPACE_CLAIM_BUSY",
      reason: `current checkout is owned by ${describeClaim(current)}`,
      next: "wait for the owner, finish that task, or prepare a provisional workspace",
      owner: current,
    });
  }

  if (current !== null) {
    if (dirty) {
      return busyOrProvisional(context, options, sessionKey, ownerRef, {
        code: "WORKSPACE_CLAIM_STALE_DIRTY",
        reason: `stale claim from ${describeClaim(current)} and the main checkout has uncommitted changes; never reclaim automatically`,
        next: "use a worktree, ask the previous owner to commit/stash, or run `phronia task workspace reclaim` explicitly",
        owner: current,
      });
    }
    if (ownerActive) {
      return busyOrProvisional(context, options, sessionKey, ownerRef, {
        code: "WORKSPACE_CLAIM_STALE_OWNED",
        reason: `stale claim from ${describeClaim(current)} but the owner task is still ${String(ownerStatus)}`,
        next: "use a worktree, or run `phronia task workspace reclaim` explicitly",
        owner: current,
      });
    }
    const reclaimed = tryAcquireClaim(context, {
      sessionKey,
      ownerRef,
      taskRef: null,
      state: "planning",
      reclaim: true,
    });
    if (reclaimed.claimed) {
      return success(
        {
          kind: "reuse-current",
          reason: `reclaimed the stale claim from ${describeClaim(current)} (owner finished, checkout clean)`,
        },
        context.mainRoot,
        reclaimed.claim,
        null,
      );
    }
    return busyOrProvisional(context, options, sessionKey, ownerRef, {
      code: "WORKSPACE_CLAIM_BUSY",
      reason: `current checkout is owned by ${describeClaim(reclaimed.busy ?? current)}`,
      next: "wait for the owner, finish that task, or prepare a provisional workspace",
      owner: reclaimed.busy ?? current,
    });
  }

  if (dirty && options.reuseDirty !== true && options.force !== true) {
    return busyOrProvisional(context, options, sessionKey, ownerRef, {
      code: "WORKSPACE_DIRTY_UNCLAIMED",
      reason: `the main checkout has ${
        safeDirtyPaths(context)
      } uncommitted path(s) and no claim`,
      next: "use `--reuse-dirty`, commit/stash the changes, or prepare a worktree",
      owner: null,
    });
  }

  const acquired = tryAcquireClaim(context, {
    sessionKey,
    ownerRef,
    taskRef: null,
    state: "planning",
    reclaim: false,
  });
  if (acquired.claimed) {
    return success(
      { kind: "reuse-current", reason: "acquired the main checkout for this session" },
      context.mainRoot,
      acquired.claim,
      null,
    );
  }
  return busyOrProvisional(context, options, sessionKey, ownerRef, {
    code: "WORKSPACE_CLAIM_BUSY",
    reason: `another session claimed the main checkout first${
      acquired.busy === null ? "" : ` (${describeClaim(acquired.busy)})`
    }`,
    next: "wait for the owner, finish that task, or prepare a provisional workspace",
    owner: acquired.busy,
  });
}

interface BusyInfo {
  readonly code: string;
  readonly reason: string;
  readonly next: string;
  readonly owner: WorkspaceClaimRecord | null;
}

function busyOrProvisional(
  context: WorkspaceContext,
  options: PrepareWorkspaceOptions,
  sessionKey: string,
  ownerRef: string,
  busy: BusyInfo,
): WorkspaceResult {
  if (options.forNewTask === undefined || options.forNewTask.trim() === "") {
    return workspaceFailure(busy.code, busy.reason, busy.next, {
      ...(busy.owner === null ? {} : { owner: claimDetails(busy.owner) }),
    });
  }

  const title = options.forNewTask.trim();
  const slug = safeSlug(title);
  const hash = shortHash(`${sessionKey}:${title}`);
  const directory = worktreeDirectory(context);
  const target = hardenedPath(directory, slug, `${slug}-${hash}`, context);
  const branch = `phronia/wip/${slug.slice(0, 48)}-${hash}`;
  const base = integrationBase(context, null);

  if (fs.existsSync(target)) {
    return workspaceFailure(
      "WORKSPACE_TARGET_EXISTS",
      `target worktree path already exists: ${target}`,
      "remove the directory or bind the existing workspace with `phronia task workspace bind`",
    );
  }
  const checkedOut = worktreeOnBranch(context, branch);
  if (checkedOut !== null) {
    return workspaceFailure(
      "WORKSPACE_TARGET_EXISTS",
      `branch ${branch} is already checked out at ${checkedOut}`,
      "use the existing worktree instead of creating another one",
    );
  }

  try {
    context.git.worktreeAdd({
      cwd: context.mainRoot,
      path: target,
      branch,
      base,
      createBranch: true,
    });
  } catch (error) {
    return workspaceFailure(
      "GIT_FAILED",
      `cannot create provisional worktree at ${target}: ${gitDetail(error)}`,
      "fix the git error and retry `phronia task workspace prepare --for-new-task`",
    );
  }

  const record: WorktreeRegistryEntry = {
    taskRef: "",
    path: target,
    branch,
    kind: "phronia",
    provisional: true,
    createdAt: context.now.toISOString(),
  };
  upsertRegistryEntry(context, record);
  fs.mkdirSync(path.join(target, ".phronia", ".runtime"), { recursive: true });

  const post = applyCopyAndPostCreate(context, target, {});
  if (!post.ok) {
    return workspaceFailure(post.code, post.message, post.next);
  }

  return {
    ok: true,
    decision: {
      kind: "create",
      path: target,
      branch,
      base,
      code: busy.code,
      reason: `provisional workspace: ${busy.reason}`,
    },
    workspace: target,
    claim: busy.owner,
    lease: null,
    warnings: [`${busy.reason}; created a provisional workspace`],
    provisional: { title, path: target, branch },
  };
}

// ---------------------------------------------------------------------------
// ensure / bind / release / reclaim
// ---------------------------------------------------------------------------

export function ensureWorkspace(
  options: EnsureWorkspaceOptions,
): WorkspaceResult {
  let context: WorkspaceContext;
  try {
    context = loadContext(options, options.writeRegistry !== false);
  } catch (error) {
    return gitFailure(error);
  }

  const sessionKey = sessionKeyFor(context, options.sessionKey);
  if (sessionKey === null) return sessionUnknown("ensure a workspace");
  const view = readTaskRecord(context, options.taskRef);
  if (view === null) {
    return workspaceFailure(
      "TASK_NOT_FOUND",
      `task not found in the main checkout: ${options.taskRef}`,
      "create the task in the main checkout first (`phronia task create \"<title>\"`)",
    );
  }
  const ref = viewRef(context, view);
  const dirty = isMainDirty(context);
  const current = readClaim(context);
  const ownerStatus = current?.taskRef != null ? taskStatus(context, current.taskRef) : null;

  const registryEntries = context.registryLoad.registry.worktrees;
  const existingEntries = enrichWithLegacy(context, registryEntries, view, ref);
  const existing = existingEntries.find((entry) => canonicalRef(entry.taskRef) === ref);
  const taskBranch = existing?.branch ?? view.branch ?? `phronia/${worktreeSlug({ ref, id: view.id })}`;
  const targetPath = hardenedPath(
    worktreeDirectory(context),
    worktreeSlug({ ref, id: view.id }),
    `${worktreeSlug({ ref, id: view.id })}-${shortHash(ref)}`,
    context,
  );
  const targetBranch = existing?.branch ?? taskBranch;

  let explicitWorktree: WorkspaceWorktree | null = null;
  if (options.path !== undefined) {
    const attached = validateAttachTarget(context, view, ref, options.path);
    if (!attached.ok) {
      return workspaceFailure(attached.code, attached.message, attached.next);
    }
    explicitWorktree = attached.worktree;
  } else if (path.resolve(context.cwd) !== path.resolve(context.mainRoot)) {
    // Running inside a linked worktree: if it already carries this task's
    // branch, attach instead of creating a second workspace (WS-03).
    const cwdBranch = safeBranch(context, context.cwd);
    if (cwdBranch !== "" && cwdBranch === taskBranch) {
      explicitWorktree = {
        path: path.resolve(context.cwd),
        branch: cwdBranch,
        kind: "platform",
      };
    }
  }

  const decision = decideWorkspace({
    currentCheckout: context.mainRoot,
    integrationBranch: integrationBase(context, view),
    task: {
      ref,
      id: view.id,
      branch: taskBranch,
      exclusive: readParallelMeta(view.meta).exclusive,
      worktree: explicitWorktree,
      worktreePolicy: context.config.parallel.worktree,
      status: view.status ?? "unknown",
    },
    claim: toPolicyClaim(context, current, ownerStatus, sessionKey),
    mainDirty: dirty,
    mainDirtyPaths: safeDirtyPaths(context),
    parallelBatchSize: 1,
    existingWorktrees: existingEntries.map(toWorkspaceWorktree),
    target: {
      path: targetPath,
      branch: targetBranch,
      exists: fs.existsSync(targetPath),
      checkedOutAt: worktreeOnBranch(context, targetBranch),
    },
    reuseDirty: options.reuseDirty === true || options.force === true,
    force: options.force === true,
    worktreeDir: worktreeDirectory(context),
  });

  const linkedGuard = guardLinkedCheckout(context, decision, existing, options);
  if (linkedGuard !== null) {
    if (!linkedGuard.ok) return linkedGuard.failure;
    return executeWorkspaceDecision(
      context,
      linkedGuard.decision,
      view,
      ref,
      options,
      sessionKey,
      current,
    );
  }

  return executeWorkspaceDecision(
    context,
    decision,
    view,
    ref,
    options,
    sessionKey,
    current,
  );
}

interface LinkedGuard {
  readonly ok: true;
  readonly decision: WorkspaceDecision;
}

function guardLinkedCheckout(
  context: WorkspaceContext,
  decision: WorkspaceDecision,
  existing: WorktreeRegistryEntry | undefined,
  options: EnsureWorkspaceOptions,
): LinkedGuard | { ok: false; failure: WorkspaceFailure } | null {
  if (path.resolve(context.cwd) === path.resolve(context.mainRoot)) return null;
  if (existing !== undefined) return null;
  // Running inside a linked worktree. Only the task that owns that checkout may
  // reuse it; everything else needs its own workspace.
  if (decision.kind === "reuse-current") {
    const slug = worktreeSlug({ ref: options.taskRef });
    return {
      ok: true,
      decision: {
        kind: "create",
        path: hardenedPath(
          worktreeDirectory(context),
          slug,
          `${slug}-${shortHash(options.taskRef)}`,
          context,
        ),
        branch: `phronia/${slug}`,
        base: integrationBase(context, null),
        reason:
          "the current checkout is a linked worktree for another task; this task needs its own workspace",
      },
    };
  }
  return null;
}

function executeWorkspaceDecision(
  context: WorkspaceContext,
  decision: WorkspaceDecision,
  view: TaskRecordView,
  ref: string,
  options: EnsureWorkspaceOptions,
  sessionKey: string,
  current: WorkspaceClaimRecord | null,
): WorkspaceResult {
  if (decision.kind === "refuse") {
    return workspaceFailure(
      decision.code,
      decision.reason,
      decision.next,
    );
  }

  if (decision.kind === "reuse-current") {
    const claim = claimForTask(context, current, ref, view.status ?? "planning", sessionKey);
    if (!claim.ok) return claim.failure;
    return success(decision, context.mainRoot, claim.claim, findLease(context, ref), [
      "session shares the main checkout with this task",
    ]);
  }

  if (decision.kind === "attach") {
    upsertRegistryEntry(context, {
      taskRef: ref,
      path: decision.path,
      branch: decision.branch,
      kind: registryKind(decision.branch),
      provisional: false,
      createdAt: context.now.toISOString(),
    });
    return success(decision, decision.path, current, findLease(context, ref), [
      "this task already has a workspace; all sessions share one working tree",
    ]);
  }

  // create
  if (fs.existsSync(decision.path)) {
    return workspaceFailure(
      "WORKSPACE_TARGET_EXISTS",
      `target worktree path already exists: ${decision.path}`,
      "remove the directory or bind the existing workspace with `phronia task workspace bind`",
    );
  }
  const checkedOut = worktreeOnBranch(context, decision.branch);
  if (checkedOut !== null) {
    return workspaceFailure(
      "WORKSPACE_TARGET_EXISTS",
      `branch ${decision.branch} is already checked out at ${checkedOut}`,
      "use the existing worktree or remove it before creating a new one",
    );
  }

  if (options.copyTask !== true) {
    const visible = taskArtifactsVisible(context, ref, decision.base);
    if (!visible) {
      const id = view.id;
      return workspaceFailure(
        "TASK_ARTIFACTS_UNCOMMITTED",
        `task artifacts for ${ref} are not on ${decision.base}; a new worktree would not see prd/design/implement`,
        `commit them first: git add .phronia/tasks/${id} && git commit -m "chore(task): plan ${id}"; or re-run with --copy-task`,
        { taskRef: ref, base: decision.base },
      );
    }
  }

  try {
    context.git.worktreeAdd({
      cwd: context.mainRoot,
      path: decision.path,
      branch: decision.branch,
      base: decision.base,
      createBranch: true,
    });
  } catch (error) {
    return workspaceFailure(
      "GIT_FAILED",
      `cannot create worktree at ${decision.path}: ${gitDetail(error)}`,
      "fix the git error and retry `phronia task workspace ensure`",
    );
  }

  upsertRegistryEntry(context, {
    taskRef: ref,
    path: decision.path,
    branch: decision.branch,
    kind: "phronia",
    provisional: false,
    createdAt: context.now.toISOString(),
  });
  fs.mkdirSync(path.join(decision.path, ".phronia", ".runtime"), { recursive: true });

  if (options.copyTask === true) {
    const copied = copyPath(
      path.join(context.mainRoot, ref),
      path.join(decision.path, ref),
    );
    if (!copied) {
      return workspaceFailure(
        "WORKTREE_COPY_FAILED",
        `worktree created but the task directory could not be copied to ${decision.path}`,
        `copy it manually: cp -R ${ref} ${path.join(decision.path, ref)}`,
      );
    }
  }

  const post = applyCopyAndPostCreate(context, decision.path, {
    copy: options.copy,
    postCreate: options.postCreate,
  });
  if (!post.ok) {
    return workspaceFailure(post.code, post.message, post.next, {
      workspace: decision.path,
    });
  }

  // A task that works in its own worktree must not hold the main checkout
  // claim; keeping the session's existing claim unchanged preserves the
  // workspace claim -> integration lock ordering in W4.
  return success(decision, decision.path, current, findLease(context, ref), [
    `worktree ready: ${decision.path}`,
    "start a new agent session in that directory (or use your platform's worktree launch)",
  ]);
}

export function bindWorkspace(options: BindWorkspaceOptions): WorkspaceResult {
  let context: WorkspaceContext;
  try {
    context = loadContext(options, true);
  } catch (error) {
    return gitFailure(error);
  }
  const ref = canonicalRef(options.taskRef);
  const target = path.resolve(options.path ?? context.cwd);
  const entry = context.registryLoad.registry.worktrees.find(
    (candidate) => comparablePath(candidate.path) === comparablePath(target),
  );
  if (entry === undefined) {
    const bound = context.registryLoad.registry.worktrees.find(
      (candidate) => canonicalRef(candidate.taskRef) === ref,
    );
    if (bound !== undefined) {
      return {
        ok: true,
        decision: { kind: "attach", path: bound.path, branch: bound.branch, reason: "already bound" },
        workspace: bound.path,
        claim: readClaim(context),
        lease: findLease(context, ref),
        warnings: [],
      };
    }
    return workspaceFailure(
      "WORKSPACE_BIND_INVALID",
      `no provisional workspace is registered at ${target}`,
      "run this inside the provisional worktree, or pass --path <dir>",
    );
  }
  if (entry.taskRef !== "" && canonicalRef(entry.taskRef) !== ref) {
    return workspaceFailure(
      "WORKSPACE_BIND_INVALID",
      `workspace at ${entry.path} is already bound to ${entry.taskRef}`,
      "use the existing task or create a new provisional workspace",
    );
  }

  const artifacts = path.join(target, ref, "task.json");
  const visible = fs.existsSync(artifacts);
  const branch = safeBranch(context, target) || entry.branch;
  upsertRegistryEntry(context, {
    ...entry,
    taskRef: ref,
    branch,
    provisional: false,
    kind: entry.kind ?? "phronia",
  });
  const warnings = visible
    ? []
    : [
        `task directory ${ref} is not present in ${target}; commit or copy it before starting work`,
      ];
  return {
    ok: true,
    decision: {
      kind: "attach",
      path: entry.path,
      branch,
      reason: "bound the provisional workspace to the task",
    },
    workspace: entry.path,
    claim: readClaim(context),
    lease: findLease(context, ref),
    warnings,
  };
}

export function releaseWorkspace(options: ReleaseWorkspaceOptions): WorkspaceResult {
  let context: WorkspaceContext;
  try {
    context = loadContext(options, true);
  } catch (error) {
    return gitFailure(error);
  }
  const sessionKey = sessionKeyFor(context, options.sessionKey);
  if (sessionKey === null) return sessionUnknown("release a workspace claim");
  const current = readClaim(context);
  if (current === null) {
    return {
      ok: true,
      decision: {
        kind: "reuse-current",
        reason: "no workspace claim to release",
      },
      workspace: null,
      claim: null,
      lease: null,
      warnings: [],
    };
  }
  if (
    options.force !== true &&
    current.sessionKey !== undefined &&
    current.sessionKey !== sessionKey
  ) {
    return workspaceFailure(
      "WORKSPACE_CLAIM_BUSY",
      `the main checkout is owned by ${describeClaim(current)}`,
      "pass --force to release another session's claim",
      { owner: claimDetails(current) },
    );
  }
  try {
    const store = claimStore(context, () => true);
    store.release({ path: store.path, record: current });
  } catch (error) {
    if (error instanceof LeaseError) {
      return workspaceFailure(error.code, error.message, "inspect the workspace claim file");
    }
    return workspaceFailure(
      "WORKSPACE_CLAIM_BUSY",
      `cannot release the workspace claim: ${errorMessage(error)}`,
      "check permissions on the shared runtime",
    );
  }
  return {
    ok: true,
    decision: {
      kind: "reuse-current",
      reason: `released the workspace claim owned by ${describeClaim(current)}`,
    },
    workspace: null,
    claim: null,
    lease: null,
    warnings: [],
  };
}

export function reclaimWorkspace(options: ReclaimWorkspaceOptions): WorkspaceResult {
  let context: WorkspaceContext;
  try {
    context = loadContext(options, true);
  } catch (error) {
    return gitFailure(error);
  }
  const sessionKey = sessionKeyFor(context, options.sessionKey);
  if (sessionKey === null) return sessionUnknown("reclaim the workspace claim");
  const current = readClaim(context);
  if (current === null) {
    return {
      ok: true,
      decision: { kind: "reuse-current", reason: "no workspace claim to reclaim" },
      workspace: null,
      claim: null,
      lease: null,
      warnings: [],
    };
  }
  if (!isLeaseStale(current, context.now, { liveness: "ttl" })) {
    return workspaceFailure(
      "WORKSPACE_CLAIM_BUSY",
      `the claim from ${describeClaim(current)} is still fresh`,
      "wait for it to expire, or finish the owning task",
      { owner: claimDetails(current) },
    );
  }
  if (isMainDirty(context)) {
    return workspaceFailure(
      "WORKSPACE_CLAIM_STALE_DIRTY",
      `the stale claim from ${describeClaim(current)} left uncommitted changes; never reclaim automatically`,
      "reach the previous owner or commit/stash the changes in the main checkout",
      { owner: claimDetails(current) },
    );
  }
  const acquired = tryAcquireClaim(context, {
    sessionKey,
    ownerRef: `session:${sessionKey}`,
    taskRef: null,
    state: "planning",
    reclaim: true,
    ttlSeconds: options.ttlSeconds,
  });
  if (!acquired.claimed) {
    return workspaceFailure(
      "WORKSPACE_CLAIM_BUSY",
      `another process reclaimed the checkout first${
        acquired.busy === null ? "" : ` (${describeClaim(acquired.busy)})`
      }`,
      "retry `phronia task workspace prepare`",
      acquired.busy === null ? undefined : { owner: claimDetails(acquired.busy) },
    );
  }
  return {
    ok: true,
    decision: {
      kind: "reuse-current",
      reason: `reclaimed the stale claim from ${describeClaim(current)}`,
    },
    workspace: context.mainRoot,
    claim: acquired.claim,
    lease: null,
    warnings: [`reclaimed ${describeClaim(current)}`],
  };
}

// ---------------------------------------------------------------------------
// worktree add / list / attach / remove / prune
// ---------------------------------------------------------------------------

export function addWorktree(taskRef: string, options: WorktreeOptions): WorktreeResult {
  let context: WorkspaceContext;
  try {
    context = loadContext(options, true);
  } catch (error) {
    return worktreeFailureFromError(error);
  }
  const view = readTaskRecord(context, taskRef);
  if (view === null) {
    return worktreeFailure("TASK_NOT_FOUND", `task not found: ${taskRef}`, "create the task first");
  }
  if (view.status === "completed") {
    return worktreeFailure(
      "TASK_COMPLETED",
      `task is already completed: ${view.id}`,
      "archive the task or create a new one",
    );
  }
  const ref = viewRef(context, view);
  const existingEntry = context.registryLoad.registry.worktrees.find(
    (entry) => canonicalRef(entry.taskRef) === ref,
  );
  if (existingEntry !== undefined && fs.existsSync(existingEntry.path)) {
    return worktreeFailure(
      "WORKSPACE_TARGET_EXISTS",
      `task already has a worktree at ${existingEntry.path}`,
      "use `phronia task worktree remove` first, or attach it",
    );
  }
  const legacyPath = legacyWorktreePath(view);
  if (legacyPath !== null && fs.existsSync(legacyPath)) {
    return worktreeFailure(
      "WORKSPACE_TARGET_EXISTS",
      `task already has a worktree at ${legacyPath}`,
      "use `phronia task worktree remove` first, or run `phronia task worktree attach`",
    );
  }
  if (!options.force && isMainDirty(context)) {
    return worktreeFailure(
      "WORKSPACE_DIRTY_UNCLAIMED",
      "main checkout has uncommitted changes; commit them or pass --force",
      "commit/stash the changes, or re-run with --force",
    );
  }
  if (isBare(context)) {
    return worktreeFailure(
      "GIT_FAILED",
      "cannot create a worktree from a bare repository",
      "create the worktree from a normal checkout",
    );
  }

  const slug = worktreeSlug({ ref, id: view.id });
  const target =
    options.path !== undefined
      ? path.resolve(options.cwd, options.path)
      : hardenedPath(
          worktreeDirectory(context),
          slug,
          `${slug}-${shortHash(ref)}`,
          context,
        );
  if (fs.existsSync(target)) {
    return worktreeFailure(
      "WORKSPACE_TARGET_EXISTS",
      `target path already exists: ${target}`,
      "remove the directory or choose another --path",
    );
  }
  const branch = options.branch ?? view.branch ?? `phronia/${slug}`;
  const checkedOut = worktreeOnBranch(context, branch);
  if (checkedOut !== null) {
    return worktreeFailure(
      "WORKSPACE_TARGET_EXISTS",
      `branch ${branch} is already checked out at ${checkedOut}`,
      "use the existing worktree or remove it first",
    );
  }
  const base = resolveBase(context, view, options.base);
  if (!base.ok) return worktreeFailure(base.code, base.message, base.next);

  const branchExists = refExists(context, `refs/heads/${branch}`);
  try {
    context.git.worktreeAdd({
      cwd: context.mainRoot,
      path: target,
      branch,
      ...(branchExists ? {} : { base: base.base, createBranch: true }),
    });
  } catch (error) {
    return worktreeFailure(
      "GIT_FAILED",
      `cannot create worktree: ${gitDetail(error)}`,
      "fix the git error and retry",
    );
  }

  const record: WorktreeRecord = {
    taskRef: ref,
    taskId: view.id,
    path: target,
    branch,
    createdAt: context.now.toISOString(),
    kind: "phronia",
  };
  upsertRegistryEntry(context, {
    taskRef: ref,
    path: target,
    branch,
    kind: "phronia",
    provisional: false,
    createdAt: record.createdAt,
  });
  fs.mkdirSync(path.join(target, ".phronia", ".runtime"), { recursive: true });

  const post = applyCopyAndPostCreate(context, target, {
    copy: options.copy,
    postCreate: options.postCreate,
  });
  if (!post.ok) {
    return worktreeFailure(post.code, post.message, post.next, { record });
  }
  return {
    ok: true,
    message: `worktree ready: ${target} (${branch})`,
    record,
  };
}

export function listWorktrees(options: {
  cwd: string;
  git?: GitPort;
  includeMissing?: boolean;
}): WorktreeRecord[] {
  let context: WorkspaceContext;
  try {
    context = loadContext(
      {
        cwd: options.cwd,
        ...(options.git === undefined ? {} : { git: options.git }),
      },
      false,
    );
  } catch {
    return [];
  }
  const records = context.registryLoad.registry.worktrees.map((entry) => toRecord(entry));
  const filtered =
    options.includeMissing === true
      ? records
      : records.filter((record) => fs.existsSync(record.path));
  return filtered.sort((left, right) => left.taskRef.localeCompare(right.taskRef));
}

export function attachWorktree(
  taskRef: string,
  options: AttachWorktreeOptions,
): AttachWorktreeResult {
  let context: WorkspaceContext;
  try {
    context = loadContext(options, true);
  } catch (error) {
    return worktreeFailureFromError(error);
  }
  const view = readTaskRecord(context, taskRef);
  if (view === null) {
    return worktreeFailure("TASK_NOT_FOUND", `task not found: ${taskRef}`, "create the task first");
  }
  const ref = viewRef(context, view);
  const target = path.resolve(options.path ?? context.cwd);
  const validated = validateAttachTarget(context, view, ref, target);
  if (!validated.ok) {
    return worktreeFailure(validated.code, validated.message, validated.next);
  }
  const worktree = validated.worktree;
  upsertRegistryEntry(context, {
    taskRef: ref,
    path: worktree.path,
    branch: worktree.branch,
    kind: "platform",
    provisional: false,
    createdAt: context.now.toISOString(),
  });
  const record: WorktreeRecord = {
    taskRef: ref,
    taskId: view.id,
    path: worktree.path,
    branch: worktree.branch,
    createdAt: context.now.toISOString(),
    kind: "platform",
  };
  return {
    ok: true,
    message: `registered platform worktree: ${worktree.path} (${worktree.branch})`,
    record,
  };
}

export function removeWorktree(
  taskRef: string,
  options: WorktreeOptions,
): WorktreeResult {
  let context: WorkspaceContext;
  try {
    context = loadContext(options, true);
  } catch (error) {
    return worktreeFailureFromError(error);
  }
  const view = readTaskRecord(context, taskRef);
  if (view === null) {
    return worktreeFailure("TASK_NOT_FOUND", `task not found: ${taskRef}`, "check the task ref");
  }
  const ref = viewRef(context, view);
  const entry = context.registryLoad.registry.worktrees.find(
    (candidate) => canonicalRef(candidate.taskRef) === ref,
  );
  const legacy = legacyWorktreePath(view);
  const target = entry?.path ?? legacy ?? "";
  if (target === "" || !fs.existsSync(target)) {
    return worktreeFailure(
      "WORKSPACE_NOT_FOUND",
      `task has no worktree: ${view.id}`,
      "nothing to remove",
    );
  }
  if (!options.force && !isClean(context.git, target)) {
    return worktreeFailure(
      "INTEGRATE_DIRTY_CHECKOUT",
      "worktree has uncommitted changes; commit them or pass --force",
      "commit/stash the changes, or re-run with --force",
    );
  }
  try {
    context.git.worktreeRemove({
      cwd: context.mainRoot,
      path: target,
      force: options.force === true,
    });
  } catch (error) {
    return worktreeFailure(
      "GIT_FAILED",
      `cannot remove worktree: ${gitDetail(error)}`,
      "close processes using the directory and retry",
    );
  }
  const branch = entry?.branch ?? (typeof view.raw.branch === "string" ? view.raw.branch : "");
  if (options.deleteBranch === true && branch !== "") {
    const deleted = deleteBranch(context, branch, options.force === true);
    if (!deleted.ok) {
      return worktreeFailure(
        "GIT_FAILED",
        `worktree removed, branch not deleted: ${deleted.detail}`,
        `delete it manually with git branch ${options.force ? "-D" : "-d"} ${branch}`,
      );
    }
  }
  removeRegistryEntry(context, ref, target);
  return { ok: true, message: `worktree removed: ${target}` };
}

export function pruneWorktrees(options: PruneOptions): PruneResult {
  let context: WorkspaceContext;
  try {
    context = loadContext({ ...options, writeRegistry: options.dryRun !== true }, options.dryRun !== true);
  } catch (error) {
    return {
      ok: false,
      dryRun: options.dryRun === true,
      removed: [],
      kept: [],
      message: errorMessage(error),
    };
  }
  const requestedAge = parseDuration(options.olderThan);
  if (options.olderThan !== undefined && requestedAge === null) {
    return {
      ok: false,
      dryRun: options.dryRun === true,
      removed: [],
      kept: [],
      message: `invalid --older-than value: ${options.olderThan}`,
    };
  }

  const integration = localIntegrationRef(context);
  const origin = hasOrigin(context);
  const removed: WorktreeRecord[] = [];
  const kept: PruneKept[] = [];
  const allTasks = new Map(
    openState({ root: context.mainRoot })
      .tasks.list({ includeArchived: true })
      .flatMap((task) => {
        const ref = canonicalRef(task.ref);
        return [
          [ref, task] as const,
          [basename(ref), task] as const,
        ];
      }),
  );

  for (const entry of context.registryLoad.registry.worktrees) {
    const record = toRecord(entry);
    if (!fs.existsSync(entry.path)) {
      if (options.dryRun !== true) removeRegistryEntry(context, entry.taskRef, entry.path);
      kept.push({ taskRef: entry.taskRef, path: entry.path, reason: "path is missing" });
      continue;
    }
    const ageOk =
      requestedAge === null
        ? true
        : ageExceeds(entry.createdAt ?? "", requestedAge, context.now);
    if (!ageOk) {
      kept.push({ taskRef: entry.taskRef, path: entry.path, reason: "younger than --older-than" });
      continue;
    }
    if (!isClean(context.git, entry.path)) {
      kept.push({ taskRef: entry.taskRef, path: entry.path, reason: "dirty" });
      continue;
    }

    const ref = canonicalRef(entry.taskRef);
    if (ref === "") {
      if (requestedAge === null) {
        kept.push({ taskRef: entry.taskRef, path: entry.path, reason: "provisional (pass --older-than)" });
        continue;
      }
    } else {
      const summary = allTasks.get(ref) ?? allTasks.get(basename(ref));
      const archived = summary?.archived === true;
      const landed =
        integrationOutcome(context, summary?.ref ?? ref) === "landed";
      if (!archived && !landed) {
        kept.push({ taskRef: entry.taskRef, path: entry.path, reason: "not archived or landed" });
        continue;
      }
    }

    const worktree = gitWorktree(context, entry.path);
    if (worktree?.head !== null && worktree?.head !== undefined) {
      if (integration === null || !isAncestor(context, worktree.head, integration)) {
        kept.push({ taskRef: entry.taskRef, path: entry.path, reason: "unmerged" });
        continue;
      }
      if (origin && !isPushed(context, entry.branch, worktree.head)) {
        kept.push({ taskRef: entry.taskRef, path: entry.path, reason: "unpushed" });
        continue;
      }
    }

    if (options.dryRun !== true) {
      try {
        context.git.worktreeRemove({
          cwd: context.mainRoot,
          path: entry.path,
          force: false,
        });
      } catch (error) {
        kept.push({
          taskRef: entry.taskRef,
          path: entry.path,
          reason: `remove failed: ${gitDetail(error)}`,
        });
        continue;
      }
      if (options.deleteBranch === true && entry.branch !== "") {
        deleteBranch(context, entry.branch, false);
      }
      removeRegistryEntry(context, entry.taskRef, entry.path);
    }
    removed.push(record);
  }

  if (options.dryRun !== true) {
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: context.mainRoot,
        stdio: "ignore",
        timeout: 15_000,
      });
    } catch {
      // Metadata pruning is best effort; the registry is the diagnostic view.
    }
  }

  return {
    ok: true,
    dryRun: options.dryRun === true,
    removed,
    kept,
    message: `${options.dryRun === true ? "would remove" : "removed"} ${
      removed.length
    } worktree(s); kept ${kept.length}`,
  };
}

// ---------------------------------------------------------------------------
// claim helpers
// ---------------------------------------------------------------------------

interface ClaimAcquireInput {
  readonly sessionKey: string;
  readonly ownerRef: string;
  readonly taskRef: string | null;
  readonly state: string;
  readonly reclaim: boolean;
  readonly ttlSeconds?: number;
}

interface ClaimAcquireResult {
  readonly claimed: boolean;
  readonly claim: WorkspaceClaimRecord | null;
  readonly busy: WorkspaceClaimRecord | null;
}

function tryAcquireClaim(
  context: WorkspaceContext,
  input: ClaimAcquireInput,
): ClaimAcquireResult {
  const store = claimStore(
    context,
    input.reclaim ? () => true : () => false,
    input.ttlSeconds,
  );
  const branch = safeBranch(context, context.mainRoot);
  const record: WorkspaceClaimRecord = {
    schemaVersion: 1,
    ownerType: input.taskRef === null ? "session" : "task",
    ownerRef: input.ownerRef,
    sessionKey: input.sessionKey,
    taskRef: input.taskRef,
    workspace: context.mainRoot,
    branch,
    host: context.host,
    pid: context.pid,
    state: input.state,
    acquiredAt: context.now.toISOString(),
    heartbeatAt: context.now.toISOString(),
    ttlSeconds: input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS,
  };
  try {
    const result = store.acquire(record);
    if ("busy" in result) {
      return { claimed: false, claim: null, busy: result.busy };
    }
    return { claimed: true, claim: result.record, busy: null };
  } catch (error) {
    if (error instanceof LeaseError) {
      return { claimed: false, claim: null, busy: readClaim(context) };
    }
    throw error;
  }
}

function claimStore(
  context: WorkspaceContext,
  reclaimWhen: (record: WorkspaceClaimRecord) => boolean,
  ttlSeconds?: number,
): LeaseStore<WorkspaceClaimRecord> {
  return createLeaseStore<WorkspaceClaimRecord>({
    path: context.paths.workspaceClaim,
    now: context.nowFn,
    host: context.host,
    pid: context.pid,
    defaultTtlSeconds: ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS,
    liveness: "ttl",
    reclaimWhen: (record, at) =>
      reclaimWhen(record) &&
      isLeaseStale(record, at, { liveness: "ttl" }),
  });
}

function heartbeatClaim(
  context: WorkspaceContext,
  claim: WorkspaceClaimRecord,
  patch: Partial<WorkspaceClaimRecord>,
): WorkspaceClaimRecord {
  try {
    const store = createLeaseStore<WorkspaceClaimRecord>({
      path: context.paths.workspaceClaim,
      now: context.nowFn,
      host: context.host,
      pid: context.pid,
      defaultTtlSeconds: claim.ttlSeconds,
      liveness: "ttl",
    });
    const handle: LeaseHandle<WorkspaceClaimRecord> = {
      path: store.path,
      record: claim,
    };
    store.heartbeat(handle, patch);
    return handle.record;
  } catch {
    return claim;
  }
}

function claimForTask(
  context: WorkspaceContext,
  current: WorkspaceClaimRecord | null,
  ref: string,
  status: string,
  sessionKey: string,
): { ok: true; claim: WorkspaceClaimRecord } | { ok: false; failure: WorkspaceFailure } {
  if (current !== null && canonicalRefOrNull(current.taskRef) === ref) {
    return {
      ok: true,
      claim: heartbeatClaim(context, current, { state: status }),
    };
  }
  if (
    current !== null &&
    current.taskRef === null &&
    current.sessionKey === sessionKey
  ) {
    return {
      ok: true,
      claim: heartbeatClaim(context, current, {
        ownerType: "task",
        ownerRef: `task:${ref}`,
        taskRef: ref,
        state: status,
      }),
    };
  }
  if (current === null) {
    const acquired = tryAcquireClaim(context, {
      sessionKey,
      ownerRef: `task:${ref}`,
      taskRef: ref,
      state: status,
      reclaim: false,
    });
    if (acquired.claimed && acquired.claim !== null) {
      return { ok: true, claim: acquired.claim };
    }
    return {
      ok: false,
      failure: workspaceFailure(
        "WORKSPACE_CLAIM_BUSY",
        `another session claimed the main checkout first${
          acquired.busy === null ? "" : ` (${describeClaim(acquired.busy)})`
        }`,
        "re-run `phronia task workspace ensure` to create a worktree",
        acquired.busy === null ? undefined : { owner: claimDetails(acquired.busy) },
      ),
    };
  }
  return {
    ok: false,
    failure: workspaceFailure(
      "WORKSPACE_CLAIM_BUSY",
      `the main checkout is owned by ${describeClaim(current)}`,
      "finish the owning task, or run `phronia task workspace prepare --for-new-task`",
      { owner: claimDetails(current) },
    ),
  };
}

function readClaim(context: WorkspaceContext): WorkspaceClaimRecord | null {
  const read = readRuntimeJson<WorkspaceClaimRecord>(context.paths.workspaceClaim);
  if (!read.ok || read.value === null) return null;
  if (typeof read.value.ownerRef !== "string" || typeof read.value.workspace !== "string") {
    return null;
  }
  return {
    ...read.value,
    heartbeatAt:
      typeof read.value.heartbeatAt === "string"
        ? read.value.heartbeatAt
        : read.value.acquiredAt,
    ttlSeconds:
      typeof read.value.ttlSeconds === "number" && read.value.ttlSeconds > 0
        ? read.value.ttlSeconds
        : DEFAULT_CLAIM_TTL_SECONDS,
  };
}

function toPolicyClaim(
  context: WorkspaceContext,
  claim: WorkspaceClaimRecord | null,
  ownerStatus: string | null,
  sessionKey: string,
): WorkspaceClaim | null {
  if (claim === null) return null;
  return {
    ownerType: claim.ownerType,
    ownerRef: claim.ownerRef,
    taskRef: claim.taskRef,
    workspace: claim.workspace,
    state: claim.state,
    host: claim.host,
    heartbeatAt: claim.heartbeatAt,
    ttlSeconds: claim.ttlSeconds,
    stale: isLeaseStale(claim, context.now, { liveness: "ttl" }),
    ownedByCurrent: claim.sessionKey === sessionKey,
    ownerActive:
      ownerStatus !== null && ACTIVE_TASK_STATUSES.has(ownerStatus),
  };
}

// ---------------------------------------------------------------------------
// context / registry helpers
// ---------------------------------------------------------------------------

function loadContext(
  options: WorkspaceDependencies,
  writeRegistry: boolean,
): WorkspaceContext {
  const cwd = path.resolve(options.cwd);
  const gitPort = options.git ?? createGitPort();
  const mainRoot = gitPort.mainWorktreeRoot(cwd);
  const resolution = resolveSharedRuntime({ cwd: mainRoot, git: gitPort });
  ensureSharedRuntime(resolution.paths);
  const state = openState({ root: mainRoot, ...(options.env === undefined ? {} : { env: options.env }) });
  const registryLoad = loadWorktreeRegistry({
    projectRoot: mainRoot,
    paths: resolution.paths,
    git: gitPort,
    write: writeRegistry,
  });
  const nowFn = options.now ?? ((): Date => new Date());
  return {
    cwd,
    mainRoot,
    git: gitPort,
    config: state.config(),
    paths: resolution.paths,
    registryLoad,
    now: nowFn(),
    nowFn,
    host: options.host ?? hostname(),
    pid: options.pid ?? process.pid,
    env: options.env ?? process.env,
    writeRegistry,
  };
}

function upsertRegistryEntry(
  context: WorkspaceContext,
  entry: WorktreeRegistryEntry,
): void {
  if (!context.writeRegistry) return;
  const entries = context.registryLoad.registry.worktrees.filter(
    (candidate) =>
      canonicalRef(candidate.taskRef) !== canonicalRef(entry.taskRef) ||
      entry.taskRef === "",
  );
  const deduped = entries.filter(
    (candidate) => comparablePath(candidate.path) !== comparablePath(entry.path),
  );
  const next = [...deduped, entry];
  const write = writeRuntimeJson(context.paths.worktrees, {
    schemaVersion: 1,
    worktrees: next,
  });
  if (write.ok) {
    context.registryLoad.registry.worktrees = next;
  }
}

function removeRegistryEntry(
  context: WorkspaceContext,
  taskRef: string,
  entryPath: string,
): void {
  if (!context.writeRegistry) return;
  const next = context.registryLoad.registry.worktrees.filter(
    (candidate) =>
      canonicalRef(candidate.taskRef) !== canonicalRef(taskRef) &&
      comparablePath(candidate.path) !== comparablePath(entryPath),
  );
  const write = writeRuntimeJson(context.paths.worktrees, {
    schemaVersion: 1,
    worktrees: next,
  });
  if (write.ok) {
    context.registryLoad.registry.worktrees = next;
  }
}

function enrichWithLegacy(
  context: WorkspaceContext,
  entries: readonly WorktreeRegistryEntry[],
  view: TaskRecordView,
  ref: string,
): WorktreeRegistryEntry[] {
  const result = [...entries];
  if (result.some((entry) => canonicalRef(entry.taskRef) === ref)) return result;
  const legacy = legacyWorktreePath(view);
  if (legacy === null || !fs.existsSync(legacy)) return result;
  result.push({
    taskRef: ref,
    path: legacy,
    branch:
      typeof view.raw.branch === "string" && view.raw.branch !== ""
        ? view.raw.branch
        : `phronia/${worktreeSlug({ ref, id: view.id })}`,
    kind: "phronia",
    provisional: false,
    createdAt: "",
  });
  return result;
}

function legacyWorktreePath(view: TaskRecordView): string | null {
  const value = view.raw.worktree_path;
  return typeof value === "string" && value !== "" ? value : null;
}

function validateAttachTarget(
  context: WorkspaceContext,
  view: TaskRecordView,
  ref: string,
  inputPath: string,
):
  | { ok: true; worktree: WorkspaceWorktree }
  | { ok: false; code: string; message: string; next: string } {
  const target = path.resolve(inputPath);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return {
      ok: false,
      code: "WORKSPACE_ATTACH_INVALID",
      message: `path is not a directory: ${target}`,
      next: "pass the root of an existing git worktree",
    };
  }
  const worktrees = context.git.worktreeList(context.mainRoot);
  const match = worktrees.find(
    (worktree) => comparablePath(worktree.path) === comparablePath(target),
  );
  if (match === undefined) {
    return {
      ok: false,
      code: "WORKSPACE_ATTACH_INVALID",
      message: `${target} is not a registered git worktree of this repository`,
      next: `check \`git worktree list\` from ${context.mainRoot}`,
    };
  }
  if (comparablePath(match.path) === comparablePath(context.mainRoot)) {
    return {
      ok: false,
      code: "WORKSPACE_ATTACH_INVALID",
      message: "the main worktree cannot be attached as a task workspace",
      next: "run `phronia task workspace prepare` to use the main checkout instead",
    };
  }
  const actualBranch = match.branch ?? safeBranch(context, target);
  const expected = view.branch ?? `phronia/${worktreeSlug({ ref, id: view.id })}`;
  if (actualBranch === "" || match.detached) {
    return {
      ok: false,
      code: "WORKSPACE_ATTACH_INVALID",
      message: `${target} is a detached worktree; a task worktree must have a branch`,
      next: `checkout ${expected} in that worktree, or create one with \`phronia task worktree add\``,
    };
  }
  if (actualBranch !== expected) {
    return {
      ok: false,
      code: "WORKSPACE_ATTACH_INVALID",
      message: `branch mismatch: expected ${expected}, found ${actualBranch}`,
      next: "checkout the task branch in that worktree, or update task.branch",
    };
  }
  return {
    ok: true,
    worktree: { path: target, branch: actualBranch, kind: "platform" },
  };
}

function toWorkspaceWorktree(entry: WorktreeRegistryEntry): WorkspaceWorktree {
  return {
    path: entry.path,
    branch: entry.branch,
    kind: entry.kind === "platform" ? "platform" : "phronia",
    provisional: entry.provisional === true,
    taskRef: entry.taskRef === "" ? null : canonicalRef(entry.taskRef),
  };
}

function registryKind(branch: string): "phronia" | "platform" {
  return branch.startsWith("phronia/") ? "phronia" : "platform";
}

function toRecord(entry: WorktreeRegistryEntry): WorktreeRecord {
  return {
    taskRef: canonicalRef(entry.taskRef),
    taskId: entry.taskId ?? basename(entry.taskRef),
    path: entry.path,
    branch: entry.branch,
    createdAt: entry.createdAt ?? "",
    kind: entry.kind === "platform" ? "platform" : "phronia",
    ...(entry.provisional === true ? { provisional: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// git helpers (thin wrappers over GitPort; branch deletion is the one gap)
// ---------------------------------------------------------------------------

function resolveBase(
  context: WorkspaceContext,
  view: TaskRecordView,
  explicit: string | undefined,
): { ok: true; base: string } | { ok: false; code: string; message: string; next: string } {
  if (explicit !== undefined && explicit !== "") {
    return { ok: true, base: explicit };
  }
  if (view.baseBranch !== null && view.baseBranch !== "") {
    return { ok: true, base: view.baseBranch };
  }
  const originHead = resolveOriginHead(context);
  if (originHead !== null) {
    return { ok: true, base: originHead };
  }
  const integration = localIntegrationRef(context);
  const current = safeBranch(context, context.mainRoot);
  if (integration !== null && current === integration) {
    return { ok: true, base: current };
  }
  return {
    ok: false,
    code: "WORKTREE_BASE_UNRESOLVED",
    message:
      "cannot determine the base branch (no --base, task.base_branch, origin/HEAD, or matching integration branch)",
    next: "pass --base <branch> explicitly",
  };
}

function integrationBase(
  context: WorkspaceContext,
  view: TaskRecordView | null,
): string {
  const configured = context.config.parallel.integration.branch;
  if (configured !== null && configured !== "") return configured;
  if (view?.baseBranch != null && view.baseBranch !== "") return view.baseBranch;
  const origin = resolveOriginHead(context);
  if (origin !== null) return origin;
  return localIntegrationRef(context) ?? "main";
}

function localIntegrationRef(context: WorkspaceContext): string | null {
  const configured = context.config.parallel.integration.branch;
  if (configured !== null && configured !== "") {
    return refExists(context, `refs/heads/${configured}`) ? configured : null;
  }
  for (const candidate of ["main", "master"]) {
    if (refExists(context, `refs/heads/${candidate}`)) return candidate;
  }
  const current = safeBranch(context, context.mainRoot);
  return current === "" ? null : current;
}

function resolveOriginHead(context: WorkspaceContext): string | null {
  for (const candidate of ["origin/main", "origin/master"]) {
    if (refExists(context, `refs/remotes/${candidate}`)) return candidate;
  }
  return null;
}

function hasOrigin(context: WorkspaceContext): boolean {
  return (
    refExists(context, "refs/remotes/origin/HEAD") ||
    resolveOriginHead(context) !== null
  );
}

function isPushed(context: WorkspaceContext, branch: string, head: string): boolean {
  if (branch === "") return false;
  try {
    return context.git.resolveRef(context.mainRoot, `refs/remotes/origin/${branch}`) === head;
  } catch {
    return false;
  }
}

function isAncestor(context: WorkspaceContext, ancestor: string, ref: string): boolean {
  try {
    return context.git.isAncestor(context.mainRoot, ancestor, ref);
  } catch {
    return false;
  }
}

function gitWorktree(context: WorkspaceContext, target: string): WorktreeInfo | null {
  try {
    return (
      context.git
        .worktreeList(context.mainRoot)
        .find((worktree) => comparablePath(worktree.path) === comparablePath(target)) ??
      null
    );
  } catch {
    return null;
  }
}

function worktreeOnBranch(context: WorkspaceContext, branch: string): string | null {
  try {
    const match = context.git
      .worktreeList(context.mainRoot)
      .find((worktree) => worktree.branch === branch && !worktree.bare);
    return match?.path ?? null;
  } catch {
    return null;
  }
}

function refExists(context: WorkspaceContext, ref: string): boolean {
  try {
    context.git.resolveRef(context.mainRoot, ref);
    return true;
  } catch {
    return false;
  }
}

function safeBranch(context: WorkspaceContext, cwd: string): string {
  try {
    return context.git.branch(cwd);
  } catch {
    return "";
  }
}

function isBare(context: WorkspaceContext): boolean {
  try {
    return context.git.isBare(context.mainRoot);
  } catch {
    return false;
  }
}

function isClean(gitPort: GitPort, cwd: string): boolean {
  try {
    return gitPort.status(cwd).clean;
  } catch {
    return false;
  }
}

function isMainDirty(context: WorkspaceContext): boolean {
  return !isClean(context.git, context.mainRoot);
}

function safeDirtyPaths(context: WorkspaceContext): number {
  try {
    return context.git.status(context.mainRoot).dirtyPaths;
  } catch {
    return 1;
  }
}

function deleteBranch(
  context: WorkspaceContext,
  branch: string,
  force: boolean,
): { ok: true } | { ok: false; detail: string } {
  try {
    execFileSync("git", ["branch", force ? "-D" : "-d", branch], {
      cwd: context.mainRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: (error as { stderr?: string }).stderr?.trim() ?? errorMessage(error),
    };
  }
}

// ---------------------------------------------------------------------------
// task / artifacts helpers
// ---------------------------------------------------------------------------

function viewRef(context: WorkspaceContext, view: TaskRecordView): string {
  const relative = path.relative(context.mainRoot, view.dir);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return canonicalRef(relative);
  }
  const ref = canonicalRef(view.ref);
  if (ref.startsWith(".phronia/") || path.isAbsolute(ref)) return ref;
  return canonicalRef(`.phronia/tasks/${view.id}`);
}

function readTaskRecord(
  context: WorkspaceContext,
  taskRef: string,
): TaskRecordView | null {
  const state = openState({ root: context.mainRoot });
  const main = state.tasks.read(taskRef);
  if (main !== null) return main;
  // Branch-local task: resolve through the shared registry.
  const ref = canonicalRef(taskRef);
  const entry = context.registryLoad.registry.worktrees.find(
    (candidate) => canonicalRef(candidate.taskRef) === ref,
  );
  if (entry === undefined) return null;
  const dir = path.isAbsolute(ref) ? ref : path.join(entry.path, ref);
  const file = path.join(dir, "task.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      ref,
      dir,
      id: typeof raw.id === "string" ? raw.id : basename(ref),
      name: typeof raw.name === "string" ? raw.name : basename(ref),
      title: typeof raw.title === "string" ? raw.title : basename(ref),
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

function taskStatus(context: WorkspaceContext, taskRef: string): string | null {
  return openState({ root: context.mainRoot }).tasks.read(taskRef)?.status ?? null;
}

function taskArtifactsVisible(
  context: WorkspaceContext,
  ref: string,
  base: string,
): boolean {
  try {
    context.git.resolveRef(context.mainRoot, `${base}:${ref}/task.json`);
    return true;
  } catch {
    return false;
  }
}

function integrationOutcome(context: WorkspaceContext, ref: string): string {
  const view = openState({ root: context.mainRoot }).tasks.read(ref);
  const meta = view?.meta ?? {};
  const integration = isRecord(meta.integration) ? meta.integration : {};
  return typeof integration.outcome === "string" ? integration.outcome : "none";
}

// ---------------------------------------------------------------------------
// copy / post-create
// ---------------------------------------------------------------------------

function applyCopyAndPostCreate(
  context: WorkspaceContext,
  target: string,
  options: { copy?: readonly string[]; postCreate?: readonly string[] },
): { ok: true } | { ok: false; code: string; message: string; next: string } {
  const copy = options.copy ?? context.config.parallel.copy;
  const postCreate = options.postCreate ?? context.config.parallel.postCreate;

  for (const relative of copy) {
    const source = path.resolve(context.mainRoot, relative);
    const destination = path.resolve(target, relative);
    if (!fs.existsSync(source)) continue;
    try {
      fs.cpSync(source, destination, { recursive: true, force: true });
    } catch (error) {
      return {
        ok: false,
        code: "WORKTREE_COPY_FAILED",
        message: `cannot copy ${relative} into ${target}: ${errorMessage(error)}`,
        next: `copy it manually: cp -R ${source} ${destination}`,
      };
    }
  }

  for (const command of postCreate) {
    const argv = tokenize(command);
    if (argv.length === 0) continue;
    try {
      execFileSync(argv[0], argv.slice(1), {
        cwd: target,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: COMMAND_TIMEOUT_MS,
      });
    } catch {
      return {
        ok: false,
        code: "WORKTREE_POST_CREATE_FAILED",
        message: `post-create command failed in ${target}: ${command}`,
        next: `fix the command and retry, or remove the worktree with \`phronia task worktree remove\``,
      };
    }
  }
  return { ok: true };
}

/** Minimal quote-aware tokenizer; no shell expansion is performed. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function copyPath(source: string, destination: string): boolean {
  try {
    fs.cpSync(source, destination, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// misc helpers
// ---------------------------------------------------------------------------

function success(
  decision: WorkspaceDecision,
  workspace: string | null,
  claim: WorkspaceClaimRecord | null,
  lease: TaskLease | null,
  warnings: readonly string[] = [],
): WorkspaceSuccess {
  return { ok: true, decision, workspace, claim, lease, warnings };
}

function findLease(context: WorkspaceContext, ref: string): TaskLease | null {
  return (
    listTaskLeases({ cwd: context.mainRoot, git: context.git }).find(
      (lease) => canonicalRef(lease.taskRef) === canonicalRef(ref),
    ) ?? null
  );
}

function worktreeDirectory(context: WorkspaceContext): string {
  const configured = context.config.parallel.worktreeDir;
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.join(context.mainRoot, configured);
}

function hardenedPath(
  directory: string,
  primary: string,
  fallback: string,
  context: WorkspaceContext,
): string {
  const candidate = path.join(directory, primary);
  const taken =
    fs.existsSync(candidate) ||
    context.registryLoad.registry.worktrees.some(
      (entry) => comparablePath(entry.path) === comparablePath(candidate),
    );
  return path.join(directory, taken ? fallback : primary);
}

function comparablePath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function canonicalRef(ref: string): string {
  let value = ref.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value.startsWith("tasks/")) value = `.phronia/${value}`;
  return value;
}

function canonicalRefOrNull(ref: string | null): string | null {
  return ref === null ? null : canonicalRef(ref);
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

function safeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug === "" ? "wip" : slug;
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8).padEnd(8, "0");
}

function sessionKeyFor(
  context: WorkspaceContext,
  explicit: string | undefined,
): string | null {
  const trimmed = explicit?.trim();
  if (trimmed !== undefined && trimmed !== "") return trimmed;
  return resolveSessionKey(context);
}

function resolveSessionKey(context: WorkspaceContext): string | null {
  try {
    const state = openState({ root: context.mainRoot, env: context.env });
    const resolved = state.sessions.resolveKey(undefined, {
      allowEnvironmentContext: true,
    });
    if (resolved.key !== null && resolved.key.trim() !== "") {
      return resolved.key.trim();
    }
  } catch {
    // A missing session identity is a hard error for workspace mutation:
    // short-lived CLI processes cannot use their pid as a stable owner.
  }
  return null;
}

function sessionUnknown(operation: string): WorkspaceFailure {
  return workspaceFailure(
    "WORKSPACE_SESSION_UNKNOWN",
    `no session identity was found; refusing to ${operation} without one`,
    "pass --session-key <key> or set PHRONIA_CONTEXT_ID",
  );
}

function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown-host";
  }
}

function parseDuration(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw])?$/i.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] ?? "d").toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return amount * multipliers[unit];
}

function ageExceeds(
  createdAt: string,
  maxAgeMs: number,
  now: Date,
): boolean {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return now.getTime() - created >= maxAgeMs;
}

function basename(ref: string): string {
  return ref.split("/").filter((part) => part !== "").at(-1) ?? ref;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workspaceFailure(
  code: string,
  message: string,
  next: string,
  details?: Readonly<Record<string, unknown>>,
): WorkspaceFailure {
  return {
    ok: false,
    code,
    message,
    next,
    ...(details === undefined ? {} : { details }),
  };
}

function worktreeFailure(
  code: string,
  message: string,
  next: string,
  extra: { record?: WorktreeRecord; details?: Readonly<Record<string, unknown>> } = {},
): WorktreeResult {
  return {
    ok: false,
    code,
    message,
    next,
    ...(extra.record === undefined ? {} : { record: extra.record }),
    ...(extra.details === undefined ? {} : { details: extra.details }),
  };
}

function worktreeFailureFromError(error: unknown): WorktreeResult {
  if (error instanceof GitError) {
    return worktreeFailure(error.code, error.detail, "run the command inside a git repository");
  }
  return worktreeFailure(
    "GIT_UNAVAILABLE",
    errorMessage(error),
    "run the command inside a git repository and check that git is installed",
  );
}

function gitFailure(error: unknown): WorkspaceFailure {
  if (error instanceof GitError) {
    return workspaceFailure(error.code, error.detail, "run the command inside a git repository");
  }
  return workspaceFailure(
    "GIT_UNAVAILABLE",
    errorMessage(error),
    "run the command inside a git repository and check that git is installed",
  );
}

function gitDetail(error: unknown): string {
  if (error instanceof GitError) return error.detail;
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported so commands can pass through config copy defaults in tests. */
export type { ConfigView };
