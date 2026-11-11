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
  isDedicatedFeatureBranch,
  readParallelMeta,
  reconcileWorktrees,
  resolveWorktreeBase,
  resolveWorktreeRoot,
  worktreeSlug,
  type BaseRefFacts,
  type BaseRefResolution,
  type InventoryEntry,
  type TaskLease,
  type WorkspaceBaseInfo,
  type WorkspaceClaim,
  type WorkspaceDecision,
  type WorkspaceWorktree,
  type WorktreeRoot,
} from "@phronia/core/task";
import {
  findSoleSessionKey,
  normalizeRepoRelativePath,
  openState,
  type ConfigView,
  type ParallelInput,
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
import { readDirtyPaths } from "./dirty-check.js";
import {
  ensureWorktreeIgnored,
  gitignorePendingPaths,
  type EnsureGitignoreResult,
} from "../utils/ensure-gitignore.js";

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
  /**
   * Process argv used by the shell-ticket bridge. Defaults to
   * `process.argv.slice(2)` so `phronia task workspace ...` can resolve the
   * identity its pre-shell hook wrote a moment ago.
   */
  readonly argv?: readonly string[];
  /** Defaults to true; `prepare` with `--dry-run` is not implemented, so tests
   * mostly use this for status-style reads. */
  readonly writeRegistry?: boolean;
}

export interface PrepareWorkspaceOptions extends WorkspaceDependencies {
  /** `--for-new-task "<title>"`: create a provisional workspace when main is busy. */
  readonly forNewTask?: string;
  /** Explicit base ref for the provisional worktree. */
  readonly base?: string;
  /** Create the provisional worktree even when main is free. */
  readonly isolate?: boolean;
  /** Explicit provisional branch name (default `phronia/wip/<slug>-<hash>`). */
  readonly branch?: string;
  /** `--fetch` / `--no-fetch`; defaults to `parallel.base.fetch`. */
  readonly fetch?: boolean;
  readonly force?: boolean;
  readonly reuseDirty?: boolean;
  readonly sessionKey?: string;
  readonly ownerId?: string;
}

export interface EnsureWorkspaceOptions extends WorkspaceDependencies {
  readonly taskRef: string;
  readonly path?: string;
  /** Explicit base ref for a newly created worktree. */
  readonly base?: string;
  /** `--fetch` / `--no-fetch`; defaults to `parallel.base.fetch`. */
  readonly fetch?: boolean;
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
  /** Missing build inputs + executable next steps (create only). */
  readonly inputs?: WorktreeInputHints;
  /** Resolved worktree root and its gitignore state. */
  readonly worktreeRoot?: WorktreeRootReport;
  readonly provisional?: {
    readonly title: string;
    readonly path: string;
    readonly branch: string;
  };
}

export interface WorktreeRootReport {
  readonly absolute: string;
  readonly relativeFromRepo: string | null;
  readonly outsideRepo: boolean;
  readonly source: "config" | "default" | "ephemeral";
  readonly gitignore: {
    readonly ignored: boolean;
    readonly file: string | null;
    readonly pattern: string | null;
    readonly reason: EnsureGitignoreResult["reason"];
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
  /** Derived inventory fields; absent on legacy records. */
  managed?: boolean;
  insideRoot?: boolean;
  outsideRepo?: boolean;
  /** Best-effort recursive size measured before removal (bytes). */
  freedBytes?: number;
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
  /** Add without requiring the task artifacts to be committed on the base. */
  readonly copyTask?: boolean;
}

export interface WorktreeResult {
  readonly ok: boolean;
  readonly message: string;
  readonly record?: WorktreeRecord;
  readonly code?: string;
  readonly next?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly string[];
  /** Missing build inputs + executable next steps. */
  readonly inputs?: WorktreeInputHints;
  /** Resolved worktree root and its gitignore state. */
  readonly worktreeRoot?: WorktreeRootReport;
  /** Best-effort bytes freed by `remove`/`prune`. */
  readonly freedBytes?: number;
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
  readonly argv: readonly string[];
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
  if (sessionKey === null) {
    return sessionUnknown(context, "prepare a workspace", "phronia task workspace prepare");
  }
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

  if (options.isolate === true && (options.forNewTask?.trim() ?? "") !== "") {
    return busyOrProvisional(context, options, sessionKey, ownerRef, {
      code: "WORKSPACE_ISOLATE",
      reason: "isolation was requested explicitly",
      next: "",
      owner: current,
    });
  }

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
  if (context.config.parallel.worktree === "never") {
    return workspaceFailure(
      "WORKSPACE_WORKTREE_DISABLED",
      "parallel.worktree is never; provisional workspaces are disabled",
      "set parallel.worktree to auto/always, or work in the main checkout",
    );
  }

  const title = options.forNewTask.trim();
  const slug = safeSlug(title);
  const hash = shortHash(`${sessionKey}:${title}`);
  const directory = worktreeDirectory(context);
  const target = hardenedPath(directory, slug, `${slug}-${hash}`, context);
  const branchResult = provisionalBranch(context, options.branch, slug, hash);
  if ("failure" in branchResult) return branchResult.failure;
  const branch = branchResult.branch;
  const baseResult = resolveBaseFor(context, null, {
    base: options.base,
    fetch: options.fetch,
  });
  if (!baseResult.resolution.ok) {
    return workspaceFailure(
      baseResult.resolution.code,
      baseResult.resolution.reason,
      baseResult.resolution.next,
    );
  }
  const base = baseResult.resolution.ref;

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

  ensureWorktreeIgnored({
    mainRoot: context.mainRoot,
    root: worktreeRootOf(context),
    git: context.git,
  });

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
      baseInfo: baseInfoOf(baseResult.resolution),
      code: busy.code,
      reason: `provisional workspace: ${busy.reason}`,
    },
    workspace: target,
    claim: busy.owner,
    lease: null,
    warnings: [
      `${busy.reason}; created a provisional workspace`,
      ...baseResult.warnings,
    ],
    provisional: { title, path: target, branch },
  };
}

function provisionalBranch(
  context: WorkspaceContext,
  explicit: string | undefined,
  slug: string,
  hash: string,
): { branch: string } | { failure: WorkspaceFailure } {
  const fallback = `phronia/wip/${slug.slice(0, 48)}-${hash}`;
  const raw = explicit?.trim() ?? "";
  if (raw === "") return { branch: fallback };
  const integration = localIntegrationRef(context) ?? "";
  if (
    !isDedicatedFeatureBranch(
      raw,
      integration,
      safeBranch(context, context.mainRoot),
    )
  ) {
    return {
      failure: workspaceFailure(
        "WORKSPACE_BRANCH_INVALID",
        `branch ${raw} is the integration branch, HEAD, or the current main branch`,
        "pass --branch <feature-branch>, for example fix/<slug>",
      ),
    };
  }
  if (refExists(context, `refs/heads/${raw}`)) {
    return {
      failure: workspaceFailure(
        "WORKSPACE_BRANCH_EXISTS",
        `branch ${raw} already exists`,
        "choose another --branch or attach the existing worktree",
      ),
    };
  }
  return { branch: raw };
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
  if (sessionKey === null) {
    return sessionUnknown(
      context,
      "ensure a workspace",
      `phronia task workspace ensure ${options.taskRef}`,
    );
  }
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
  const baseResult = resolveBaseFor(context, view, {
    base: options.base,
    fetch: options.fetch,
  });
  const integration = baseResult.resolution.ok ? baseResult.resolution.ref : "";
  const slug = worktreeSlug({ ref, id: view.id });
  // R13: `task.json.branch` may be the integration branch (`main`/`origin/main`)
  // because `task.py start` used to record whatever was checked out. That value
  // is not a worktree branch: passing it through made `decideWorkspace` refuse
  // with `branch main is already checked out` before the reuse-current path.
  // Only a real feature branch is dedicated; everything else falls back to the
  // conventional `phronia/<slug>` worktree branch.
  const dedicatedBranch = isDedicatedFeatureBranch(
    view.branch,
    integration,
    safeBranch(context, context.mainRoot),
  )
    ? view.branch
    : null;
  const taskBranch = existing?.branch ?? dedicatedBranch ?? `phronia/${slug}`;
  const targetPath = hardenedPath(
    worktreeDirectory(context),
    slug,
    `${slug}-${shortHash(ref)}`,
    context,
  );
  const targetBranch = taskBranch;

  let explicitWorktree: WorkspaceWorktree | null = null;
  if (options.path !== undefined) {
    const attached = validateAttachTarget(context, view, ref, options.path);
    if (!attached.ok) {
      return workspaceFailure(attached.code, attached.message, attached.next);
    }
    explicitWorktree = attached.worktree;
  } else if (comparablePath(context.cwd) !== comparablePath(context.mainRoot)) {
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
    integrationBranch: integration,
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
    worktreeRoot: worktreeRootOf(context),
    base: baseResult.resolution,
  });

  const linkedGuard = guardLinkedCheckout(
    context,
    decision,
    existing,
    options,
    baseResult.resolution,
  );
  if (linkedGuard !== null) {
    if (!linkedGuard.ok) return linkedGuard.failure;
    return appendWarnings(
      executeWorkspaceDecision(
        context,
        linkedGuard.decision,
        view,
        ref,
        options,
        sessionKey,
        current,
      ),
      baseResult.warnings,
    );
  }

  return appendWarnings(
    executeWorkspaceDecision(
      context,
      decision,
      view,
      ref,
      options,
      sessionKey,
      current,
    ),
    baseResult.warnings,
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
  base: BaseRefResolution,
): LinkedGuard | { ok: false; failure: WorkspaceFailure } | null {
  if (comparablePath(context.cwd) === comparablePath(context.mainRoot)) return null;
  if (existing !== undefined) return null;
  // Running inside a linked worktree. Only the task that owns that checkout may
  // reuse it; everything else needs its own workspace.
  if (decision.kind === "reuse-current") {
    if (!base.ok) {
      return {
        ok: false,
        failure: workspaceFailure(base.code, base.reason, base.next),
      };
    }
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
        base: base.ref,
        baseInfo: baseInfoOf(base),
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
    const visible = assertTaskArtifactsVisible(context, ref, decision.base, view);
    if (visible !== null) return visible;
  }

  // From here on the checkout gains a directory. If it is not ignored, the very
  // next `ensure` reads the checkout as dirty and refuses. Best-effort: a
  // read-only `.gitignore` must not prevent the worktree from being created.
  const ignore = ensureWorktreeIgnored({
    mainRoot: context.mainRoot,
    root: worktreeRootOf(context),
    git: context.git,
  });

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
  const hints = detectWorktreeInputs({
    mainRoot: context.mainRoot,
    worktree: decision.path,
    parallel: context.config.parallel,
  });

  // A task that works in its own worktree must not hold the main checkout
  // claim; keeping the session's existing claim unchanged preserves the
  // workspace claim -> integration lock ordering in W4.
  return {
    ...success(decision, decision.path, current, findLease(context, ref), [
      `worktree ready: ${decision.path}`,
      "start a new agent session in that directory (or use your platform's worktree launch)",
      ...post.warnings,
      ...hintWarnings(hints),
    ]),
    inputs: hints,
    worktreeRoot: worktreeRootReport(context, ignore),
  };
}

/**
 * Report where worktrees live and whether git ignores that location, using the
 * same `check-ignore` path the dirty check uses.
 */
function worktreeRootReport(
  context: WorkspaceContext,
  ignore?: EnsureGitignoreResult,
): WorktreeRootReport {
  const root = worktreeRootOf(context);
  const outcome =
    ignore ??
    ensureWorktreeIgnored({
      mainRoot: context.mainRoot,
      root,
      git: context.git,
      dryRun: true,
    });
  return {
    absolute: root.absolute,
    relativeFromRepo: root.relativeFromRepo,
    outsideRepo: root.outsideRepo,
    source: root.source,
    gitignore: {
      ignored: outcome.ignored,
      file: outcome.path,
      pattern: outcome.pattern,
      reason: outcome.reason,
    },
  };
}

function hintWarnings(hints: WorktreeInputHints): string[] {
  return hints.missing.map(
    (missing) => `missing worktree input: ${missing} (see inputs.next)`,
  );
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
  if (sessionKey === null) {
    return sessionUnknown(
      context,
      "release a workspace claim",
      "phronia task workspace release",
    );
  }
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
  if (sessionKey === null) {
    return sessionUnknown(
      context,
      "reclaim the workspace claim",
      "phronia task workspace reclaim",
    );
  }
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
  const dirtyPaths = mainDirtyPaths(context);
  if (!options.force && dirtyPaths.length > 0) {
    const taskDirectory = ref.replace(/\\/g, "/");
    const onlyTaskArtifacts = dirtyPaths.every(
      (dirty) =>
        dirty === taskDirectory || dirty.startsWith(`${taskDirectory}/`),
    );
    if (onlyTaskArtifacts) {
      if (options.copyTask !== true) {
        return worktreeFailure(
          "TASK_ARTIFACTS_UNCOMMITTED",
          `task artifacts for ${ref} are uncommitted in the main checkout`,
          workspaceBootstrapNext(view, dirtyPaths, context),
          { details: { dirtyPaths } },
        );
      }
    } else {
      return worktreeFailure(
        "WORKSPACE_DIRTY_UNCLAIMED",
        "main checkout has uncommitted changes; commit them or pass --force",
        bootstrapAwareDirtyNext(view, dirtyPaths, context),
        { details: { dirtyPaths } },
      );
    }
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
  const baseResult = resolveBaseFor(context, view, { base: options.base });
  if (!baseResult.resolution.ok) {
    return worktreeFailure(
      baseResult.resolution.code,
      baseResult.resolution.reason,
      baseResult.resolution.next,
    );
  }
  const base = baseResult.resolution.ref;

  const branchExists = refExists(context, `refs/heads/${branch}`);
  // `--force` keeps its legacy "I know the main checkout is dirty" meaning;
  // otherwise a worktree created from `base` must see the task artifacts.
  const forcedDirty = options.force === true && dirtyPaths.length > 0;
  let forceWarning: string | null = null;
  if (options.copyTask !== true && !branchExists && !forcedDirty) {
    const visible = assertTaskArtifactsVisible(context, ref, base, view);
    if (visible !== null) return visible;
  } else if (
    forcedDirty &&
    options.copyTask !== true &&
    !taskArtifactsVisible(context, ref, base)
  ) {
    forceWarning = `worktree created with --force; task artifacts may be missing — commit ${ref} or re-run with --copy-task`;
  }

  // Same reason as `executeWorkspaceDecision`: an unignored root turns the next
  // dirty check into a false positive.
  const ignore = ensureWorktreeIgnored({
    mainRoot: context.mainRoot,
    root: worktreeRootOf(context),
    git: context.git,
  });

  try {
    context.git.worktreeAdd({
      cwd: context.mainRoot,
      path: target,
      branch,
      ...(branchExists ? {} : { base, createBranch: true }),
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

  if (options.copyTask === true) {
    const copied = copyPath(
      path.join(context.mainRoot, ref),
      path.join(target, ref),
    );
    if (!copied) {
      return worktreeFailure(
        "WORKTREE_COPY_FAILED",
        `worktree created but the task directory could not be copied to ${target}`,
        `copy it manually: cp -R ${ref} ${path.join(target, ref)}`,
        { record },
      );
    }
  }

  const post = applyCopyAndPostCreate(context, target, {
    copy: options.copy,
    postCreate: options.postCreate,
  });
  if (!post.ok) {
    return worktreeFailure(post.code, post.message, post.next, { record });
  }
  const hints = detectWorktreeInputs({
    mainRoot: context.mainRoot,
    worktree: target,
    parallel: context.config.parallel,
  });
  const warnings = [
    ...post.warnings,
    ...hintWarnings(hints),
    ...(forceWarning === null ? [] : [forceWarning]),
  ];
  return {
    ok: true,
    message: `worktree ready: ${target} (${branch})`,
    record,
    ...(warnings.length === 0 ? {} : { warnings }),
    inputs: hints,
    worktreeRoot: worktreeRootReport(context, ignore),
  };
}

export function listWorktrees(options: {
  cwd: string;
  git?: GitPort;
  includeMissing?: boolean;
}): WorktreeRecord[] {
  return listWorktreesWithRoot(options).worktrees;
}

/**
 * `worktree list` needs the resolved root as well as the records: with several
 * worktree layouts in play, "where would a new one go" is part of the answer.
 */
export function listWorktreesWithRoot(options: {
  cwd: string;
  git?: GitPort;
  includeMissing?: boolean;
  includeUnmanaged?: boolean;
}): {
  worktrees: WorktreeRecord[];
  unmanaged: WorktreeRecord[];
  worktreeRoot: WorktreeRootReport | null;
} {
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
    return { worktrees: [], unmanaged: [], worktreeRoot: null };
  }

  let inventoryEntries: readonly InventoryEntry[] = [];
  try {
    inventoryEntries = reconcileWorktrees({
      registry: context.registryLoad.registry.worktrees,
      git: context.git.worktreeList(context.mainRoot).map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch ?? "",
        head: worktree.head,
        bare: worktree.bare,
      })),
      mainRoot: context.mainRoot,
      root: worktreeRootOf(context),
      pathKey: comparablePath,
    }).entries;
  } catch {
    inventoryEntries = context.registryLoad.registry.worktrees.map((entry) => ({
      ...entry,
      managed: entry.taskRef !== "",
      provisional: entry.provisional === true,
      insideRoot: false,
      outsideRepo: false,
      exists: fs.existsSync(entry.path),
      head: null,
    }));
  }

  const existing = inventoryEntries.filter(
    (entry) => options.includeMissing === true || entry.exists,
  );
  const managed = existing.filter(
    (entry) => entry.managed || entry.provisional === true,
  );
  const unmanaged = existing.filter(
    (entry) => !entry.managed && entry.provisional !== true,
  );
  return {
    worktrees: (options.includeUnmanaged === true ? existing : managed)
      .map(toInventoryRecord)
      .sort((left, right) => left.taskRef.localeCompare(right.taskRef)),
    unmanaged: unmanaged.map(toInventoryRecord),
    worktreeRoot: worktreeRootReport(context),
  };
}

function toInventoryRecord(entry: InventoryEntry): WorktreeRecord {
  return {
    taskRef: canonicalRef(entry.taskRef),
    taskId: entry.taskId ?? basename(entry.taskRef),
    path: entry.path,
    branch: entry.branch,
    createdAt: entry.createdAt ?? "",
    kind: entry.kind === "platform" ? "platform" : "phronia",
    ...(entry.provisional === true ? { provisional: true } : {}),
    managed: entry.managed,
    insideRoot: entry.insideRoot,
    outsideRepo: entry.outsideRepo,
  };
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
  const freed = measureDirectorySize(target);
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
  const freedNote =
    freed === null || freed.bytes === 0
      ? ""
      : ` (freed ~${formatBytes(freed.bytes)}${freed.truncated ? "+" : ""})`;
  return {
    ok: true,
    message: `worktree removed: ${target}${freedNote}`,
    ...(freed === null ? {} : { freedBytes: freed.bytes }),
  };
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
      const freed = measureDirectorySize(entry.path);
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
      removed.push(
        freed === null || freed.bytes === 0
          ? record
          : { ...record, freedBytes: freed.bytes },
      );
      continue;
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

  const freedTotal = removed.reduce(
    (sum, record) => sum + (record.freedBytes ?? 0),
    0,
  );
  return {
    ok: true,
    dryRun: options.dryRun === true,
    removed,
    kept,
    message: `${options.dryRun === true ? "would remove" : "removed"} ${
      removed.length
    } worktree(s)${freedTotal === 0 ? "" : `; freed ~${formatBytes(freedTotal)}`}; kept ${kept.length}`,
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
  const config = state.config();
  const worktreeRoot = resolveWorktreeRoot({
    configuredDir: config.parallel.worktreeDir,
    configuredDirSource: config.parallel.worktreeDirSource,
    mainRoot,
    location: config.parallel.location,
  });
  const registryLoad = loadWorktreeRegistry({
    projectRoot: mainRoot,
    paths: resolution.paths,
    git: gitPort,
    worktreeRoot,
    write: writeRegistry,
  });
  const nowFn = options.now ?? ((): Date => new Date());
  return {
    cwd,
    mainRoot,
    git: gitPort,
    config,
    paths: resolution.paths,
    registryLoad,
    now: nowFn(),
    nowFn,
    host: options.host ?? hostname(),
    pid: options.pid ?? process.pid,
    env: options.env ?? process.env,
    argv: options.argv ?? process.argv.slice(2),
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

interface ResolvedBase {
  readonly resolution: BaseRefResolution;
  readonly warnings: readonly string[];
}

function resolveBaseFor(
  context: WorkspaceContext,
  view: TaskRecordView | null,
  options: { readonly base?: string; readonly fetch?: boolean },
): ResolvedBase {
  const warnings: string[] = [];
  const shouldFetch =
    options.fetch ?? context.config.parallel.base.fetch === "always";
  let freshness: "fetched" | "unverified" = "unverified";
  if (shouldFetch) {
    const branch = fetchBranchFor(context, options.base);
    if (branch !== null) {
      const fetched = context.git.fetch(context.mainRoot, "origin", branch);
      if (fetched.ok) {
        freshness = "fetched";
      } else {
        warnings.push(
          `could not fetch origin/${branch}: ${
            fetched.detail ?? fetched.code ?? "unknown error"
          }`,
        );
      }
    }
  }
  return {
    resolution: resolveWorktreeBase(
      baseFacts(context, view, { cliBase: options.base, freshness }),
    ),
    warnings,
  };
}

function baseFacts(
  context: WorkspaceContext,
  view: TaskRecordView | null,
  options: {
    readonly cliBase?: string;
    readonly freshness: "fetched" | "unverified";
  },
): BaseRefFacts {
  return {
    cliBase: options.cliBase ?? null,
    taskBaseBranch: view?.baseBranch ?? null,
    configBranch: context.config.parallel.integration.branch,
    mode: context.config.parallel.base.mode,
    confirm: context.config.parallel.base.confirm,
    remoteHead: resolveOriginHead(context),
    remoteMain: refExists(context, "refs/remotes/origin/main")
      ? "origin/main"
      : null,
    remoteMaster: refExists(context, "refs/remotes/origin/master")
      ? "origin/master"
      : null,
    localMain: refExists(context, "refs/heads/main") ? "main" : null,
    localMaster: refExists(context, "refs/heads/master") ? "master" : null,
    localIntegration: localIntegrationRef(context),
    resolveRef: (ref) => {
      try {
        return context.git.resolveRef(context.mainRoot, ref);
      } catch {
        return null;
      }
    },
    compare: (base, local) => {
      try {
        const { left, right } = context.git.revListLeftRight(
          context.mainRoot,
          base,
          local,
        );
        return { ahead: left, behind: right };
      } catch {
        return null;
      }
    },
    freshness: options.freshness,
  };
}

function fetchBranchFor(
  context: WorkspaceContext,
  explicitBase: string | undefined,
): string | null {
  const base = explicitBase?.trim() ?? "";
  if (base.startsWith("origin/")) return base.slice("origin/".length);
  const head = resolveOriginHead(context);
  if (head?.startsWith("origin/") === true) {
    return head.slice("origin/".length);
  }
  if (refExists(context, "refs/remotes/origin/main")) return "main";
  if (refExists(context, "refs/remotes/origin/master")) return "master";
  return null;
}

function baseInfoOf(
  base: BaseRefResolution,
): WorkspaceBaseInfo | undefined {
  if (!base.ok) return undefined;
  return {
    source: base.source,
    commit: base.commit,
    remote: base.remote,
    freshness: base.freshness,
    behind: base.behind,
    ahead: base.ahead,
    shouldAsk: base.shouldAsk,
    alternatives: base.alternatives,
  };
}

function appendWarnings(
  result: WorkspaceResult,
  extra: readonly string[],
): WorkspaceResult {
  if (extra.length === 0 || !result.ok) return result;
  return { ...result, warnings: [...result.warnings, ...extra] };
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
  try {
    const symbolic = context.git.symbolicRef(
      context.mainRoot,
      "refs/remotes/origin/HEAD",
    );
    if (symbolic !== null) {
      const ref = symbolic.replace(/^refs\/remotes\//, "");
      if (ref.startsWith("origin/") && refExists(context, `refs/remotes/${ref}`)) {
        return ref;
      }
    }
  } catch {
    // Fall through to the conventional names.
  }
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

function scopedTaskCommitNext(view: TaskRecordView): string {
  return `commit them first: git add .phronia/tasks/${view.id} && git commit -m "chore(task): plan ${view.id}"; or re-run with --copy-task`;
}

/**
 * Turn "dirty only because worktree support is not committed yet" into one
 * actionable instruction.
 *
 * Creating the root (or its ignore rule) leaves the checkout dirty for reasons
 * that are not the user's work. Reporting them as plain uncommitted changes
 * sends people looking in the wrong place; the scope commit is the same either
 * way, so both paths get the same next step.
 */
function workspaceBootstrapNext(
  view: TaskRecordView,
  dirtyPaths: readonly string[],
  context: WorkspaceContext,
): string {
  const root = worktreeRootOf(context);
  const bootstrap = new Set([
    ...gitignorePendingPaths({
      mainRoot: context.mainRoot,
      root,
      git: context.git,
    }),
    ".gitignore",
  ]);
  const rootRelative = root.relativeFromRepo;
  const onlyBootstrap = dirtyPaths.every(
    (path) =>
      bootstrap.has(path) ||
      (rootRelative !== null &&
        (path === rootRelative || path.startsWith(`${rootRelative}/`))),
  );
  if (!onlyBootstrap) return scopedTaskCommitNext(view);
  return `commit the task and the worktree bootstrap together: git add ${refOfView(view)} .gitignore && git commit -m "chore(task): plan ${view.id}"; or re-run with --copy-task`;
}

/**
 * Next-step text for a dirty checkout that became dirty only because worktree
 * support (the root directory and its ignore rule) is not committed yet.
 *
 * The emitted `git add` lists only what is actually dirty: suggesting
 * `git add .gitignore` when that file is clean makes the instruction look
 * copied rather than derived.
 */
function bootstrapAwareDirtyNext(
  view: TaskRecordView,
  dirtyPaths: readonly string[],
  context: WorkspaceContext,
): string {
  const fallback = "commit/stash the changes, or re-run with --force";
  const root = worktreeRootOf(context);
  const rootRelative = root.relativeFromRepo;
  const bootstrap = new Set([
    ...gitignorePendingPaths({
      mainRoot: context.mainRoot,
      root,
      git: context.git,
    }),
    ".gitignore",
  ]);
  const onlyBootstrap = dirtyPaths.every(
    (path) =>
      bootstrap.has(path) ||
      (rootRelative !== null &&
        (path === rootRelative || path.startsWith(`${rootRelative}/`))) ||
      path.startsWith(".phronia/tasks/"),
  );
  if (!onlyBootstrap) return fallback;

  const staged = new Set<string>();
  for (const path of dirtyPaths) {
    if (bootstrap.has(path)) {
      // `.gitignore` is only added when it is genuinely pending or dirty.
      staged.add(path);
    } else if (
      rootRelative !== null &&
      (path === rootRelative || path.startsWith(`${rootRelative}/`))
    ) {
      staged.add(rootRelative);
    } else if (path.startsWith(".phronia/tasks/")) {
      staged.add(path.split("/").slice(0, 3).join("/"));
    }
  }
  // The task directory must be committed for the worktree to see it, even when
  // git status only reports the root.
  staged.add(refOfView(view));

  const paths = [...staged].filter((path) => path !== "").join(" ");
  return `commit them together: git add ${paths} && git commit -m "chore(task): plan ${view.id}"; or re-run with --force`;
}

function refOfView(view: TaskRecordView): string {
  return `.phronia/tasks/${view.id}`;
}

/**
 * Shared entry-point guard: a worktree created from `base` must see the task
 * artifacts. `ensure` and `worktree add` use the same message and next.
 */
function assertTaskArtifactsVisible(
  context: WorkspaceContext,
  ref: string,
  base: string,
  view: TaskRecordView,
): WorkspaceFailure | null {
  if (taskArtifactsVisible(context, ref, base)) {
    return null;
  }
  return workspaceFailure(
    "TASK_ARTIFACTS_UNCOMMITTED",
    `task artifacts for ${ref} are not on ${base}; a new worktree would not see prd/design/implement`,
    workspaceBootstrapNext(view, [ref], context),
    { taskRef: ref, base },
  );
}

function mainDirtyPaths(context: WorkspaceContext): readonly string[] {
  try {
    return readDirtyPaths(
      context.git,
      context.mainRoot,
      context.config.parallel.integration.ignoredInputs,
      context.mainRoot,
    ).dirtyPaths;
  } catch {
    return [];
  }
}

function integrationOutcome(context: WorkspaceContext, ref: string): string {
  const view = openState({ root: context.mainRoot }).tasks.read(ref);
  const meta = view?.meta ?? {};
  const integration = isRecord(meta.integration) ? meta.integration : {};
  return typeof integration.outcome === "string" ? integration.outcome : "none";
}

// ---------------------------------------------------------------------------
// worktree inputs / hints
// ---------------------------------------------------------------------------

export interface WorktreeInputHints {
  /** Configured or conventional inputs that are absent from the worktree. */
  readonly missing: readonly string[];
  /** Executable follow-ups (symlink commands, config examples, build hints). */
  readonly next: readonly string[];
}

export interface ApplyWorktreeInputsOptions {
  readonly mainRoot: string;
  readonly worktree: string;
  readonly inputs: readonly ParallelInput[];
  /** Injectable for the Windows fallback test. */
  readonly platform?: NodeJS.Platform;
  readonly symlink?: (
    target: string,
    path: string,
    type?: "dir" | "junction",
  ) => void;
  readonly copy?: (source: string, destination: string) => void;
}

export type WorktreeInputsOutcome =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly next: string;
      readonly warnings: readonly string[];
    };

/**
 * Materialize `parallel.inputs` (`symlink` or `copy`) inside a fresh worktree.
 * Failures never roll the worktree back: the user can fix the input or remove
 * the worktree, and the task artifacts are already committed.
 */
export function applyWorktreeInputs(
  options: ApplyWorktreeInputsOptions,
): WorktreeInputsOutcome {
  const warnings: string[] = [];
  const platform = options.platform ?? process.platform;
  const symlink =
    options.symlink ??
    ((target: string, linkPath: string, type?: "dir" | "junction") =>
      fs.symlinkSync(target, linkPath, type));
  const copy =
    options.copy ??
    ((source: string, destination: string) => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true, force: true });
    });

  for (const input of options.inputs) {
    // Second gate: config validation already rejected `..`/absolute paths.
    const relative = normalizeRepoRelativePath(input.path);
    const source =
      relative === null ? null : path.resolve(options.mainRoot, relative);
    const destination =
      relative === null ? null : path.resolve(options.worktree, relative);
    if (
      relative === null ||
      source === null ||
      destination === null ||
      !isWithin(options.mainRoot, source) ||
      !isWithin(options.worktree, destination)
    ) {
      return inputFailure(
        relative ?? input.path,
        `refusing to materialize an input outside the repository: ${input.path}`,
      );
    }

    if (lstatOrNull(destination) !== null) {
      warnings.push(`input already exists in the worktree; skipped: ${relative}`);
      continue;
    }
    if (fs.existsSync(source) === false) {
      warnings.push(
        `parallel.inputs source is missing in the main checkout; skipped: ${relative}`,
      );
      continue;
    }
    // Resolve symlinks before materializing: a lexical check alone lets a
    // symlinked parent or a source that links to /etc escape the repository.
    const realMainRoot = realpathOrNull(options.mainRoot);
    const realSource = realpathOrNull(source);
    if (
      realMainRoot === null ||
      realSource === null ||
      !isWithin(realMainRoot, realSource)
    ) {
      return inputFailure(
        relative,
        `resolved source escapes the repository: ${realSource ?? source}`,
      );
    }

    try {
      if (input.mode === "copy") {
        copy(source, destination);
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const relativeTarget = path.relative(
          path.dirname(destination),
          source,
        ) || ".";
        if (platform === "win32") {
          try {
            // Junction targets are absolute; Node resolves them itself.
            symlink(source, destination, "junction");
          } catch (error) {
            try {
              copy(source, destination);
              warnings.push(
                `symlink not permitted for ${relative}; copied instead (${errorMessage(error)})`,
              );
            } catch (copyError) {
              return inputFailure(
                relative,
                `cannot link or copy ${relative}: ${errorMessage(copyError)}`,
              );
            }
          }
        } else {
          symlink(relativeTarget, destination, "dir");
        }
      }
    } catch (error) {
      return inputFailure(relative, errorMessage(error));
    }
  }

  return { ok: true, warnings };
}

function inputFailure(relativePath: string, detail: string): WorktreeInputsOutcome {
  return {
    ok: false,
    code: "WORKTREE_INPUT_FAILED",
    message: `cannot materialize worktree input ${relativePath}: ${detail}`,
    next: `fix parallel.inputs (or its permissions) and re-run \`phronia task workspace ensure\`, or remove the worktree with \`phronia task worktree remove\``,
    warnings: [],
  };
}

/**
 * Detect missing build inputs after a worktree is created. Hints only: Phronia
 * never installs dependencies, creates unknown symlinks, or edits `.gitignore`.
 */
export function detectWorktreeInputs(options: {
  readonly mainRoot: string;
  readonly worktree: string;
  readonly parallel: ConfigView["parallel"];
}): WorktreeInputHints {
  const missing: string[] = [];
  const next: string[] = [];
  const seen = new Set<string>();

  const addMissing = (relative: string): void => {
    if (seen.has(relative)) return;
    seen.add(relative);
    missing.push(relative);
  };
  const linkCommand = (relative: string): string =>
    `ln -s ${shellQuote(path.join(options.mainRoot, relative))} ${shellQuote(path.join(options.worktree, relative))}`;

  for (const input of options.parallel.inputs) {
    const relative = normalizeRepoRelativePath(input.path);
    if (relative === null) continue;
    if (lstatOrNull(path.join(options.worktree, relative)) !== null) continue;
    addMissing(relative);
    if (fs.existsSync(path.join(options.mainRoot, relative))) {
      next.push(
        input.mode === "copy"
          ? `cp -R ${path.join(options.mainRoot, relative)} ${path.join(options.worktree, relative)}`
          : linkCommand(relative),
      );
    } else {
      next.push(
        `create ${path.join(options.mainRoot, relative)} in the main checkout, or remove it from parallel.inputs`,
      );
    }
  }

  for (const conventional of ["node_modules", "rust/target"]) {
    if (lstatOrNull(path.join(options.worktree, conventional)) !== null) continue;
    if (lstatOrNull(path.join(options.mainRoot, conventional)) === null) continue;
    addMissing(conventional);
    if (conventional === "node_modules") {
      next.push(
        `${linkCommand(conventional)}  # or declare it under parallel.inputs with mode: symlink`,
      );
    } else {
      next.push(
        `export CARGO_TARGET_DIR=${path.join(options.mainRoot, conventional)}  # per worktree; or set parallel.build.cargo_target_dir: shared`,
      );
    }
  }

  if (options.parallel.build.cargoTargetDir === "shared") {
    next.push(
      `export CARGO_TARGET_DIR=${path.join(options.mainRoot, ".phronia", "cache", "cargo-target")}  # shared cache; Cargo's target lock serializes concurrent builds`,
    );
  }
  if (options.parallel.build.sccache) {
    next.push(
      "cargo install sccache && export RUSTC_WRAPPER=sccache  # optional shared compilation cache",
    );
  }

  return { missing, next };
}

/** Single-quote a path so hints stay copy-pasteable (spaces, `$`, quotes). */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isWithin(root: string, target: string): boolean {  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function realpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// copy / post-create
// ---------------------------------------------------------------------------

function applyCopyAndPostCreate(
  context: WorkspaceContext,
  target: string,
  options: { copy?: readonly string[]; postCreate?: readonly string[] },
):
  | { ok: true; warnings: readonly string[] }
  | { ok: false; code: string; message: string; next: string } {
  const copy = options.copy ?? context.config.parallel.copy;
  const postCreate = options.postCreate ?? context.config.parallel.postCreate;
  const warnings: string[] = [];

  const inputs = applyWorktreeInputs({
    mainRoot: context.mainRoot,
    worktree: target,
    inputs: context.config.parallel.inputs,
  });
  if (!inputs.ok) {
    return {
      ok: false,
      code: inputs.code,
      message: inputs.message,
      next: inputs.next,
    };
  }
  warnings.push(...inputs.warnings);

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
  return { ok: true, warnings };
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

const SIZE_MAX_DEPTH = 12;
const SIZE_MAX_ENTRIES = 200_000;

/**
 * Best-effort recursive size used only for cleanup messages. Symlinks are not
 * followed and both depth and entry count are capped, so a pathological tree
 * can never turn removal into an unbounded scan.
 */
function measureDirectorySize(
  root: string,
): { bytes: number; truncated: boolean } | null {
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current.depth > SIZE_MAX_DEPTH) {
        truncated = true;
        continue;
      }
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        truncated = true;
        continue;
      }
      for (const child of children) {
        entries += 1;
        if (entries > SIZE_MAX_ENTRIES) {
          return { bytes, truncated: true };
        }
        if (child.isSymbolicLink()) continue;
        const full = path.join(current.dir, child.name);
        if (child.isDirectory()) {
          stack.push({ dir: full, depth: current.depth + 1 });
          continue;
        }
        try {
          const stat = fs.lstatSync(full);
          if (stat.isFile()) bytes += stat.size;
        } catch {
          truncated = true;
        }
      }
    }
  } catch {
    return { bytes, truncated: true };
  }
  return { bytes, truncated };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function copyPath(source: string, destination: string): boolean {  try {
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

/**
 * One resolved root per context. `decideWorkspace` accepts an already-resolved
 * absolute root, so joining `mainRoot` and a directory name must never happen
 * outside `resolveWorktreeRoot`.
 */
function worktreeRootOf(context: WorkspaceContext): WorktreeRoot {
  return resolveWorktreeRoot({
    configuredDir: context.config.parallel.worktreeDir,
    configuredDirSource: context.config.parallel.worktreeDirSource,
    mainRoot: context.mainRoot,
    location: context.config.parallel.location,
  });
}

function worktreeDirectory(context: WorkspaceContext): string {
  return worktreeRootOf(context).absolute;
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
    // `argv` is what makes the pre-shell ticket reachable: without it the
    // ticket channel is never consulted and `workspace ensure` fails on every
    // platform that does not export a session variable into shell children.
    const state = openState({
      root: context.mainRoot,
      env: context.env,
      argv: context.argv,
    });
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

function sessionUnknown(
  context: WorkspaceContext,
  operation: string,
  command: string,
): WorkspaceFailure {
  const hint = findSoleSessionKey(context.mainRoot);
  if (hint.key !== null) {
    return workspaceFailure(
      "WORKSPACE_SESSION_UNKNOWN",
      `no session identity was found; refusing to ${operation} without one. ` +
        `This checkout has exactly one session (${hint.key}).`,
      `${command} --session-key ${hint.key}`,
      {
        sessionKey: hint.key,
        hint: `set PHRONIA_CONTEXT_ID=${hint.key} for non-hook shells`,
      },
    );
  }
  const ambiguity =
    hint.candidates.length > 1
      ? ` ${hint.candidates.length} session files exist in this checkout; refusing to choose one.`
      : "";
  return workspaceFailure(
    "WORKSPACE_SESSION_UNKNOWN",
    `no session identity was found; refusing to ${operation} without one.${ambiguity}`,
    "pass --session-key <key> or set PHRONIA_CONTEXT_ID",
    hint.candidates.length > 0 ? { candidates: hint.candidates } : undefined,
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
