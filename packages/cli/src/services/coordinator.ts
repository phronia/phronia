/**
 * Coordinator service: dispatch manifests and batch status (design.md §17,
 * §18.3, §20.5, §22).
 *
 * This layer reads tasks/leases/workspaces through the W3 services and hands
 * every decision to `@phronia/core/task`'s coordinator policy. It never spawns
 * an agent process: dispatch is a manifest plus leases, nothing else.
 */

import crypto from "node:crypto";
import path from "node:path";
import {
  buildDispatchManifest,
  buildPromptPrefix,
  canRunCoordinator,
  classifyBatchState,
  classifyCoordinatorBatch,
  coordinatorState,
  isLeaseExpired,
  worktreeSlug,
  type Batch,
  type BatchStatusSummary,
  type BatchTask,
  type BatchTaskInput,
  type BatchTaskState,
  type CoordinatorGate,
  type TaskLease,
} from "@phronia/core/task";
import {
  CAPABILITIES,
  normalizePlatformId,
  type PlatformCapabilities,
  type PlatformId,
} from "@phronia/core/platform";
import { detectHostPlatform } from "@phronia/core/state";
import {
  canonicalRef,
  parallelStatus,
  planTasks,
  type PlanTaskSummary,
} from "./parallel.js";
import {
  addWorktree,
  ensureWorkspace,
  releaseWorkspace,
  type WorkspaceResult,
} from "./workspace.js";
import { acquireTaskLease } from "./lease.js";
import { createGitPort, type GitPort } from "../adapters/git.js";
import {
  ensureSharedRuntime,
  readRuntimeJson,
  resolveSharedRuntime,
  writeRuntimeJson,
} from "../adapters/shared-runtime.js";

const BATCH_SCHEMA_VERSION = 1;
const DEFAULT_OWNER_PREFIX = "coordinator";

export interface CoordinatorFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly next: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DispatchTaskEntry {
  readonly taskRef: string;
  readonly workspace: string;
  readonly branch: string;
  /** `null` only in a dry run, where no lease is acquired. */
  readonly lease: string | null;
  readonly dependsOn: readonly string[];
  readonly promptPrefix: string;
}

export interface DispatchManifestView {
  readonly batch: string;
  readonly wave: number;
  readonly tasks: readonly DispatchTaskEntry[];
}

export interface DispatchSkipped {
  readonly taskRef: string;
  readonly code: string;
  readonly message: string;
  readonly next: string;
}

export interface DispatchSuccess {
  readonly ok: true;
  readonly batch: string;
  readonly wave: number;
  readonly dryRun: boolean;
  readonly tasks: readonly DispatchTaskEntry[];
  readonly manifest: DispatchManifestView;
  readonly skipped: readonly DispatchSkipped[];
  readonly batchPath: string | null;
  readonly manifestHash: string;
  readonly diagnostics: readonly { readonly code: string; readonly severity: string; readonly message: string }[];
}

export type DispatchResult = DispatchSuccess | CoordinatorFailure;

export interface DispatchOptions {
  readonly cwd: string;
  readonly batchId: string;
  /** 1-based wave selector; defaults to the first wave. */
  readonly wave?: number;
  readonly maxConcurrent?: number;
  readonly includePlanning?: boolean;
  readonly dryRun?: boolean;
  /** Explicit platform id; otherwise inferred from the environment. */
  readonly platform?: string;
  /** Test/integration override for the capability matrix. */
  readonly capabilities?: PlatformCapabilities;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sessionKey?: string;
  readonly ownerId?: string;
  readonly git?: GitPort;
  readonly now?: () => Date;
}

export interface CoordinatorStatusLease {
  readonly taskRef: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly workspace: string;
  readonly heartbeatAt: string;
  readonly ttlSeconds: number;
  readonly stale: boolean;
  readonly next: string;
}

export interface CoordinatorStatusTask {
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  readonly scope: string;
  readonly workspace: string | null;
  readonly branch: string | null;
  readonly owner: string | null;
  readonly integration: { readonly outcome: string };
  readonly batchState: BatchTaskState;
  readonly lease: CoordinatorStatusLease | null;
}

export interface CoordinatorStatusSuccess {
  readonly ok: true;
  readonly batch: string | null;
  readonly wave: number | null;
  readonly tasks: readonly CoordinatorStatusTask[];
  readonly summary: BatchStatusSummary;
  readonly staleLeases: readonly CoordinatorStatusLease[];
  readonly capabilities: { readonly coordinator: CoordinatorGate } | null;
  readonly next: string | null;
  readonly diagnostics: readonly { readonly code: string; readonly severity: string; readonly message: string }[];
}

export type CoordinatorStatusResult =
  | CoordinatorStatusSuccess
  | CoordinatorFailure;

export interface CoordinatorStatusOptions {
  readonly cwd: string;
  readonly batch?: string;
  readonly platform?: string;
  readonly capabilities?: PlatformCapabilities;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly git?: GitPort;
  readonly now?: () => Date;
}

interface BatchSummaryFile {
  readonly schemaVersion: number;
  readonly batch: string;
  readonly wave: number;
  readonly createdAt: string;
  readonly maxConcurrent: number;
  readonly tasks: readonly string[];
  readonly manifestHash: string;
  readonly workspaces: Readonly<Record<string, string>>;
  readonly leases: Readonly<Record<string, string>>;
}

interface ResolvedDispatchTask {
  readonly task: BatchTask;
  readonly workspace: string;
  readonly branch: string;
  readonly lease: TaskLease;
}

export function dispatchBatch(options: DispatchOptions): DispatchResult {
  const cwd = path.resolve(options.cwd);
  const batchId = options.batchId.trim();
  const batchError = validateBatchId(batchId);
  if (batchError !== null) {
    return failure("COORDINATOR_DISPATCH_INVALID", batchError, "use a batch id made of letters, digits, dot, dash, or underscore");
  }

  const plan = planTasks({
    cwd,
    ...(options.includePlanning === true ? { includePlanning: true } : {}),
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  });
  if (!plan.ok) return plan;

  const waveNumber = normalizeWave(options.wave);
  const wave = plan.waves[waveNumber - 1];
  if (wave === undefined || wave.tasks.length === 0) {
    return failure(
      "COORDINATOR_DISPATCH_INVALID",
      `batch ${batchId} has no tasks in wave ${waveNumber}`,
      "run `phronia task parallel plan --json` and choose an existing wave",
      { batch: batchId, wave: waveNumber, waves: plan.waves.length },
    );
  }

  const selected = selectTasks(plan.tasks, wave.tasks);
  const platformId = resolvePlatformId(options.platform, options.env);
  const capabilities =
    options.capabilities ??
    (platformId === null ? null : CAPABILITIES[platformId]);
  const gate =
    capabilities === null
      ? {
          available: false,
          reason:
            "platform is unknown; pass --platform or run inside a verified harness",
          fallback: "multi-session" as const,
        }
      : canRunCoordinator(capabilities);

  if (!gate.available) {
    return unsupported(selected, platformId, gate);
  }

  const batch: Batch = {
    id: batchId,
    wave: waveNumber,
    tasks: selected.map((task) => task.taskRef),
    maxConcurrent: resolveMaxConcurrent(options.maxConcurrent ?? plan.config.maxConcurrent),
  };

  if (options.dryRun === true) {
    return dryRun(batch, selected, plan.config.worktreeDir, cwd, options.git);
  }

  try {
    (options.git ?? createGitPort()).mainWorktreeRoot(cwd);
  } catch (error) {
    return failure(
      "GIT_UNAVAILABLE",
      `cannot resolve the main worktree: ${errorMessage(error)}`,
      "run this command inside a git repository",
    );
  }

  const sessionKey = nonEmpty(options.sessionKey) ?? `${DEFAULT_OWNER_PREFIX}:${batchId}`;
  const ownerId = nonEmpty(options.ownerId) ?? sessionKey;
  const now = options.now;
  const diagnostics: { code: string; severity: string; message: string }[] = [];
  const skipped: DispatchSkipped[] = [];
  const resolved: ResolvedDispatchTask[] = [];
  let claimedMain = false;

  for (const task of selected) {
    const ensured = ensureWorkspace({
      cwd,
      taskRef: task.taskRef,
      sessionKey,
      ...(options.git === undefined ? {} : { git: options.git }),
    });
    if (!ensured.ok) {
      skipped.push(skip(task.taskRef, ensured));
      continue;
    }

    const target = resolveTaskWorkspace(ensured, cwd);
    if (!target.ok) {
      skipped.push(skip(task.taskRef, target));
      continue;
    }
    if (ensured.decision.kind === "reuse-current") {
      const claim = ensured.claim;
      if (claim?.sessionKey !== undefined && claim.sessionKey !== sessionKey) {
        skipped.push({
          taskRef: task.taskRef,
          code: "COORDINATOR_DISPATCH_INVALID",
          message: `task is active in the main checkout owned by ${claim.ownerRef}`,
          next: "finish that task in its session, or release the workspace claim, then re-dispatch",
        });
        continue;
      }
      claimedMain = true;
      // Coordinator dispatch requires an isolated checkout per task even when
      // the main checkout is free. W3's `ensureWorkspace` reuses it for a
      // serial task, so materialize the per-task worktree explicitly.
      const created = addWorktree(task.taskRef, {
        cwd,
        ...(options.git === undefined ? {} : { git: options.git }),
      });
      if (!created.ok || created.record === undefined) {
        skipped.push({
          taskRef: task.taskRef,
          code: created.code ?? "COORDINATOR_DISPATCH_INVALID",
          message: created.message,
          next: created.next ?? "run `phronia task workspace ensure <ref>` and inspect the error",
        });
        continue;
      }
      const leased = acquireLease(task.taskRef, created.record.path, {
        cwd,
        ownerId,
        sessionKey,
        now,
        git: options.git,
      });
      if (!leased.ok) {
        skipped.push(leased.skip);
        continue;
      }
      resolved.push({
        task,
        workspace: created.record.path,
        branch: created.record.branch,
        lease: leased.lease,
      });
      continue;
    }

    if (target.workspace === null || target.branch === null) {
      skipped.push({
        taskRef: task.taskRef,
        code: "COORDINATOR_DISPATCH_INVALID",
        message: `workspace decision ${ensured.decision.kind} has no path or branch`,
        next: "run `phronia task workspace ensure <ref> --json` and inspect the decision",
      });
      continue;
    }

    const leased = acquireLease(task.taskRef, target.workspace, {
      cwd,
      ownerId,
      sessionKey,
      now,
      git: options.git,
    });
    if (!leased.ok) {
      skipped.push(leased.skip);
      continue;
    }
    resolved.push({
      task,
      workspace: target.workspace,
      branch: target.branch,
      lease: leased.lease,
    });
  }

  // The orchestrator must not keep the main checkout: local integrate needs it.
  if (claimedMain) {
    const released = releaseWorkspace({
      cwd,
      sessionKey,
      force: true,
      ...(options.git === undefined ? {} : { git: options.git }),
    });
    if (!released.ok) {
      diagnostics.push({
        code: released.code,
        severity: "warn",
        message: `could not release the temporary main checkout claim: ${released.message}`,
      });
    }
  }

  const coreManifest = buildDispatchManifest(
    batch,
    selected,
    resolved.map((item) => item.lease),
    resolved.map((item) => ({
      taskRef: item.task.taskRef,
      path: item.workspace,
      branch: item.branch,
    })),
  );
  const entries: readonly DispatchTaskEntry[] = coreManifest.tasks;
  const manifest: DispatchManifestView = {
    batch: coreManifest.batch,
    wave: coreManifest.wave,
    tasks: entries,
  };

  if (entries.length === 0) {
    return failure(
      "COORDINATOR_DISPATCH_INVALID",
      "no task could be prepared for dispatch",
      skipped[0]?.next ?? "inspect the skipped tasks and retry",
      { batch: batchId, wave: waveNumber, skipped },
    );
  }

  const manifestHash = hashManifest(manifest);
  const batchPath = persistBatch({
    cwd,
    batch,
    entries,
    selected,
    manifestHash,
    now: now ?? ((): Date => new Date()),
    git: options.git,
    diagnostics,
  });

  return {
    ok: true,
    batch: batch.id,
    wave: batch.wave,
    dryRun: false,
    tasks: entries,
    manifest,
    skipped,
    batchPath,
    manifestHash,
    diagnostics,
  };
}

export function coordinatorStatus(
  options: CoordinatorStatusOptions,
): CoordinatorStatusResult {
  const cwd = path.resolve(options.cwd);
  const status = parallelStatus({
    cwd,
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (!status.ok) return status;

  let batch: BatchSummaryFile | null = null;
  const shared = sharedPaths(cwd, options.git);
  if (options.batch !== undefined && options.batch.trim() !== "") {
    const batchId = options.batch.trim();
    const batchError = validateBatchId(batchId);
    if (batchError !== null) {
      return failure("COORDINATOR_DISPATCH_INVALID", batchError, "use a valid batch id");
    }
    const read = readRuntimeJson<BatchSummaryFile>(batchPath(shared.root, batchId), {
      supportedVersions: [BATCH_SCHEMA_VERSION],
    });
    if (!read.ok || read.value === null) {
      return failure(
        "COORDINATOR_BATCH_NOT_FOUND",
        read.missing
          ? `batch ${batchId} has not been dispatched`
          : `cannot read batch ${batchId}: ${read.message ?? "invalid file"}`,
        `run \`phronia task parallel dispatch --batch ${batchId}\``,
      );
    }
    batch = read.value;
  }

  const allowed =
    batch === null ? null : new Set(batch.tasks.map((ref) => canonicalRef(ref)));
  const selected = status.tasks.filter(
    (task) => allowed === null || allowed.has(canonicalRef(task.ref)),
  );
  const inputs: BatchTaskInput[] = selected.map((task) => ({
    taskRef: canonicalRef(task.ref),
    status: task.status,
    outcome: task.integration.outcome,
  }));
  const summary = classifyCoordinatorBatch(inputs);
  const now = (options.now ?? ((): Date => new Date()))();
  const staleLeases = status.runtime.leases
    .filter((lease) => isLeaseExpired(lease, now))
    .map((lease) => staleLease(lease));
  const leaseByRef = new Map(
    status.runtime.leases.map((lease) => [leaseRef(lease.taskRef), lease]),
  );

  const tasks: CoordinatorStatusTask[] = selected.map((task) => {
    const ref = canonicalRef(task.ref);
    const lease = leaseByRef.get(ref);
    return {
      ref,
      title: task.title,
      status: task.status,
      scope: task.scope,
      workspace: task.workspace,
      branch: task.branch,
      owner: task.owner,
      integration: { outcome: task.integration.outcome },
      batchState: classifyBatchState({
        taskRef: ref,
        status: task.status,
        outcome: task.integration.outcome,
      }),
      lease:
        lease === undefined
          ? null
          : {
              taskRef: leaseRef(lease.taskRef),
              ownerType: lease.ownerType,
              ownerId: lease.ownerId,
              workspace: lease.workspace,
              heartbeatAt: lease.heartbeatAt,
              ttlSeconds: lease.ttlSeconds,
              stale: isLeaseExpired(lease, now),
              next: `phronia task lease status ${leaseRef(lease.taskRef)}`,
            },
    };
  });

  const batchModel: Batch = {
    id: batch?.batch ?? options.batch?.trim() ?? "all",
    wave: batch?.wave ?? 0,
    tasks: selected.map((task) => canonicalRef(task.ref)),
    maxConcurrent: batch?.maxConcurrent ?? 0,
  };
  const state = batch === null ? null : coordinatorState(batchModel, inputs);
  const platformId = resolvePlatformId(options.platform, options.env);
  const capabilities =
    options.capabilities ??
    (platformId === null ? null : CAPABILITIES[platformId]);

  return {
    ok: true,
    batch: batch?.batch ?? null,
    wave: batch?.wave ?? null,
    tasks,
    summary,
    staleLeases,
    capabilities:
      capabilities === null
        ? null
        : { coordinator: canRunCoordinator(capabilities) },
    next: staleLeases.length > 0
      ? "stale lease(s): run `phronia task lease status <ref>`; release or re-acquire explicitly (no auto-reclaim)"
      : state?.next ?? summaryNext(summary),
    diagnostics: status.diagnostics,
  };
}

function resolveTaskWorkspace(
  ensured: WorkspaceResult,
  cwd: string,
): { ok: true; workspace: string | null; branch: string | null } | CoordinatorFailure {
  if (!ensured.ok) return ensured;
  if (ensured.workspace === null) {
    return {
      ok: true,
      workspace: null,
      branch: null,
    };
  }
  const branch =
    ensured.decision.kind === "attach" || ensured.decision.kind === "create"
      ? ensured.decision.branch
      : null;
  return { ok: true, workspace: path.resolve(cwd, ensured.workspace), branch };
}

interface AcquireLeaseInput {
  readonly cwd: string;
  readonly ownerId: string;
  readonly sessionKey: string;
  readonly now?: (() => Date) | undefined;
  readonly git?: GitPort | undefined;
}

function acquireLease(
  taskRef: string,
  workspace: string,
  input: AcquireLeaseInput,
):
  | { readonly ok: true; readonly lease: TaskLease }
  | { readonly ok: false; readonly skip: DispatchSkipped } {
  const result = acquireTaskLease(taskRef, {
    cwd: input.cwd,
    ownerType: "subagent",
    ownerId: input.ownerId,
    sessionKey: input.sessionKey,
    workspace,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.git === undefined ? {} : { git: input.git }),
  });
  if (!result.ok) {
    return {
      ok: false,
      skip: {
        taskRef,
        code: result.code,
        message: result.message,
        next: result.next,
      },
    };
  }
  return { ok: true, lease: result.lease };
}

function dryRun(
  batch: Batch,
  tasks: readonly BatchTask[],
  worktreeDir: string,
  cwd: string,
  git?: GitPort,
): DispatchSuccess {
  let mainRoot = cwd;
  try {
    mainRoot = (git ?? createGitPort()).mainWorktreeRoot(cwd);
  } catch {
    // Prediction only; keep cwd when git is unavailable.
  }
  const entries: DispatchTaskEntry[] = tasks.map((task) => {
    const slug = worktreeSlug({ ref: task.taskRef });
    const workspace = path.isAbsolute(worktreeDir)
      ? path.join(worktreeDir, slug)
      : path.join(mainRoot, worktreeDir, slug);
    return {
      taskRef: task.taskRef,
      workspace,
      branch: `phronia/${slug}`,
      lease: null,
      dependsOn: [...task.dependsOn],
      promptPrefix: buildPromptPrefix(task.taskRef, workspace),
    };
  });
  const manifest: DispatchManifestView = {
    batch: batch.id,
    wave: batch.wave,
    tasks: entries,
  };
  return {
    ok: true,
    batch: batch.id,
    wave: batch.wave,
    dryRun: true,
    tasks: entries,
    manifest,
    skipped: [],
    batchPath: null,
    manifestHash: hashManifest(manifest),
    diagnostics: [],
  };
}

function unsupported(
  tasks: readonly BatchTask[],
  platformId: PlatformId | null,
  gate: CoordinatorGate,
): CoordinatorFailure {
  const fallback = gate.fallback ?? "multi-session";
  const commands = fallbackCommands(tasks, platformId, fallback);
  return failure(
    "COORDINATOR_UNSUPPORTED",
    `coordinator mode is unavailable: ${gate.reason ?? "capability gate failed"}`,
    fallback === "multi-session"
      ? "fallback=multi-session: run `phronia task workspace ensure <ref>` for each task, then start one session per task; Phronia does not spawn agents"
      : "fallback=serial: execute one task at a time; this harness cannot run parallel sub-agents",
    {
      platform: platformId,
      available: false,
      reason: gate.reason,
      fallback,
      commands,
      tasks: tasks.map((task) => task.taskRef),
    },
  );
}

function fallbackCommands(
  tasks: readonly BatchTask[],
  platformId: PlatformId | null,
  fallback: "multi-session" | "serial",
): readonly string[] {
  const commands: string[] = [];
  for (const task of tasks) {
    commands.push(`phronia task workspace ensure ${task.taskRef}`);
    if (fallback === "multi-session") {
      commands.push(launchCommand(platformId, task.taskRef));
    }
  }
  if (fallback === "serial") {
    commands.push("# run one task at a time; do not start two sub-agents concurrently");
  }
  return commands;
}

function launchCommand(platformId: PlatformId | null, taskRef: string): string {
  const prefix = `Active task: ${taskRef}`;
  switch (platformId) {
    case "codex":
      return `codex exec -C <workspace from step 1> "${prefix}"`;
    case "zcode":
      return `open a new ZCode window/workspace at <workspace from step 1> (first line: ${prefix})`;
    default:
      return `open a new session in <workspace from step 1> (first line: ${prefix})`;
  }
}

function persistBatch(input: {
  readonly cwd: string;
  readonly batch: Batch;
  readonly entries: readonly DispatchTaskEntry[];
  readonly selected: readonly BatchTask[];
  readonly manifestHash: string;
  readonly now: () => Date;
  readonly git?: GitPort;
  readonly diagnostics: { code: string; severity: string; message: string }[];
}): string | null {
  const shared = sharedPaths(input.cwd, input.git);
  ensureSharedRuntime(shared);
  const target = batchPath(shared.root, input.batch.id);
  const payload: BatchSummaryFile = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    batch: input.batch.id,
    wave: input.batch.wave,
    createdAt: input.now().toISOString(),
    maxConcurrent: input.batch.maxConcurrent,
    tasks: input.entries.map((entry) => entry.taskRef),
    manifestHash: input.manifestHash,
    workspaces: Object.fromEntries(
      input.entries.map((entry) => [entry.taskRef, entry.workspace]),
    ),
    leases: Object.fromEntries(
      input.entries.map((entry) => [entry.taskRef, entry.lease ?? ""]),
    ),
  };
  const write = writeRuntimeJson(target, payload);
  if (!write.ok) {
    input.diagnostics.push({
      code: write.code ?? "RUNTIME_WRITE_FAILED",
      severity: "warn",
      message: write.message ?? `cannot persist batch summary at ${target}`,
    });
    return null;
  }
  return target;
}

function sharedPaths(
  cwd: string,
  git?: GitPort,
): ReturnType<typeof resolveSharedRuntime>["paths"] {
  const resolution = resolveSharedRuntime({
    cwd,
    git: git ?? createGitPort(),
  });
  return resolution.paths;
}

function batchPath(root: string, batchId: string): string {
  return path.join(root, "batches", `${batchId}.json`);
}

function selectTasks(
  tasks: readonly PlanTaskSummary[],
  refs: readonly string[],
): BatchTask[] {
  const byRef = new Map(tasks.map((task) => [canonicalRef(task.ref), task]));
  const selected: BatchTask[] = [];
  for (const ref of refs) {
    const task = byRef.get(canonicalRef(ref));
    if (task === undefined) continue;
    selected.push({
      taskRef: canonicalRef(task.ref),
      footprint: [...task.footprint.raw],
      dependsOn: [...task.dependsOn],
      status: task.status,
      priority: task.priority,
      ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
    });
  }
  return selected;
}

function staleLease(lease: TaskLease): CoordinatorStatusLease {
  return {
    taskRef: leaseRef(lease.taskRef),
    ownerType: lease.ownerType,
    ownerId: lease.ownerId,
    workspace: lease.workspace,
    heartbeatAt: lease.heartbeatAt,
    ttlSeconds: lease.ttlSeconds,
    stale: true,
    next: `phronia task lease status ${leaseRef(lease.taskRef)}`,
  };
}

/**
 * Normalize a lease's task ref. W3 stores whatever the caller passed, so a
 * lease acquired as `10-28-alpha` must still match the task index's
 * `.phronia/tasks/10-28-alpha`.
 */
function leaseRef(ref: string): string {
  const canonical = canonicalRef(ref);
  if (canonical.startsWith(".phronia/") || canonical.includes("/")) {
    return canonical;
  }
  return `.phronia/tasks/${canonical}`;
}

function summaryNext(summary: BatchStatusSummary): string | null {
  if (summary.done) return "phronia task integrate --drain";
  return "re-run `phronia task coordinator status` after the running tasks settle";
}

function hashManifest(manifest: DispatchManifestView): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
}

function normalizeWave(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function resolveMaxConcurrent(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function resolvePlatformId(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): PlatformId | null {
  if (explicit !== undefined && explicit.trim() !== "") {
    return normalizePlatformId(explicit.trim());
  }
  const detected = detectHostPlatform(env ?? process.env);
  return detected === null ? null : normalizePlatformId(detected);
}

function validateBatchId(value: string): string | null {
  if (value === "") return "batch id is required";
  if (value === "." || value === "..") return `invalid batch id: ${value}`;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return `invalid batch id: ${value}`;
  }
  return null;
}

function skip(taskRef: string, result: WorkspaceResult): DispatchSkipped {
  return {
    taskRef,
    code: result.ok ? "COORDINATOR_DISPATCH_INVALID" : result.code,
    message: result.ok ? "workspace decision did not yield a path" : result.message,
    next: result.ok
      ? "run `phronia task workspace ensure <ref> --json`"
      : result.next,
  };
}

function failure(
  code: string,
  message: string,
  next: string,
  details?: Readonly<Record<string, unknown>>,
): CoordinatorFailure {
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

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}
