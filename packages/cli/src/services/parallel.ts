/**
 * Parallel planning and status services (`phronia task parallel ...`).
 *
 * The service layer reads the control plane (main worktree task records) and
 * the shared runtime, then delegates every decision to the W1 pure policies.
 * It never prints or exits; commands render the returned data.
 *
 * Design references: §4.4, §5, §18.3, §19.2.
 */

import fs from "node:fs";
import path from "node:path";
import {
  normalizeFootprint,
  normalizeIndexFile,
  normalizeQueue,
  planParallel,
  queuePosition,
  readParallelMeta,
  canRunCoordinator,
  type Footprint,
  type ParallelPlan,
  type PlannerTask,
  type QueueEntry,
  type TaskIndexEntry,
  type TaskLease,
  type Wave,
} from "@phronia/core/task";
import {
  packagePathMap,
  openState,
  type ConfigView,
  type Diagnostic,
  type SharedRuntimePaths,
  type TaskRecordView,
} from "@phronia/core/state";
import { CAPABILITIES, normalizePlatformId, type PlatformId } from "@phronia/core";
import {
  createGitPort,
  type GitPort,
} from "../adapters/git.js";
import {
  loadWorktreeRegistry,
  readRuntimeJson,
  resolveSharedRuntime,
  type WorktreeRegistryEntry,
} from "../adapters/shared-runtime.js";
import { listTaskLeases } from "./lease.js";
import { taskSpecState, type SpecDisplayState } from "./spec-status.js";
import { detectWorktreeInputs, ensureWorkspace } from "./workspace.js";

export const DEFAULT_PLAN_STATUSES = ["in_progress"] as const;
export const PLANNING_STATUS = "planning";

export interface PlanFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly next: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PlanTaskSummary {
  readonly ref: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly footprint: Footprint;
  readonly dependsOn: readonly string[];
  readonly exclusive: boolean;
  readonly workspace: string | null;
  readonly container: boolean;
  readonly childCount: number;
  /** `meta.kind`; `spec` tasks are control-plane only. */
  readonly kind: string | null;
  readonly createdAt?: string;
}

export interface ParallelPlanResult {
  readonly ok: true;
  readonly waves: readonly Wave[];
  readonly diagnostics: readonly Diagnostic[];
  readonly tasks: readonly PlanTaskSummary[];
  readonly config: ConfigView["parallel"];
}

export type PlanServiceResult = ParallelPlanResult | PlanFailure;

export interface PlanOptions {
  readonly cwd: string;
  readonly git?: GitPort;
  readonly includePlanning?: boolean;
  readonly refs?: readonly string[];
  readonly maxConcurrent?: number;
  readonly allowUnknown?: boolean;
  readonly enabled?: boolean;
}

export interface StatusTaskSummary {
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  readonly scope: "control-plane" | "branch-local";
  readonly workspace: string | null;
  readonly branch: string | null;
  readonly owner: string | null;
  readonly integration: { readonly outcome: string };
  readonly queuePosition: number | null;
  readonly footprint: readonly string[];
  readonly dependsOn: readonly string[];
  readonly updatedAt: string | null;
  /** Post-integration spec state (`spec-delta.md` + `meta.spec_sync`). */
  readonly specSync: SpecDisplayState;
}

export interface ParallelStatusResult {
  readonly ok: true;
  readonly tasks: readonly StatusTaskSummary[];
  readonly runtime: {
    readonly sharedRoot: string;
    readonly claim: Record<string, unknown> | null;
    readonly leases: readonly TaskLease[];
    readonly fallback: boolean;
  };
  readonly capabilities: {
    readonly coordinator: {
      readonly available: boolean;
      readonly reason: string | null;
      readonly fallback: string | null;
    };
  };
  /** Tasks whose spec-delta still needs a `spec commit` (R10). */
  readonly specSync: {
    readonly pending: readonly string[];
    readonly failed: readonly string[];
  };
  readonly diagnostics: readonly Diagnostic[];
}

export type StatusServiceResult = ParallelStatusResult | PlanFailure;

export interface StatusOptions {
  readonly cwd: string;
  readonly git?: GitPort;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional harness id for the coordinator capability gate. */
  readonly platform?: string;
}

interface MainContext {
  readonly mainRoot: string;
  readonly git: GitPort;
  readonly config: ConfigView;
}

/** Normalize a task ref to its store form for comparisons. */
export function canonicalRef(ref: string): string {
  let value = ref.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value.startsWith("tasks/")) value = `.phronia/${value}`;
  return value;
}

export function planTasks(options: PlanOptions): PlanServiceResult {
  let context: MainContext;
  try {
    context = mainContext(options.cwd, options.git);
  } catch (error) {
    return failure(
      "GIT_UNAVAILABLE",
      `cannot resolve a git worktree: ${errorMessage(error)}`,
      "run this command inside the repository or check that git is installed",
    );
  }

  const config = context.config.parallel;
  if (options.enabled === false || config.enabled === false) {
    return failure(
      "PARALLEL_DISABLED",
      "parallel planning is disabled (parallel.enabled=false)",
      "set parallel.enabled: true in .phronia/config.yaml",
    );
  }

  const registry = loadWorktreeRegistry({
    projectRoot: context.mainRoot,
    paths: sharedPaths(context),
    git: context.git,
    write: false,
  });
  const workspaceByRef = new Map<string, string>();
  for (const entry of registry.registry.worktrees) {
    const key = canonicalRef(entry.taskRef);
    if (key !== "" && entry.path !== "") workspaceByRef.set(key, entry.path);
  }

  const included = new Set<string>(
    options.includePlanning === true
      ? [...DEFAULT_PLAN_STATUSES, PLANNING_STATUS]
      : [...DEFAULT_PLAN_STATUSES],
  );
  const requested = new Set((options.refs ?? []).map(canonicalRef));

  const state = openState({ root: context.mainRoot });
  const records = state.tasks.list();
  const plannerTasks: PlannerTask[] = [];
  const summaries: PlanTaskSummary[] = [];
  const packagePaths = packagePathMap(context.config);

  for (const record of records) {
    const ref = canonicalRef(record.ref);
    const explicit = requested.has(ref);
    if (requested.size > 0 && !explicit) {
      continue;
    }
    const view = state.tasks.read(ref);
    const status = view?.status ?? record.status ?? "unknown";
    if (!explicit && !included.has(status)) {
      continue;
    }
    const task = toPlannerTask(view, record.ref, record.id, record.title, status, workspaceByRef, packagePaths);
    plannerTasks.push(task);
    summaries.push({
      ref: task.ref,
      id: task.id,
      title: task.title,
      status,
      priority: task.priority,
      footprint: task.footprint,
      dependsOn: task.dependsOn,
      exclusive: task.exclusive,
      workspace: task.workspace,
      container: task.container === true,
      childCount: task.childCount ?? task.children?.length ?? 0,
      kind: task.kind ?? null,
      ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
    });
  }

  const plan = planParallel(plannerTasks, {
    enabled: true,
    maxConcurrent: options.maxConcurrent ?? config.maxConcurrent,
    allowUnknown: options.allowUnknown === true,
    alwaysSerial: config.conflicts.alwaysSerial,
    packagePaths,
    requestedRefs: [...requested],
  });

  const planningChildren = planningChildDiagnostics(
    state,
    plannerTasks,
    new Set(plannerTasks.map((task) => task.ref)),
  );
  const diagnostics = [...plan.diagnostics, ...planningChildren];

  const error = plan.diagnostics.find((item) => item.severity === "error");
  if (error !== undefined) {
    return failure(
      error.code,
      error.message,
      errorNext(error) ?? "fix the reported task graph problem and re-run `phronia task parallel plan`",
      error.details,
    );
  }

  return {
    ok: true,
    waves: plan.waves,
    diagnostics,
    tasks: summaries,
    config,
  };
}

/**
 * A container's planning children cannot be scheduled. Report it only when
 * those children are part of this plan (`--include-planning` or explicit
 * `--refs`), so the default in-progress plan stays quiet.
 */
function planningChildDiagnostics(
  state: ReturnType<typeof openState>,
  tasks: readonly PlannerTask[],
  included: ReadonlySet<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const task of tasks) {
    if (task.container !== true) continue;
    const planning = (task.children ?? [])
      .map((child) => canonicalChildRef(child))
      .filter((child) => included.has(child))
      .map((child) => ({
        ref: child,
        status: state.tasks.read(child)?.status ?? "unknown",
      }))
      .filter((child) => child.status === PLANNING_STATUS);
    if (planning.length === 0) continue;
    const next = planning.map(
      (child) => `python3 ./.phronia/scripts/task.py start ${child.ref}`,
    );
    diagnostics.push({
      code: "PARENT_HAS_PLANNING_CHILDREN",
      severity: "warn",
      message: `parent ${task.ref} has ${planning.length} planning child${
        planning.length === 1 ? "" : "ren"
      }; they cannot be scheduled until started`,
      details: {
        taskRef: task.ref,
        children: planning,
        next,
      },
    });
  }
  return diagnostics;
}

export interface LaunchOptions {
  readonly cwd: string;
  readonly git?: GitPort;
  /** Explicit task refs; when absent, the selected wave is used. */
  readonly refs?: readonly string[];
  /** 1-based wave selector; defaults to the first wave. */
  readonly wave?: number;
  /** Create/attach workspaces. Defaults to false (read-only). */
  readonly prepare?: boolean;
  /** Harness id for platform-specific open instructions. */
  readonly platform?: string;
  /** Session identity used only for `--prepare`; never printed. */
  readonly sessionKey?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly includePlanning?: boolean;
}

export interface LaunchTask {
  readonly taskRef: string;
  readonly title: string;
  readonly workspace: string | null;
  readonly branch: string | null;
  readonly activeTaskLine: string;
  readonly prepareCommand: string;
  readonly leaseCommand: string;
  readonly openInstructions: string;
  /** Missing build inputs and executable next steps for this workspace. */
  readonly inputs: {
    readonly missing: readonly string[];
    readonly next: readonly string[];
  };
  /** Set only when the workspace is missing and no `--prepare` ran. */
  readonly next: string | null;
}

export interface LaunchSkipped {
  readonly taskRef: string;
  readonly code: string;
  readonly message: string;
  readonly next?: string;
}

export interface ParallelLaunchResult {
  readonly ok: true;
  /** Null when explicit refs selected the tasks. */
  readonly wave: number | null;
  readonly prepare: boolean;
  readonly platform: string | null;
  readonly tasks: readonly LaunchTask[];
  readonly skipped: readonly LaunchSkipped[];
  readonly diagnostics: readonly Diagnostic[];
}

export type LaunchServiceResult = ParallelLaunchResult | PlanFailure;

/**
 * Multi-session launch plan (`design.md` §8). The main session orchestrates;
 * Phronia never spawns a process or creates a session. The returned manifest
 * tells the user which workspace to open and which `Active task:` line to
 * send first.
 */
export function launchPlan(options: LaunchOptions): LaunchServiceResult {
  const plan = planTasks({
    cwd: options.cwd,
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.refs === undefined ? {} : { refs: options.refs }),
    ...(options.includePlanning === true ? { includePlanning: true } : {}),
  });
  if (!plan.ok) return plan;

  let context: MainContext;
  try {
    context = mainContext(options.cwd, options.git);
  } catch (error) {
    return failure(
      "GIT_UNAVAILABLE",
      `cannot resolve a git worktree: ${errorMessage(error)}`,
      "run this command inside the repository or check that git is installed",
    );
  }

  const registry = loadWorktreeRegistry({
    projectRoot: context.mainRoot,
    paths: sharedPaths(context),
    git: context.git,
    write: false,
  });

  const explicitRefs =
    options.refs !== undefined && options.refs.length > 0;
  let waveNumber: number | null = null;
  let selectedRefs: readonly string[];
  if (explicitRefs) {
    selectedRefs = [...new Set((options.refs ?? []).map(canonicalRef))];
  } else {
    const requested = normalizeWave(options.wave);
    const wave = plan.waves[requested - 1];
    if (wave === undefined) {
      return failure(
        "PARALLEL_WAVE_NOT_FOUND",
        `wave ${requested} does not exist (plan has ${plan.waves.length} wave(s))`,
        "run `phronia task parallel plan --json` and choose an existing wave",
      );
    }
    selectedRefs = wave.tasks.map(canonicalRef);
    waveNumber = requested;
  }

  const summaryByRef = new Map(
    plan.tasks.map((task) => [canonicalRef(task.ref), task]),
  );
  const state = openState({
    root: context.mainRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const platform = resolveLaunchPlatform(options.platform);
  const tasks: LaunchTask[] = [];
  const skipped: LaunchSkipped[] = [];

  for (const taskRef of selectedRefs) {
    const summary = summaryByRef.get(taskRef);
    if (summary === undefined) {
      skipped.push({
        taskRef,
        code: "TASK_NOT_FOUND",
        message: `task not found in the plan: ${taskRef}`,
        next: "create or start the task in the main checkout first",
      });
      continue;
    }
    if (summary.container) {
      skipped.push({
        taskRef,
        code: "PARALLEL_CONTAINER_TASK",
        message: `container (${summary.childCount} child${
          summary.childCount === 1 ? "" : "ren"
        }): coordinator only; start a child to execute`,
      });
      continue;
    }
    if (summary.kind === "spec") {
      skipped.push({
        taskRef,
        code: "PARALLEL_SPEC_ONLY",
        message:
          "spec-only (meta.kind=spec): control plane; excluded from waves",
      });
      continue;
    }

    const entry = registry.registry.worktrees.find(
      (candidate) =>
        candidate.path !== "" && canonicalRef(candidate.taskRef) === taskRef,
    );
    let workspace: string | null = entry?.path ?? null;
    let branch: string | null =
      entry?.branch !== undefined && entry.branch !== ""
        ? entry.branch
        : launchBranch(state.tasks.read(taskRef)?.branch ?? null);

    if (options.prepare === true) {
      const ensured = ensureWorkspace({
        cwd: options.cwd,
        taskRef,
        ...(options.git === undefined ? {} : { git: options.git }),
        ...(options.sessionKey === undefined
          ? {}
          : { sessionKey: options.sessionKey }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      if (!ensured.ok) {
        skipped.push({
          taskRef,
          code: ensured.code,
          message: ensured.message,
          next: ensured.next,
        });
        continue;
      }
      workspace = ensured.workspace;
      if (
        ensured.decision.kind === "attach" ||
        ensured.decision.kind === "create"
      ) {
        branch = ensured.decision.branch;
      }
    }

    const prepareCommand = `phronia task workspace ensure ${taskRef}`;
    const inputs =
      workspace === null
        ? { missing: [], next: [] }
        : detectWorktreeInputs({
            mainRoot: context.mainRoot,
            worktree: workspace,
            parallel: context.config.parallel,
          });
    tasks.push({
      taskRef,
      title: summary.title,
      workspace,
      branch,
      activeTaskLine: `Active task: ${taskRef}`,
      prepareCommand,
      leaseCommand: `phronia task lease acquire ${taskRef}`,
      openInstructions: openInstructionsFor(
        platform,
        taskRef,
        workspace,
      ),
      inputs: { missing: inputs.missing, next: inputs.next },
      next:
        workspace === null && options.prepare !== true ? prepareCommand : null,
    });
  }

  return {
    ok: true,
    wave: waveNumber,
    prepare: options.prepare === true,
    platform,
    tasks,
    skipped,
    diagnostics: plan.diagnostics,
  };
}

const NON_LAUNCH_BRANCHES = new Set([
  "main",
  "master",
  "origin/main",
  "origin/master",
  "origin/HEAD",
]);

/**
 * `task.json.branch` can be the checked-out integration branch on legacy
 * tasks. Launch must not present that as a task branch to open.
 */
function launchBranch(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const branch = value.trim().replace(/^refs\/heads\//, "");
  if (branch === "" || NON_LAUNCH_BRANCHES.has(branch)) return null;
  return branch;
}

function resolveLaunchPlatform(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  return normalizePlatformId(trimmed) ?? trimmed;
}

function openInstructionsFor(
  platform: string | null,
  taskRef: string,
  workspace: string | null,
): string {
  const where =
    workspace ?? `the workspace printed by \`phronia task workspace ensure ${taskRef}\``;
  const firstLine = `first line: Active task: ${taskRef}`;
  if (platform === "zcode" || platform === "codex") {
    return `Open a new ZCode/Codex window with working directory ${where}; ${firstLine}. Mutating sub-agents inherit this session's cwd; do not dispatch them from another session.`;
  }
  if (platform === "claude-code") {
    return `Open a separate Claude Code session in ${where}; ${firstLine} (per-task workspace capability exists; coordinator rollout is a separate task)`;
  }
  return `Open a new session/window in ${where}; ${firstLine}`;
}

/** 1-based wave selector; mirrors `parallel dispatch --wave`. */
function normalizeWave(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

export function parallelStatus(options: StatusOptions): StatusServiceResult {  let context: MainContext;
  try {
    context = mainContext(options.cwd, options.git);
  } catch (error) {
    return failure(
      "GIT_UNAVAILABLE",
      `cannot resolve a git worktree: ${errorMessage(error)}`,
      "run this command inside the repository or check that git is installed",
    );
  }

  const resolution = resolveSharedRuntime({ cwd: context.mainRoot, git: context.git });
  const diagnostics: Diagnostic[] = [...resolution.diagnostics];
  const state = openState({ root: context.mainRoot, env: options.env });

  const registry = loadWorktreeRegistry({
    projectRoot: context.mainRoot,
    paths: resolution.paths,
    git: context.git,
    write: false,
  });
  diagnostics.push(...registry.diagnostics);

  const indexEntries = readIndex(resolution.paths.tasksIndex, diagnostics);
  const queue = readQueue(resolution.paths.integration, diagnostics);
  const claimRead = readRuntimeJson<Record<string, unknown>>(
    resolution.paths.workspaceClaim,
  );
  const claim = claimRead.ok ? claimRead.value : null;
  const leases = listTaskLeases({ cwd: context.mainRoot, git: context.git });
  const leaseByRef = new Map(leases.map((lease) => [canonicalRef(lease.taskRef), lease]));
  const indexByRef = new Map(
    indexEntries.map((entry) => [canonicalRef(entry.taskRef), entry]),
  );

  const tasks = new Map<string, StatusTaskSummary>();

  for (const record of state.tasks.list()) {
    const ref = canonicalRef(record.ref);
    const view = state.tasks.read(ref);
    const entry = registry.registry.worktrees.find(
      (candidate) => canonicalRef(candidate.taskRef) === ref,
    );
    const workspace = entry?.path ?? context.mainRoot;
    tasks.set(
      ref,
      buildStatusTask({
        ref,
        title: view?.title ?? record.title,
        status: view?.status ?? record.status ?? "unknown",
        scope: "control-plane",
        workspace,
        branch: entry?.branch ?? view?.branch ?? null,
        view,
        index: indexByRef.get(ref) ?? null,
        lease: leaseByRef.get(ref) ?? null,
        claim,
        queue,
        mainRoot: context.mainRoot,
        specSync: taskSpecState(
          ref,
          view,
          state.tasks.artifacts(ref).specDelta,
        ).state,
      }),
    );
  }

  for (const entry of registry.registry.worktrees) {
    const ref = canonicalRef(entry.taskRef);
    if (ref === "" || tasks.has(ref)) {
      if (entry.path !== "" && tasks.has(ref)) {
        const existing = tasks.get(ref);
        if (existing?.workspace === context.mainRoot) {
          tasks.set(ref, { ...existing, workspace: entry.path, branch: entry.branch });
        }
      }
      continue;
    }
    const local = readWorktreeTask(entry);
    const index = indexByRef.get(ref) ?? null;
    tasks.set(
      ref,
      buildStatusTask({
        ref,
        title: local?.title ?? index?.title ?? basename(ref),
        status: local?.status ?? index?.status ?? "unknown",
        scope: "branch-local",
        workspace: entry.path,
        branch: entry.branch,
        view: local?.view ?? null,
        index,
        lease: leaseByRef.get(ref) ?? null,
        claim,
        queue,
        mainRoot: context.mainRoot,
        specSync:
          local?.view === undefined
            ? "none"
            : taskSpecState(
                ref,
                local.view,
                fs.existsSync(path.join(local.view.dir, "spec-delta.md")),
              ).state,
      }),
    );
  }

  for (const entry of indexEntries) {
    const ref = canonicalRef(entry.taskRef);
    if (ref === "" || tasks.has(ref)) continue;
    tasks.set(
      ref,
      buildStatusTask({
        ref,
        title: entry.title,
        status: entry.status,
        scope: "branch-local",
        workspace: entry.workspace,
        branch: null,
        view: null,
        index: entry,
        lease: leaseByRef.get(ref) ?? null,
        claim,
        queue,
        mainRoot: context.mainRoot,
        specSync: "none",
      }),
    );
  }

  const statusTasks = [...tasks.values()].sort((left, right) =>
    left.ref.localeCompare(right.ref),
  );
  return {
    ok: true,
    tasks: statusTasks,
    runtime: {
      sharedRoot: resolution.paths.root,
      claim,
      leases,
      fallback: resolution.fallback,
    },
    capabilities: {
      coordinator: resolveCoordinatorCapability(options.platform),
    },
    specSync: {
      // `failed` is also outstanding work, so it appears in both lists.
      pending: statusTasks
        .filter(
          (task) =>
            task.specSync === "pending" || task.specSync === "failed",
        )
        .map((task) => task.ref),
      failed: statusTasks
        .filter((task) => task.specSync === "failed")
        .map((task) => task.ref),
    },
    diagnostics,
  };
}

function resolveCoordinatorCapability(
  platform: string | undefined,
): { available: boolean; reason: string | null; fallback: string | null } {
  const id = platform?.trim() ?? "";
  const capabilities =
    id !== "" && id in CAPABILITIES
      ? CAPABILITIES[id as PlatformId]
      : null;
  return canRunCoordinator(
    capabilities ?? {
      subagentExecution: "unknown",
      subagentWorkspace: "unknown",
      subagentIdentity: "unknown",
    },
  );
}

function mainContext(cwd: string, injected?: GitPort): MainContext {
  const gitPort = injected ?? createGitPort();
  const cwdResolved = path.resolve(cwd);
  const mainRoot = gitPort.mainWorktreeRoot(cwdResolved);
  const state = openState({ root: mainRoot });
  return {
    mainRoot,
    git: gitPort,
    config: state.config(),
  };
}

function sharedPaths(context: MainContext): SharedRuntimePaths {
  return resolveSharedRuntime({ cwd: context.mainRoot, git: context.git }).paths;
}

function toPlannerTask(
  view: TaskRecordView | null,
  ref: string,
  id: string,
  title: string,
  status: string,
  workspaceByRef: ReadonlyMap<string, string>,
  packagePaths: Readonly<Record<string, string>>,
): PlannerTask {
  const raw = view?.raw ?? {};
  const meta = view?.meta ?? {};
  const parallel = readParallelMeta(meta);
  const priority =
    typeof raw.priority === "string" && raw.priority.trim() !== ""
      ? raw.priority
      : "P2";
  const createdAt =
    typeof raw.created_at === "string"
      ? raw.created_at
      : typeof raw.createdAt === "string"
        ? raw.createdAt
        : undefined;
  const children = (view?.children ?? []).map(canonicalChildRef);
  const kind =
    typeof meta.kind === "string" && meta.kind.trim() !== ""
      ? meta.kind.trim()
      : null;
  return {
    ref: canonicalRef(ref),
    id,
    title,
    status,
    priority,
    footprint: normalizeFootprint(
      {
        meta,
        relatedFiles: view?.relatedFiles ?? [],
        package: view?.package ?? null,
        scope: typeof raw.scope === "string" ? raw.scope : null,
      },
      { packagePaths },
    ),
    dependsOn: parallel.dependsOn,
    exclusive: parallel.exclusive,
    workspace: workspaceByRef.get(canonicalRef(ref)) ?? null,
    container: children.length > 0,
    childCount: children.length,
    children,
    kind,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

/** Normalize a `children` entry (bare name, relative or absolute ref). */
function canonicalChildRef(child: string): string {
  const canonical = canonicalRef(child);
  if (canonical.startsWith(".phronia/") || path.isAbsolute(canonical)) {
    return canonical;
  }
  return canonicalRef(`.phronia/tasks/${canonical}`);
}

interface StatusTaskInput {
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  readonly scope: "control-plane" | "branch-local";
  readonly workspace: string | null;
  readonly branch: string | null;
  readonly view: TaskRecordView | null;
  readonly index: TaskIndexEntry | null;
  readonly lease: TaskLease | null;
  readonly claim: Record<string, unknown> | null;
  readonly queue: readonly QueueEntry[];
  readonly mainRoot: string;
  readonly specSync: SpecDisplayState;
}

function buildStatusTask(input: StatusTaskInput): StatusTaskSummary {
  const raw = input.view?.raw ?? {};
  const meta = isRecord(raw.meta) ? raw.meta : {};
  const integration = isRecord(meta.integration) ? meta.integration : {};
  const outcome =
    typeof integration.outcome === "string" ? integration.outcome : "none";
  const parallel = readParallelMeta(meta);
  const owner = ownerLabel(input.index, input.lease, input.claim, input);
  return {
    ref: input.ref,
    title: input.title,
    status: input.status,
    scope: input.scope,
    workspace: input.workspace,
    branch: input.branch,
    owner,
    integration: { outcome },
    queuePosition: queuePosition(input.queue, input.ref),
    footprint: input.index?.footprint ?? parallel.touches,
    dependsOn: input.index?.dependsOn ?? parallel.dependsOn,
    updatedAt: input.index?.updatedAt ?? null,
    specSync: input.specSync,
  };
}

function ownerLabel(
  index: TaskIndexEntry | null,
  lease: TaskLease | null,
  claim: Record<string, unknown> | null,
  input: StatusTaskInput,
): string | null {
  if (lease !== null) return `${lease.ownerType}:${lease.ownerId}`;
  if (index?.owner !== null && index?.owner !== undefined) {
    const session =
      index.owner.sessionKey === undefined ? "" : ` (${index.owner.sessionKey})`;
    return `${index.owner.type}:${index.owner.id}${session}`;
  }
  if (claim !== null) {
    const claimTaskRef =
      typeof claim.taskRef === "string" ? canonicalRef(claim.taskRef) : null;
    const claimWorkspace =
      typeof claim.workspace === "string" ? claim.workspace : null;
    const owns =
      claimTaskRef === input.ref ||
      (input.workspace !== null &&
        claimWorkspace !== null &&
        path.resolve(claimWorkspace) === path.resolve(input.workspace));
    if (owns) {
      const ownerRef =
        typeof claim.ownerRef === "string"
          ? claim.ownerRef
          : typeof claim.ownerType === "string"
            ? claim.ownerType
            : "claim";
      return `claim:${ownerRef}`;
    }
  }
  return null;
}

function readIndex(
  target: string,
  diagnostics: Diagnostic[],
): readonly TaskIndexEntry[] {
  const read = readRuntimeJson<unknown>(target);
  if (!read.ok) {
    if (!read.missing && read.code !== null) {
      diagnostics.push({
        code: read.code,
        severity: "warn",
        message: read.message ?? `cannot read ${target}`,
        path: target,
      });
    }
    return [];
  }
  try {
    return normalizeIndexFile(read.value);
  } catch (error) {
    diagnostics.push({
      code: "TASK_INDEX_INVALID",
      severity: "warn",
      message: `ignoring invalid tasks.index.json: ${errorMessage(error)}`,
      path: target,
    });
    return [];
  }
}

function readQueue(
  target: string,
  diagnostics: Diagnostic[],
): readonly QueueEntry[] {
  const read = readRuntimeJson<{ queue?: unknown }>(target);
  if (!read.ok) {
    if (!read.missing && read.code !== null) {
      diagnostics.push({
        code: read.code,
        severity: "warn",
        message: read.message ?? `cannot read ${target}`,
        path: target,
      });
    }
    return [];
  }
  const queue = read.value?.queue;
  if (!Array.isArray(queue)) return [];
  return normalizeQueue(
    queue.filter(isQueueEntry).map((entry) => ({
      ...entry,
      taskRef: canonicalRef(entry.taskRef),
    })),
  );
}

function isQueueEntry(value: unknown): value is QueueEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as QueueEntry).taskRef === "string" &&
    typeof (value as QueueEntry).enqueuedAt === "string"
  );
}

function readWorktreeTask(
  entry: WorktreeRegistryEntry,
): { view: TaskRecordView; status: string; title: string } | null {
  const ref = entry.taskRef !== "" ? entry.taskRef : taskRefFromTaskId(entry.taskId);
  if (ref === "") return null;
  const base = path.isAbsolute(ref) ? path.resolve(ref) : path.join(entry.path, ref);
  const file = path.join(base, "task.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      view: {
        ref,
        dir: base,
        id: typeof raw.id === "string" ? raw.id : basename(ref),
        name: typeof raw.name === "string" ? raw.name : basename(ref),
        title:
          typeof raw.title === "string" && raw.title.trim() !== ""
            ? raw.title
            : basename(ref),
        status: typeof raw.status === "string" ? raw.status : null,
        package: typeof raw.package === "string" ? raw.package : null,
        branch: typeof raw.branch === "string" ? raw.branch : null,
        baseBranch:
          typeof raw.base_branch === "string" ? raw.base_branch : null,
        parent: null,
        children: [],
        relatedFiles: Array.isArray(raw.relatedFiles)
          ? raw.relatedFiles.filter((item): item is string => typeof item === "string")
          : [],
        meta: isRecord(raw.meta) ? raw.meta : {},
        raw,
      },
      status: typeof raw.status === "string" ? raw.status : "unknown",
      title:
        typeof raw.title === "string" && raw.title.trim() !== ""
          ? raw.title
          : basename(ref),
    };
  } catch {
    return null;
  }
}

function taskRefFromTaskId(taskId: unknown): string {
  return typeof taskId === "string" && taskId !== ""
    ? `.phronia/tasks/${taskId}`
    : "";
}

function errorNext(diagnostic: Diagnostic): string | null {
  const next = diagnostic.details?.next;
  if (typeof next === "string" && next !== "") return next;
  if (diagnostic.code === "DEPENDENCY_CYCLE") {
    return "remove one edge from the reported cycle, then re-run `phronia task parallel plan`";
  }
  if (diagnostic.code === "DEPENDENCY_MISSING") {
    const candidates = diagnostic.details?.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      return `use one of: ${candidates.join(", ")}`;
    }
  }
  return null;
}

function basename(ref: string): string {
  return ref.split("/").filter((part) => part !== "").at(-1) ?? ref;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  code: string,
  message: string,
  next: string,
  details?: Readonly<Record<string, unknown>>,
): PlanFailure {
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

/** Re-export for commands that want the raw plan shape. */
export type { ParallelPlan };
