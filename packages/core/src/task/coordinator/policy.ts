/**
 * Coordinator policy (design.md §17, §20.5, §22).
 *
 * Everything here is pure: capability gating, manifest shaping, and the
 * incremental scheduler for tasks that join a running batch. No file I/O, no
 * printing, no process state.
 */

import {
  aggregateBatchStatus,
} from "../index-policy.js";
import { footprintOverlap } from "../parallel/footprint.js";
import type { BatchTaskInput, BatchStatusSummary, TaskLease } from "../index-types.js";
import type { Footprint } from "../parallel/types.js";
import type {
  Batch,
  BatchTask,
  CoordinatorCapabilities,
  CoordinatorGate,
  CoordinatorState,
  DispatchManifest,
  DispatchManifestEntry,
  DispatchWorkspace,
  WaveAssignment,
  WaveScheduleInput,
} from "./types.js";

/**
 * Decide whether a harness can run coordinator mode natively.
 *
 * The gate is deliberately fail-closed: `unknown` never means "probably fine",
 * and `inherited` means every sub-agent shares the parent checkout, so it must
 * degrade to multi-session.
 */
export function canRunCoordinator(
  capabilities: CoordinatorCapabilities,
): CoordinatorGate {
  const execution = capabilities.subagentExecution;
  const workspace = capabilities.subagentWorkspace;

  if (execution === "unknown" || workspace === "unknown") {
    return unavailable(
      "subagent capabilities are unknown; Phase 0 verification is required",
      "multi-session",
    );
  }
  if (execution === "none") {
    return unavailable(
      "subagentExecution: none; this harness cannot spawn sub-agents",
      "serial",
    );
  }
  if (execution === "single") {
    return unavailable(
      "subagentExecution: single; coordinator requires parallel or nested sub-agents",
      "serial",
    );
  }
  if (workspace !== "per-task") {
    return unavailable(
      `subagentWorkspace: ${workspace}; use multi-session instead`,
      "multi-session",
    );
  }
  return { available: true, reason: null, fallback: null };
}

/**
 * Shape a dispatch manifest from already-resolved workspaces and leases.
 *
 * Tasks are emitted in `batch.tasks` order so stable input produces a stable
 * manifest (and therefore a stable hash). Entries missing a workspace or lease
 * are omitted; the caller validates before persisting (see
 * `COORDINATOR_DISPATCH_INVALID`).
 */
export function buildDispatchManifest(
  batch: Batch,
  tasks: readonly BatchTask[],
  leases: readonly TaskLease[],
  workspaces: readonly DispatchWorkspace[],
): DispatchManifest {
  const taskByRef = indexByRef(tasks);
  const leaseByRef = indexByRef(leases);
  const workspaceByRef = indexByRef(workspaces);

  const entries: DispatchManifestEntry[] = [];
  for (const ref of batch.tasks) {
    const key = refKey(ref);
    const task = taskByRef.get(key);
    const lease = leaseByRef.get(key);
    const workspace = workspaceByRef.get(key);
    if (task === undefined || lease === undefined || workspace === undefined) {
      continue;
    }
    entries.push({
      taskRef: task.taskRef,
      workspace: workspace.path,
      branch: workspace.branch,
      lease: `${lease.ownerType}:${lease.ownerId}`,
      dependsOn: [...task.dependsOn],
      promptPrefix: buildPromptPrefix(task.taskRef, workspace.path),
    });
  }
  return { batch: batch.id, wave: batch.wave, tasks: entries };
}

/**
 * Incremental scheduling for tasks that appear while a batch is running.
 *
 * Rules (design.md §17.10, §20.5, R24):
 * - overlap with a running task -> wait for a later wave;
 * - non-overlapping tasks may join the open wave while it has capacity;
 * - capacity is never exceeded (`max_concurrent`);
 * - there is no batch-wide lock: this is a pure decision, so other sessions can
 *   re-plan at any time.
 */
export function nextWave(input: WaveScheduleInput): WaveAssignment {
  const running = [...input.running];
  const open = [...(input.openWave ?? [])];
  const maxConcurrent = normalizeMaxConcurrent(input.maxConcurrent);
  let slots = Math.max(0, maxConcurrent - open.length);

  const join: string[] = [];
  const next: string[] = [];
  const reasons: Record<string, string> = {};

  for (const task of [...input.newTasks].sort(compareBatchTasks)) {
    const runningConflict = firstOverlap(task, running);
    if (runningConflict !== null) {
      next.push(task.taskRef);
      reasons[task.taskRef] = `overlap: ${
        runningConflict.result.path || "unknown_footprint"
      } with ${runningConflict.task.taskRef}`;
      continue;
    }

    const waveConflict = firstOverlap(task, open);
    if (waveConflict !== null) {
      next.push(task.taskRef);
      reasons[task.taskRef] = `overlap: ${
        waveConflict.result.path || "unknown_footprint"
      } with ${waveConflict.task.taskRef}`;
      continue;
    }

    if (slots <= 0) {
      next.push(task.taskRef);
      reasons[task.taskRef] = `max_concurrent: ${maxConcurrent}`;
      continue;
    }

    join.push(task.taskRef);
    reasons[task.taskRef] = "independent";
    open.push(task);
    slots -= 1;
  }

  return { join, next, reasons };
}

/**
 * Aggregate a batch. This is a thin wrapper over W1's `aggregateBatchStatus`
 * so the five coordinator states (`queued`, `running`, `blocked`, `landed`,
 * `needs_human`) have one definition.
 */
export function classifyBatchState(
  tasks: readonly BatchTaskInput[],
): BatchStatusSummary {
  return aggregateBatchStatus(tasks);
}

/** Build the coordinator view used by `coordinator status`. */
export function coordinatorState(
  batch: Batch,
  tasks: readonly BatchTaskInput[],
): CoordinatorState {
  const summary = classifyBatchState(tasks);
  return {
    mode: "coordinator",
    batch: batch.id,
    wave: batch.wave,
    tasks: [...batch.tasks],
    summary,
    blocked: summary.blocked,
    next: coordinatorNext(summary),
  };
}

/** Dispatch prompt first line; the only portable task_ref channel (W0). */
export function buildPromptPrefix(taskRef: string, workspace: string): string {
  return [
    `Active task: ${taskRef}`,
    `Work only in ${workspace}.`,
    "Commit your changes in this worktree when done.",
  ].join("\n");
}

function coordinatorNext(summary: BatchStatusSummary): string | null {
  if (summary.blocked.length > 0) {
    return "inspect the blocked task(s); other tasks continue, then re-dispatch or retry";
  }
  if (summary.needsHuman.length > 0) {
    return "resolve the tasks that need a human decision before integrating";
  }
  if (summary.queued.length === 0 && summary.running.length === 0) {
    return "phronia task integrate --drain";
  }
  return "re-run `phronia task coordinator status` after the running tasks settle";
}

function unavailable(
  reason: string,
  fallback: CoordinatorGate["fallback"],
): CoordinatorGate {
  return { available: false, reason, fallback };
}

function firstOverlap(
  task: BatchTask,
  others: readonly BatchTask[],
): { task: BatchTask; result: ReturnType<typeof footprintOverlap> } | null {
  const footprint = toFootprint(task);
  for (const other of others) {
    if (refKey(other.taskRef) === refKey(task.taskRef)) continue;
    const result = footprintOverlap(footprint, toFootprint(other));
    if (result.overlap) return { task: other, result };
  }
  return null;
}

function toFootprint(task: BatchTask): Footprint {
  const raw = task.footprint.filter(
    (pattern): pattern is string => typeof pattern === "string" && pattern.trim() !== "",
  );
  return raw.length === 0
    ? { raw: [], kind: "unknown" }
    : { raw, kind: "declared" };
}

function normalizeMaxConcurrent(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function compareBatchTasks(left: BatchTask, right: BatchTask): number {
  const priority = priorityRank(left.priority) - priorityRank(right.priority);
  if (priority !== 0) return priority;
  const leftCreated = left.createdAt ?? "";
  const rightCreated = right.createdAt ?? "";
  if (leftCreated !== rightCreated) {
    if (leftCreated === "") return 1;
    if (rightCreated === "") return -1;
    return leftCreated < rightCreated ? -1 : 1;
  }
  return left.taskRef.localeCompare(right.taskRef);
}

function priorityRank(priority: string): number {
  switch (priority.toUpperCase()) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
    default:
      return 99;
  }
}

function indexByRef<T extends { readonly taskRef: string }>(
  items: readonly T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(refKey(item.taskRef), item);
  }
  return map;
}

/** Local canonical form; avoids a CLI dependency and matches W3 comparison. */
function refKey(ref: string): string {
  let value = ref.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (value.startsWith("tasks/")) value = `.phronia/${value}`;
  return value;
}
