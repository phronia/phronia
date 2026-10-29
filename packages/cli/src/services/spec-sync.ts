/**
 * Post-integration spec sync (`phronia task spec plan|commit|status`).
 *
 * A landed task records intent in `spec-delta.md`. `plan` is read-only;
 * `commit` runs in the main checkout, holds the shared integration lock,
 * verifies the target files changed, commits only `.phronia/spec/**`, and
 * records `meta.spec_sync`. It never applies a patch and never includes code.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  loadTaskRecord,
  parseSpecDelta,
  readSpecSyncState,
  validateSpecTargets,
  verifyChangedTargets,
  writeTaskRecord,
  type SpecDelta,
  type SpecSyncResult,
  type SpecSyncState,
} from "@phronia/core/task";
import {
  openState,
  type ConfigView,
  type TaskRecordView,
} from "@phronia/core/state";
import { createGitPort, GitError, type GitPort } from "../adapters/git.js";
import {
  ensureSharedRuntime,
  resolveSharedRuntime,
} from "../adapters/shared-runtime.js";
import {
  acquireIntegrationLock,
  releaseIntegrationLock,
} from "./integration-lock.js";
import { readDirtyPaths } from "./dirty-check.js";

const SPEC_ROOT = ".phronia/spec";
const SPEC_PREFIX = `${SPEC_ROOT}/`;
const DELTA_FILE = "spec-delta.md";

export interface SpecSyncFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly next: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SpecSyncLandingDiff {
  readonly baseSha: string | null;
  readonly commit: string | null;
  readonly files: readonly string[];
}

export interface SpecSyncCurrentFile {
  readonly path: string;
  readonly sha256: string | null;
}

export interface SpecSyncPlanTask {
  readonly taskRef: string;
  /** `ready` when a delta exists; `none` when the task has no delta. */
  readonly status: "ready" | "none";
  /** Repo-relative `spec-delta.md` path, or null. */
  readonly delta: string | null;
  readonly targetFiles: readonly string[];
  readonly landedDiff: SpecSyncLandingDiff;
  readonly currentSpec: readonly SpecSyncCurrentFile[];
}

export interface SpecSyncPlanResult {
  readonly ok: true;
  readonly tasks: readonly SpecSyncPlanTask[];
}

export type SpecSyncPlanServiceResult = SpecSyncPlanResult | SpecSyncFailure;

export interface SpecSyncCommitTask {
  readonly taskRef: string;
  readonly delta: string | null;
  readonly targetFiles: readonly string[];
  readonly status: "synced" | "none";
}

export interface SpecSyncCommitResult {
  readonly ok: true;
  readonly commit: string;
  /** Metadata-only commit when `meta.spec_sync` needed recording. */
  readonly metadataCommit: string | null;
  readonly files: readonly string[];
  readonly refs: readonly string[];
  readonly tasks: readonly SpecSyncCommitTask[];
  readonly warnings: readonly string[];
}

export type SpecSyncCommitServiceResult = SpecSyncCommitResult | SpecSyncFailure;

export interface SpecSyncStatusResult {
  readonly ok: true;
  readonly tasks: readonly SpecSyncResult[];
}

export type SpecSyncStatusServiceResult = SpecSyncStatusResult | SpecSyncFailure;

export interface SpecSyncOptions {
  readonly cwd: string;
  readonly refs: readonly string[];
  readonly sessionKey?: string;
  readonly git?: GitPort;
  readonly now?: () => Date;
  readonly hostname?: string;
  readonly pid?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SpecSyncCommitOptions extends SpecSyncOptions {
  readonly allowMissing?: boolean;
}

interface MainContext {
  readonly mainRoot: string;
  readonly git: GitPort;
  readonly config: ConfigView;
}

interface CollectedTask {
  readonly ref: string;
  readonly view: TaskRecordView;
  readonly deltaPath: string | null;
  readonly delta: SpecDelta | null;
}

/**
 * Read-only plan: deltas, landed diff, target files, and current spec hashes.
 * No lock, no writes.
 */
export function planSpecSync(options: SpecSyncOptions): SpecSyncPlanServiceResult {
  const refs = normalizeRefs(options.refs);
  if (refs.length === 0) {
    return failure(
      "SPEC_SYNC_FAILED",
      "no task refs were provided",
      "pass one or more task refs: phronia task spec plan <ref...>",
    );
  }

  let context: MainContext;
  try {
    context = mainContext(options);
  } catch (error) {
    return failure(
      error instanceof GitError ? error.code : "GIT_UNAVAILABLE",
      `cannot resolve the repository: ${errorMessage(error)}`,
      "run this command inside the main checkout",
    );
  }

  const state = openState({
    root: context.mainRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  // Resolve every requested task and its base before reading deltas, so a
  // mixed-base call fails without producing a misleading partial plan.
  const landed: {
    readonly ref: string;
    readonly view: TaskRecordView;
    readonly integration: IntegrationMeta;
  }[] = [];
  for (const ref of refs) {
    const precheck = requireLanded(ref, state);
    if (!precheck.ok) return precheck.failure;
    landed.push({
      ref,
      view: precheck.view,
      integration: precheck.integration,
    });
  }
  const baseCheck = validateRequestedBases(
    context,
    landed.map((entry) => ({
      taskRef: entry.view.ref,
      baseBranch: entry.view.baseBranch,
    })),
  );
  if (!baseCheck.ok) return baseCheck.failure;

  const tasks: SpecSyncPlanTask[] = [];
  for (const entry of landed) {
    const collected = collectTask(entry.ref, state);
    if (!collected.ok) return collected.failure;
    const task = collected.task;
    const integration = entry.integration;

    const landedDiff = readLandedDiff(context, integration);
    if (!landedDiff.ok) return landedDiff.failure;

    if (task.delta === null || task.deltaPath === null) {
      tasks.push({
        taskRef: task.ref,
        status: "none",
        delta: null,
        targetFiles: [],
        landedDiff: landedDiff.value,
        currentSpec: [],
      });
      continue;
    }

    tasks.push({
      taskRef: task.ref,
      status: "ready",
      delta: relativePath(context.mainRoot, task.deltaPath),
      targetFiles: task.delta.targetFiles,
      landedDiff: landedDiff.value,
      currentSpec: task.delta.targetFiles.map((target) => ({
        path: target,
        sha256: hashFile(path.join(context.mainRoot, target)),
      })),
    });
  }

  return { ok: true, tasks };
}

/**
 * Commit spec updates that are already present in the main checkout's working
 * tree. The agent/main session writes the spec; this function only verifies
 * scope and records the result.
 */
export function commitSpecSync(
  options: SpecSyncCommitOptions,
): SpecSyncCommitServiceResult {
  const refs = normalizeRefs(options.refs);
  if (refs.length === 0) {
    return failure(
      "SPEC_SYNC_FAILED",
      "no task refs were provided",
      "pass one or more task refs: phronia task spec commit <ref...>",
    );
  }

  let context: MainContext;
  let paths: ReturnType<typeof resolveSharedRuntime>["paths"];
  try {
    context = mainContext(options);
    paths = resolveSharedRuntime({ cwd: context.mainRoot, git: context.git }).paths;
    ensureSharedRuntime(paths);
  } catch (error) {
    return failure(
      error instanceof GitError ? error.code : "GIT_UNAVAILABLE",
      `cannot resolve the repository: ${errorMessage(error)}`,
      "run this command inside the main checkout",
    );
  }

  const state = openState({
    root: context.mainRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const landed: { readonly ref: string; readonly view: TaskRecordView }[] = [];
  for (const ref of refs) {
    const precheck = requireLanded(ref, state);
    if (!precheck.ok) return precheck.failure;
    landed.push({ ref, view: precheck.view });
  }
  const baseCheck = validateRequestedBases(
    context,
    landed.map((entry) => ({
      taskRef: entry.view.ref,
      baseBranch: entry.view.baseBranch,
    })),
  );
  if (!baseCheck.ok) return baseCheck.failure;

  const collected: CollectedTask[] = [];
  for (const entry of landed) {
    const result = collectTask(entry.ref, state);
    if (!result.ok) return result.failure;
    collected.push(result.task);
  }

  const branch = safeBranch(context.git, context.mainRoot);
  const expectedBase = resolveBaseBranch(context, collected);
  if (branch === "") {
    return failure(
      "SPEC_SYNC_FAILED",
      "the main checkout is on a detached HEAD",
      `checkout ${expectedBase} in ${context.mainRoot}`,
    );
  }
  if (branch !== expectedBase) {
    return failure(
      "SPEC_SYNC_FAILED",
      `the main checkout is on ${branch}, but spec sync targets ${expectedBase}`,
      `git -C ${context.mainRoot} checkout ${expectedBase}`,
      { branch, expectedBase },
    );
  }

  const lock = acquireIntegrationLock({
    cwd: context.mainRoot,
    git: context.git,
    taskRef: refs[0] ?? "spec-sync",
    owner: refs.join(", "),
    kind: "spec-sync",
    phase: "acquiring",
    baseBranch: expectedBase,
    ttlSeconds: lockTtlSeconds(context.config),
    busyCode: "SPEC_SYNC_LOCK_BUSY",
    paths,
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.hostname === undefined ? {} : { host: options.hostname }),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
  });
  if (!lock.ok) {
    return lock.code === "SPEC_SYNC_LOCK_BUSY"
      ? failure(lock.code, lock.message, lock.next, lock.details)
      : failure("SPEC_SYNC_FAILED", lock.message, lock.next, lock.details);
  }

  try {
    // Reuse integrate's filtered status: an explicitly configured gitignored
    // input (a symlink to node_modules etc.) must not block spec sync.
    const changed = safeDirtyPaths(
      context.git,
      context.mainRoot,
      context.config.parallel.integration.ignoredInputs,
      context.mainRoot,
    );
    const outsideSpec = changed.filter((file) => !isUnderSpec(file));
    if (outsideSpec.length > 0) {
      return failure(
        "SPEC_SYNC_DIRTY_MAIN",
        `the main checkout has ${outsideSpec.length} non-spec change(s); spec sync only commits .phronia/spec/**`,
        "commit or stash the non-spec changes, then retry",
        { paths: outsideSpec },
      );
    }

    const changedSpec = unique(changed.filter(isUnderSpec));
    if (changedSpec.length === 0) {
      return failure(
        "SPEC_SYNC_NO_CHANGES",
        "no .phronia/spec/** file changed in the main checkout",
        "apply the delta to the spec first (`phronia task spec plan <ref...>`), then retry",
      );
    }

    const targets = collected
      .filter((task) => task.delta !== null)
      .map((task) => ({
        taskRef: task.ref,
        targets: task.delta?.targetFiles ?? [],
      }));
    const warnings: string[] = [];
    for (const task of targets) {
      const { missing } = verifyChangedTargets(task.targets, changedSpec);
      if (missing.length === 0) continue;
      if (options.allowMissing === true) {
        warnings.push(
          `${task.taskRef}: target(s) did not change (allowed): ${missing.join(", ")}`,
        );
        continue;
      }
      return failure(
        "SPEC_SYNC_TARGET_INVALID",
        `task ${task.taskRef} declares target(s) that did not change: ${missing.join(", ")}`,
        "update the declared spec files (or pass --allow-missing if the delta is already satisfied)",
        { taskRef: task.taskRef, missing, changed: changedSpec },
      );
    }

    const added = context.git.add(context.mainRoot, [SPEC_ROOT]);
    if (!added.ok) {
      return failure(
        "SPEC_SYNC_FAILED",
        `git add ${SPEC_ROOT} failed: ${added.detail ?? "unknown error"}`,
        "inspect the main checkout and retry",
      );
    }
    const displayRefs = refs.join(", ");
    const committed = context.git.commit(
      context.mainRoot,
      `chore(spec): sync ${displayRefs}`,
      [SPEC_ROOT],
    );
    if (!committed.ok) {
      return failure(
        "SPEC_SYNC_FAILED",
        `git commit failed: ${committed.detail ?? "unknown error"}`,
        "inspect the main checkout and retry",
      );
    }
    const commitSha = safeHead(context.git, context.mainRoot);
    if (commitSha === null) {
      return failure(
        "SPEC_SYNC_FAILED",
        "the spec commit was created but its SHA cannot be read",
        "inspect `git log` in the main checkout",
      );
    }

    const syncedAt = (options.now?.() ?? new Date()).toISOString();
    const taskJsonPaths: string[] = [];
    const syncedTasks: SpecSyncCommitTask[] = [];
    for (const task of collected) {
      if (task.delta === null) {
        syncedTasks.push({
          taskRef: task.ref,
          delta: null,
          targetFiles: [],
          status: "none",
        });
        continue;
      }
      const deltaRelative = relativePath(context.mainRoot, task.deltaPath ?? "");
      const written = recordSpecSync(task.view, {
        commit: commitSha,
        syncedAt,
        refs,
      }, context.mainRoot);
      if (!written.ok) {
        return failure(
          "SPEC_SYNC_FAILED",
          written.message,
          "the spec commit exists; repair the task record, then re-run status",
          { commit: commitSha, taskRef: task.ref },
        );
      }
      taskJsonPaths.push(written.taskJsonPath);
      syncedTasks.push({
        taskRef: task.ref,
        delta: deltaRelative,
        targetFiles: task.delta.targetFiles,
        status: "synced",
      });
    }

    let metadataCommit: string | null = null;
    if (taskJsonPaths.length > 0) {
      const taskStatus = safeDirtyPaths(
        context.git,
        context.mainRoot,
        context.config.parallel.integration.ignoredInputs,
        context.mainRoot,
      );
      const dirtyTaskJson = unique(
        taskJsonPaths.filter((file) => taskStatus.includes(file)),
      );
      if (dirtyTaskJson.length > 0) {
        const staged = context.git.add(context.mainRoot, dirtyTaskJson);
        if (!staged.ok) {
          return failure(
            "SPEC_SYNC_FAILED",
            `git add for meta.spec_sync failed: ${staged.detail ?? "unknown error"}`,
            "the spec commit exists; commit the task metadata manually",
            { commit: commitSha },
          );
        }
        const metaCommit = context.git.commit(
          context.mainRoot,
          `chore(task): record spec sync for ${displayRefs}`,
          dirtyTaskJson,
        );
        if (!metaCommit.ok) {
          return failure(
            "SPEC_SYNC_FAILED",
            `recording meta.spec_sync failed: ${metaCommit.detail ?? "unknown error"}`,
            "the spec commit exists; commit the task metadata manually",
            { commit: commitSha },
          );
        }
        metadataCommit = safeHead(context.git, context.mainRoot);
      }
    }

    return {
      ok: true,
      commit: commitSha,
      metadataCommit,
      files: changedSpec,
      refs,
      tasks: syncedTasks,
      warnings,
    };
  } finally {
    releaseIntegrationLock(lock.handle, lock.store);
  }
}

/** Read-only status for one task or every task. */
export function statusSpecSync(
  options: Omit<SpecSyncOptions, "refs"> & { readonly refs?: readonly string[] },
): SpecSyncStatusServiceResult {
  let context: MainContext;
  try {
    context = mainContext(options);
  } catch (error) {
    return failure(
      error instanceof GitError ? error.code : "GIT_UNAVAILABLE",
      `cannot resolve the repository: ${errorMessage(error)}`,
      "run this command inside the repository",
    );
  }
  const state = openState({
    root: context.mainRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const requested = normalizeRefs(options.refs ?? []);
  const refs =
    requested.length > 0
      ? requested
      : state.tasks.list().map((task) => task.ref);

  const tasks: SpecSyncResult[] = [];
  for (const ref of refs) {
    const view = state.tasks.read(ref);
    if (view === null) {
      return failure(
        "SPEC_SYNC_FAILED",
        `task not found: ${ref}`,
        "check the task ref, or run `phronia task list`",
        { taskRef: ref },
      );
    }
    const deltaPath = path.join(view.dir, DELTA_FILE);
    const hasDelta = fs.existsSync(deltaPath);
    const rawState = readSpecSyncState(view.meta);
    const stateValue: SpecSyncState =
      rawState === "none" && hasDelta ? "pending" : rawState;
    const specSync = metaRecord(view.meta, "spec_sync");
    tasks.push({
      taskRef: view.ref,
      state: stateValue,
      deltaPath: hasDelta ? relativePath(context.mainRoot, deltaPath) : null,
      commit: typeof specSync?.commit === "string" ? specSync.commit : null,
      syncedAt:
        typeof specSync?.synced_at === "string" ? specSync.synced_at : null,
    });
  }

  return { ok: true, tasks };
}

// ---------------------------------------------------------------------------
// Task collection and validation
// ---------------------------------------------------------------------------

type CollectResult =
  | { readonly ok: true; readonly task: CollectedTask }
  | { readonly ok: false; readonly failure: SpecSyncFailure };

type LandedCheck =
  | {
      readonly ok: true;
      readonly view: TaskRecordView;
      readonly integration: IntegrationMeta;
    }
  | { readonly ok: false; readonly failure: SpecSyncFailure };

function requireLanded(
  ref: string,
  state: ReturnType<typeof openState>,
): LandedCheck {
  const view = state.tasks.read(ref);
  if (view === null) {
    return {
      ok: false,
      failure: failure(
        "SPEC_SYNC_FAILED",
        `task not found: ${ref}`,
        "check the task ref, or run `phronia task list`",
        { taskRef: ref },
      ),
    };
  }
  const integration = readIntegrationMeta(view.meta);
  if (integration.outcome !== "landed") {
    return {
      ok: false,
      failure: failure(
        "SPEC_SYNC_NOT_LANDED",
        `task ${view.ref} is not landed (meta.integration.outcome=${integration.outcome ?? "none"})`,
        "integrate the task first (or wait for the PR and run `phronia task integrate <ref> --sync`)",
        { taskRef: view.ref, outcome: integration.outcome },
      ),
    };
  }
  return { ok: true, view, integration };
}

function collectTask(
  ref: string,
  state: ReturnType<typeof openState>,
): CollectResult {
  const view = state.tasks.read(ref);
  if (view === null) {
    return {
      ok: false,
      failure: failure(
        "SPEC_SYNC_FAILED",
        `task not found: ${ref}`,
        "check the task ref, or run `phronia task list`",
        { taskRef: ref },
      ),
    };
  }

  const deltaPath = path.join(view.dir, DELTA_FILE);
  if (!fs.existsSync(deltaPath)) {
    return {
      ok: true,
      task: { ref: view.ref, view, deltaPath: null, delta: null },
    };
  }

  let markdown: string;
  try {
    markdown = fs.readFileSync(deltaPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      failure: failure(
        "SPEC_SYNC_FAILED",
        `cannot read ${deltaPath}: ${errorMessage(error)}`,
        "repair the delta file and retry",
        { taskRef: view.ref },
      ),
    };
  }

  const delta = parseSpecDelta(markdown);
  const validation = validateSpecTargets(delta.targetFiles, state.root);
  if (!validation.ok) {
    return {
      ok: false,
      failure: failure(
        "SPEC_SYNC_TARGET_INVALID",
        `task ${view.ref} has invalid spec targets: ${validation.invalid
          .map((item) => `${item.target} (${item.reason})`)
          .join("; ")}`,
        "targets must be repo-relative paths under .phronia/spec/**",
        { taskRef: view.ref, invalid: validation.invalid },
      ),
    };
  }
  if (delta.targetFiles.length === 0) {
    return {
      ok: false,
      failure: failure(
        "SPEC_SYNC_TARGET_INVALID",
        `task ${view.ref} has a spec-delta.md without target files`,
        "add at least one `## Target files` bullet under .phronia/spec/**",
        { taskRef: view.ref },
      ),
    };
  }
  return {
    ok: true,
    task: { ref: view.ref, view, deltaPath, delta },
  };
}

type DiffResult =
  | { readonly ok: true; readonly value: SpecSyncLandingDiff }
  | { readonly ok: false; readonly failure: SpecSyncFailure };

function readLandedDiff(
  context: MainContext,
  integration: IntegrationMeta,
): DiffResult {
  const commit = integration.commit;
  if (commit === null) {
    return {
      ok: false,
      failure: failure(
        "SPEC_SYNC_FAILED",
        "the landed task has no meta.integration.commit",
        "re-run `phronia task integrate <ref>` to record the landing commit",
      ),
    };
  }
  const from = integration.baseSha ?? `${commit}^`;
  try {
    const files = context.git.diffNames(context.mainRoot, from, commit);
    return {
      ok: true,
      value: { baseSha: integration.baseSha, commit, files },
    };
  } catch (error) {
    return {
      ok: false,
      failure: failure(
        error instanceof GitError ? error.code : "SPEC_SYNC_FAILED",
        `cannot compute the landed diff ${from}..${commit}: ${errorMessage(error)}`,
        "verify the integration base/commit SHAs and retry",
      ),
    };
  }
}

interface SpecSyncRecordInput {
  readonly commit: string;
  readonly syncedAt: string;
  readonly refs: readonly string[];
}

function recordSpecSync(
  view: TaskRecordView,
  input: SpecSyncRecordInput,
  root: string,
): { readonly ok: true; readonly taskJsonPath: string } | { readonly ok: false; readonly message: string } {
  let record;
  try {
    record = loadTaskRecord({ taskDir: view.dir, cwd: root });
  } catch (error) {
    return {
      ok: false,
      message: `cannot read ${path.join(view.dir, "task.json")}: ${errorMessage(error)}`,
    };
  }
  const meta = isRecord(record.meta) ? record.meta : {};
  const existing = isRecord(meta.spec_sync) ? meta.spec_sync : {};
  record.meta = {
    ...meta,
    spec_sync: {
      ...existing,
      status: "synced",
      commit: input.commit,
      synced_at: input.syncedAt,
      refs: [...input.refs],
      mode: "agent",
    },
  };
  try {
    writeTaskRecord({ taskDir: view.dir, record, cwd: root });
  } catch (error) {
    return {
      ok: false,
      message: `cannot write ${path.join(view.dir, "task.json")}: ${errorMessage(error)}`,
    };
  }
  return {
    ok: true,
    taskJsonPath: relativePath(root, path.join(view.dir, "task.json")),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface IntegrationMeta {
  readonly outcome: string | null;
  readonly baseSha: string | null;
  readonly commit: string | null;
}

function readIntegrationMeta(meta: Readonly<Record<string, unknown>>): IntegrationMeta {
  const integration = metaRecord(meta, "integration");
  return {
    outcome: typeof integration?.outcome === "string" ? integration.outcome : null,
    baseSha:
      typeof integration?.base_sha === "string" ? integration.base_sha : null,
    commit: typeof integration?.commit === "string" ? integration.commit : null,
  };
}

function metaRecord(
  meta: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> | null {
  const value = meta[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mainContext(options: {
  readonly cwd: string;
  readonly git?: GitPort;
}): MainContext {
  const git = options.git ?? createGitPort();
  const mainRoot = git.mainWorktreeRoot(path.resolve(options.cwd));
  const state = openState({ root: mainRoot });
  return { mainRoot, git, config: state.config() };
}

interface RequestedBase {
  readonly taskRef: string;
  readonly baseBranch: string | null;
}

/**
 * A spec commit lands on exactly one branch. Reject a call whose landed tasks
 * declare different `base_branch` values, or whose base conflicts with the
 * configured integration branch. All-null and single-base calls keep the old
 * behavior.
 */
function validateRequestedBases(
  context: MainContext,
  entries: readonly RequestedBase[],
): { readonly ok: true } | { readonly ok: false; readonly failure: SpecSyncFailure } {
  const declared = entries.filter(
    (entry): entry is { readonly taskRef: string; readonly baseBranch: string } =>
      typeof entry.baseBranch === "string" && entry.baseBranch.trim() !== "",
  );
  const next =
    "sync tasks that target the same base in one call, or pass tasks with a single base";

  const distinct = unique(declared.map((entry) => entry.baseBranch));
  if (distinct.length > 1) {
    return {
      ok: false,
      failure: failure(
        "SPEC_SYNC_BASE_MISMATCH",
        `requested tasks target different base branches: ${declared
          .map((entry) => `${entry.taskRef} -> ${entry.baseBranch}`)
          .join(", ")}`,
        next,
        {
          bases: distinct,
          tasks: declared.map((entry) => ({
            taskRef: entry.taskRef,
            baseBranch: entry.baseBranch,
          })),
        },
      ),
    };
  }

  const configured = context.config.parallel.integration.branch;
  if (configured !== null && configured !== "") {
    const offenders = declared.filter((entry) => entry.baseBranch !== configured);
    if (offenders.length > 0) {
      return {
        ok: false,
        failure: failure(
          "SPEC_SYNC_BASE_MISMATCH",
          `parallel.integration.branch is ${configured}, but ${offenders
            .map((entry) => `${entry.taskRef} targets ${entry.baseBranch}`)
            .join(", ")}`,
          next,
          {
            configuredBase: configured,
            tasks: offenders.map((entry) => ({
              taskRef: entry.taskRef,
              baseBranch: entry.baseBranch,
            })),
          },
        ),
      };
    }
  }

  return { ok: true };
}

function resolveBaseBranch(
  context: MainContext,
  tasks: readonly CollectedTask[],
): string {
  const configured = context.config.parallel.integration.branch;
  if (configured !== null && configured !== "") return configured;
  const taskBase = tasks
    .map((task) => task.view.baseBranch)
    .find((branch): branch is string => branch !== null && branch !== "");
  if (taskBase !== undefined) return taskBase;
  const current = safeBranch(context.git, context.mainRoot);
  return current === "" ? "main" : current;
}

function lockTtlSeconds(config: ConfigView): number {
  const configured = parseDurationMs(config.parallel.integration.lockTtl);
  return configured === null
    ? 30 * 60
    : Math.max(60, Math.ceil(configured / 1000));
}

function parseDurationMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return amount * (multipliers[(match[2] ?? "m").toLowerCase()] ?? 60_000);
}

function isUnderSpec(file: string): boolean {
  return file === SPEC_ROOT || file.startsWith(SPEC_PREFIX);
}

function safeDirtyPaths(
  git: GitPort,
  cwd: string,
  ignoredInputs: readonly string[],
  mainRoot: string,
): readonly string[] {
  try {
    return readDirtyPaths(git, cwd, ignoredInputs, mainRoot).dirtyPaths;
  } catch {
    return [];
  }
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

function hashFile(file: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function relativePath(root: string, target: string): string {
  if (target === "") return "";
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return target.split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function normalizeRefs(refs: readonly string[]): readonly string[] {
  return unique(
    refs
      .map((ref) => ref.trim())
      .filter((ref) => ref !== "")
      .map(canonicalRef),
  );
}

function canonicalRef(ref: string): string {
  let value = ref.replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value === "" || path.isAbsolute(value)) return value;
  if (value.startsWith("tasks/")) return `.phronia/${value}`;
  if (!value.startsWith(".phronia/") && !value.includes("/")) {
    return `.phronia/tasks/${value}`;
  }
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  code: string,
  message: string,
  next: string,
  details?: Readonly<Record<string, unknown>>,
): SpecSyncFailure {
  return {
    ok: false,
    code,
    message,
    next,
    ...(details === undefined ? {} : { details }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
