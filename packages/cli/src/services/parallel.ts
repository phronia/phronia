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
import { CAPABILITIES, type PlatformId } from "@phronia/core";
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
      ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
    });
  }

  const plan = planParallel(plannerTasks, {
    enabled: true,
    maxConcurrent: options.maxConcurrent ?? config.maxConcurrent,
    allowUnknown: options.allowUnknown === true,
    alwaysSerial: config.conflicts.alwaysSerial,
    packagePaths,
  });

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
    diagnostics: plan.diagnostics,
    tasks: summaries,
    config,
  };
}

export function parallelStatus(options: StatusOptions): StatusServiceResult {
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
      }),
    );
  }

  return {
    ok: true,
    tasks: [...tasks.values()].sort((left, right) => left.ref.localeCompare(right.ref)),
    runtime: {
      sharedRoot: resolution.paths.root,
      claim,
      leases,
      fallback: resolution.fallback,
    },
    capabilities: {
      coordinator: resolveCoordinatorCapability(options.platform),
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
    ...(createdAt === undefined ? {} : { createdAt }),
  };
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
