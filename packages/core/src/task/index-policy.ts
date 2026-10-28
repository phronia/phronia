/**
 * Shared task index, task lease, and batch aggregation policies.
 *
 * The index is a rebuildable projection, never a second source of truth. These
 * helpers therefore normalize in-memory data only; the runtime adapter decides
 * where it is stored (design.md §19.2, §19.3, §20.3).
 */

import { diagnostic } from "../state/diagnostics.js";
import type {
  BatchStatusSummary,
  BatchTaskInput,
  BatchTaskState,
  LeaseAcquireResult,
  LeaseRequest,
  NormalizeIndexResult,
  TaskIndexEntry,
  TaskIndexOwner,
  TaskLease,
} from "./index-types.js";

const DEFAULT_LEASE_TTL_SECONDS = 3600;

/**
 * Validate and fill optional index fields. Required fields (`taskRef`, `title`,
 * `status`, `priority`, `updatedAt`) are never invented.
 */
export function normalizeIndexEntry(input: unknown): TaskIndexEntry {
  if (!isRecord(input)) {
    throw new Error("index entry must be a JSON object");
  }
  const taskRef = requiredString(input.taskRef, "taskRef");
  const title = requiredString(input.title, "title");
  const status = requiredString(input.status, "status");
  const priority = requiredString(input.priority, "priority");
  const updatedAt = requiredString(input.updatedAt, "updatedAt");
  return {
    taskRef,
    title,
    status,
    priority,
    footprint: stringArray(input.footprint, "footprint"),
    dependsOn: stringArray(input.dependsOn, "dependsOn"),
    owner: normalizeOwner(input.owner),
    workspace: nullableString(input.workspace, "workspace"),
    updatedAt,
  };
}

/** Non-throwing variant with diagnostics. */
export function tryNormalizeIndexEntry(input: unknown): NormalizeIndexResult {
  try {
    return { ok: true, entry: normalizeIndexEntry(input) };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "TASK_INDEX_INVALID",
          "error",
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }
}

/** Normalize and de-duplicate an index file body. */
export function normalizeIndexFile(input: unknown): readonly TaskIndexEntry[] {
  if (!isRecord(input) || !Array.isArray(input.tasks)) {
    throw new Error("tasks index must be an object with a tasks array");
  }
  const entries = input.tasks.map((entry) => normalizeIndexEntry(entry));
  return mergeIndexEntries([], entries);
}

/**
 * Merge two index snapshots. Incoming entries replace existing ones by
 * `taskRef`; the result is sorted by ref so writes stay deterministic.
 */
export function mergeIndexEntries(
  existing: readonly TaskIndexEntry[],
  incoming: readonly TaskIndexEntry[],
): readonly TaskIndexEntry[] {
  const byRef = new Map<string, TaskIndexEntry>();
  for (const entry of existing) byRef.set(entry.taskRef, entry);
  for (const entry of incoming) byRef.set(entry.taskRef, entry);
  return [...byRef.values()].sort((left, right) =>
    left.taskRef.localeCompare(right.taskRef),
  );
}

/** `heartbeatAt + ttlSeconds < now` (design.md §4.6 stale definition). */
export function isLeaseExpired(
  lease: TaskLease,
  now: Date | string = new Date(),
): boolean {
  const heartbeat = Date.parse(lease.heartbeatAt);
  const current = toMillis(now);
  if (Number.isNaN(heartbeat) || current === null) return true;
  const ttl = lease.ttlSeconds > 0 ? lease.ttlSeconds : DEFAULT_LEASE_TTL_SECONDS;
  return heartbeat + ttl * 1000 < current;
}

/** Seconds until expiry; 0 once expired. */
export function leaseRemainingSeconds(
  lease: TaskLease,
  now: Date | string = new Date(),
): number {
  const heartbeat = Date.parse(lease.heartbeatAt);
  const current = toMillis(now);
  if (Number.isNaN(heartbeat) || current === null) return 0;
  const ttl = lease.ttlSeconds > 0 ? lease.ttlSeconds : DEFAULT_LEASE_TTL_SECONDS;
  const remaining = heartbeat + ttl * 1000 - current;
  return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
}

/**
 * Atomically acquire (or idempotently refresh) a lease.
 *
 * A free or expired lease is acquired. A live lease is granted only to the
 * same owner; everyone else gets `LEASE_BUSY` with the current owner so the
 * caller can render `LEASE_BUSY` without another read.
 */
export function acquireLease(
  existing: TaskLease | null,
  request: LeaseRequest,
  now: Date | string = new Date(),
): LeaseAcquireResult {
  const nowIso = toIsoString(now);
  if (existing !== null && !isLeaseExpired(existing, now)) {
    if (sameOwner(existing, request)) {
      return {
        ok: true,
        lease: { ...existing, heartbeatAt: nowIso },
      };
    }
    return {
      ok: false,
      code: "LEASE_BUSY",
      owner: existing,
      next: `wait for ${existing.ownerId}, or use another task`,
      diagnostics: [
        diagnostic(
          "LEASE_BUSY",
          "warn",
          `task ${existing.taskRef} is leased by ${existing.ownerId} in ${existing.workspace}`,
          {
            details: {
              taskRef: existing.taskRef,
              ownerType: existing.ownerType,
              ownerId: existing.ownerId,
              workspace: existing.workspace,
            },
          },
        ),
      ],
    };
  }

  const ttl = resolveTtl(request.ttlSeconds);
  const acquiredAt =
    existing !== null && sameOwner(existing, request)
      ? existing.acquiredAt
      : nowIso;
  return {
    ok: true,
    lease: {
      taskRef: request.taskRef,
      ownerType: request.ownerType,
      ownerId: request.ownerId,
      sessionKey: request.sessionKey,
      workspace: request.workspace,
      acquiredAt,
      heartbeatAt: nowIso,
      ttlSeconds: ttl,
    },
  };
}

/** Refresh the heartbeat. The caller still owns the lease. */
export function heartbeatLease(
  lease: TaskLease,
  now: Date | string = new Date(),
): TaskLease {
  return { ...lease, heartbeatAt: toIsoString(now) };
}

/** Derive a batch state from task status plus integration outcome. */
export function classifyBatchState(input: BatchTaskInput): BatchTaskState {
  if (input.state !== undefined) return input.state;

  const outcome = (input.outcome ?? "").toLowerCase();
  if (outcome === "landed") return "landed";
  if (outcome === "needs_human") return "needs_human";
  if (outcome === "blocked") return "blocked";
  if (outcome === "pushed") return "queued";

  const status = input.status.toLowerCase();
  if (status === "completed" || status === "archived" || status === "merged" || status === "landed") {
    return "landed";
  }
  if (status === "blocked" || status === "failed" || status === "error") {
    return "blocked";
  }
  if (status === "needs_human") return "needs_human";
  if (status === "in_progress" || status === "running" || status === "active" || status === "executing") {
    return "running";
  }
  return "queued";
}

/**
 * Aggregate task states for `parallel status --json`.
 *
 * A blocked task does not stop the batch; `done` only means nothing is queued
 * or running anymore (COORD-04).
 */
export function aggregateBatchStatus(
  tasks: readonly BatchTaskInput[],
): BatchStatusSummary {
  const lists: Record<BatchTaskState, string[]> = {
    queued: [],
    running: [],
    blocked: [],
    landed: [],
    needs_human: [],
  };
  for (const task of tasks) {
    lists[classifyBatchState(task)].push(task.taskRef);
  }
  const byState: Record<BatchTaskState, number> = {
    queued: lists.queued.length,
    running: lists.running.length,
    blocked: lists.blocked.length,
    landed: lists.landed.length,
    needs_human: lists.needs_human.length,
  };
  return {
    total: tasks.length,
    byState,
    queued: lists.queued,
    running: lists.running,
    blocked: lists.blocked,
    landed: lists.landed,
    needsHuman: lists.needs_human,
    done: tasks.length > 0 && byState.queued === 0 && byState.running === 0,
  };
}

function sameOwner(lease: TaskLease, request: LeaseRequest): boolean {
  return (
    lease.ownerType === request.ownerType &&
    lease.ownerId === request.ownerId &&
    lease.sessionKey === request.sessionKey
  );
}

function resolveTtl(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LEASE_TTL_SECONDS;
  }
  return Math.floor(value);
}

function normalizeOwner(value: unknown): TaskIndexOwner | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error("index entry owner must be an object or null");
  }
  const type = value.type;
  if (type !== "session" && type !== "subagent" && type !== "task") {
    throw new Error("index entry owner.type must be session, subagent, or task");
  }
  const id = requiredString(value.id, "owner.id");
  const sessionKey = value.sessionKey;
  if (sessionKey !== undefined && typeof sessionKey !== "string") {
    throw new Error("index entry owner.sessionKey must be a string");
  }
  return sessionKey === undefined
    ? { type, id }
    : { type, id, sessionKey };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`index entry ${field} is required`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`index entry ${field} must be a string or null`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`index entry ${field} must be an array of strings`);
  }
  return [...value];
}

function toMillis(value: Date | string): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
