/**
 * Task lease service (`phronia task lease acquire|release|status`).
 *
 * A task lease answers "who is doing this task" (design.md §17.5, §20.1). It
 * is deliberately independent from the workspace claim ("who owns the main
 * checkout") and the integration lock ("who is landing").
 *
 * All policy lives in core (`acquireLease`, `isLeaseExpired`); this service
 * only resolves the shared runtime, injects owner identity, and translates
 * results into the CLI error contract (`code` + `next`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLease,
  isLeaseExpired,
  leaseRemainingSeconds,
  type LeaseRequest,
  type TaskLease,
} from "@phronia/core/task";
import { findSoleSessionKey, openState } from "@phronia/core/state";
import { taskLeasePath } from "@phronia/core/state";
import {
  createGitPort,
  type GitPort,
} from "../adapters/git.js";
import {
  createLeaseStore,
  isLeaseBusy,
  type LeaseHandle,
  type LeaseRecord,
  LeaseError,
} from "../adapters/lease.js";
import {
  ensureSharedRuntime,
  readRuntimeJson,
  resolveSharedRuntime,
  type WorktreeRegistry,
} from "../adapters/shared-runtime.js";

export const DEFAULT_LEASE_TTL_SECONDS = 3600;

export interface LeaseFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly next: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface LeaseRecordFile extends LeaseRecord {
  taskRef: string;
  ownerType: TaskLease["ownerType"];
  ownerId: string;
  sessionKey?: string;
  workspace: string;
  acquiredAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
}

export interface LeaseDependencies {
  readonly cwd: string;
  readonly git?: Pick<GitPort, "commonDir" | "mainWorktreeRoot" | "worktreeList">;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
  readonly host?: string;
  readonly pid?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Process argv for the shell-ticket bridge (defaults to `slice(2)`). */
  readonly argv?: readonly string[];
}

export interface AcquireLeaseOptions extends LeaseDependencies {
  readonly ownerType?: TaskLease["ownerType"];
  readonly ownerId?: string;
  readonly sessionKey?: string;
  readonly workspace?: string;
  readonly ttlSeconds?: number;
}

export type AcquireLeaseResult =
  | {
      readonly ok: true;
      readonly lease: TaskLease;
      readonly path: string;
    }
  | LeaseFailure;

export interface ReleaseLeaseOptions extends LeaseDependencies {
  readonly force?: boolean;
  readonly sessionKey?: string;
}

export type ReleaseLeaseResult =
  | { readonly ok: true; readonly released: boolean; readonly lease: TaskLease | null }
  | LeaseFailure;

export interface LeaseStatusOptions extends LeaseDependencies {
  /** Reserved for future filters; the task ref is a positional argument. */
  readonly unused?: never;
}

export type LeaseStatusResult =
  | {
      readonly ok: true;
      readonly lease: TaskLease | null;
      readonly stale: boolean;
      readonly remainingSeconds: number;
      readonly path: string;
    }
  | LeaseFailure;

interface LeaseContext {
  readonly mainRoot: string;
  readonly paths: ReturnType<typeof resolveSharedRuntime>["paths"];
  readonly git: Pick<GitPort, "commonDir" | "mainWorktreeRoot" | "worktreeList">;
  readonly now: () => Date;
  readonly host: string;
  readonly pid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
}

export function acquireTaskLease(
  taskRef: string,
  options: AcquireLeaseOptions,
): AcquireLeaseResult {
  try {
    const context = leaseContext(options);
    const store = createLeaseStore<LeaseRecordFile>({
      path: taskLeasePath(context.paths, taskRef),
      now: context.now,
      host: context.host,
      pid: context.pid,
      defaultTtlSeconds: DEFAULT_LEASE_TTL_SECONDS,
      liveness: "ttl",
    });
    const identity = ownerIdentity(context, options);
    if (identity === null) {
      return ownerUnknown(context, taskRef);
    }
    const request: LeaseRequest = {
      taskRef,
      ownerType: options.ownerType ?? "session",
      ownerId: identity.ownerId,
      sessionKey: identity.sessionKey,
      workspace: options.workspace ?? resolveTaskWorkspace(context, taskRef),
      ttlSeconds: options.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS,
    };

    const existing = store.read();
    const policy = acquireLease(existing, request, context.now());
    if (!policy.ok) {
      return busyFailure(policy.owner);
    }

    if (existing !== null && sameLeaseOwner(existing, policy.lease)) {
      // Same owner: refresh in place instead of failing the atomic create.
      const handle: LeaseHandle<LeaseRecordFile> = {
        path: store.path,
        record: existing,
      };
      store.heartbeat(handle, {
        ownerType: policy.lease.ownerType,
        ownerId: policy.lease.ownerId,
        sessionKey: policy.lease.sessionKey,
        workspace: policy.lease.workspace,
        ttlSeconds: policy.lease.ttlSeconds,
      });
      return { ok: true, lease: handle.record, path: store.path };
    }

    const acquired = store.acquire({
      schemaVersion: 1,
      taskRef: request.taskRef,
      ownerType: request.ownerType,
      ownerId: request.ownerId,
      ...(request.sessionKey === undefined
        ? {}
        : { sessionKey: request.sessionKey }),
      workspace: request.workspace,
      acquiredAt: policy.lease.acquiredAt,
      heartbeatAt: policy.lease.heartbeatAt,
      ttlSeconds: policy.lease.ttlSeconds,
    } as LeaseRecordFile);

    if (isLeaseBusy(acquired)) {
      // A concurrent owner won the O_EXCL race.
      return busyFailure(acquired.busy as TaskLease);
    }
    return { ok: true, lease: acquired.record, path: acquired.path };
  } catch (error) {
    return failure("LEASE_UNAVAILABLE", errorMessage(error), "check permissions on the shared runtime");
  }
}

export function releaseTaskLease(
  taskRef: string,
  options: ReleaseLeaseOptions,
): ReleaseLeaseResult {
  try {
    const context = leaseContext(options);
    const store = createLeaseStore<LeaseRecordFile>({
      path: taskLeasePath(context.paths, taskRef),
      now: context.now,
      host: context.host,
      pid: context.pid,
      defaultTtlSeconds: DEFAULT_LEASE_TTL_SECONDS,
      liveness: "ttl",
    });
    const current = store.read();
    if (current === null) {
      return { ok: true, released: false, lease: null };
    }
    if (
      options.force !== true &&
      options.sessionKey !== undefined &&
      current.sessionKey !== undefined &&
      current.sessionKey !== options.sessionKey
    ) {
      return failure(
        "LEASE_BUSY",
        `task ${taskRef} is leased by ${current.ownerId}`,
        "pass --force to release another session's lease",
        leaseDetails(current),
      );
    }
    store.release({ path: store.path, record: current });
    return { ok: true, released: true, lease: current };
  } catch (error) {
    if (error instanceof LeaseError) {
      return failure(error.code, error.message, "retry or inspect the lease file");
    }
    return failure("LEASE_UNAVAILABLE", errorMessage(error), "inspect the shared runtime");
  }
}

export function leaseStatus(
  taskRef: string,
  options: LeaseStatusOptions,
): LeaseStatusResult {
  try {
    const context = leaseContext(options);
    const store = createLeaseStore<LeaseRecordFile>({
      path: taskLeasePath(context.paths, taskRef),
      now: context.now,
      host: context.host,
      pid: context.pid,
      defaultTtlSeconds: DEFAULT_LEASE_TTL_SECONDS,
      liveness: "ttl",
    });
    const lease = store.read();
    if (lease === null) {
      return {
        ok: true,
        lease: null,
        stale: false,
        remainingSeconds: 0,
        path: store.path,
      };
    }
    return {
      ok: true,
      lease,
      stale: isLeaseExpired(lease, context.now()),
      remainingSeconds: leaseRemainingSeconds(lease, context.now()),
      path: store.path,
    };
  } catch (error) {
    return failure("LEASE_UNAVAILABLE", errorMessage(error), "inspect the shared runtime");
  }
}

/** All lease records in the shared runtime, oldest heartbeat first. */
export function listTaskLeases(
  options: LeaseDependencies,
): readonly TaskLease[] {
  try {
    const context = leaseContext(options);
    let entries: string[];
    try {
      entries = fs.readdirSync(context.paths.leases);
    } catch {
      return [];
    }
    const leases: TaskLease[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(context.paths.leases, entry);
      const read = readRuntimeJson<LeaseRecordFile>(file, {
        supportedVersions: [1],
      });
      if (!read.ok || read.value === null) continue;
      if (typeof read.value.taskRef !== "string" || read.value.taskRef === "") {
        continue;
      }
      leases.push(toTaskLease(read.value));
    }
    return leases.sort((left, right) => {
      const delta = Date.parse(left.heartbeatAt) - Date.parse(right.heartbeatAt);
      if (Number.isNaN(delta) || delta === 0) {
        return left.taskRef.localeCompare(right.taskRef);
      }
      return delta;
    });
  } catch {
    return [];
  }
}

function leaseContext(options: LeaseDependencies): LeaseContext {
  const cwd = path.resolve(options.cwd);
  const gitPort =
    options.git ??
    createGitPort();
  const resolution = resolveSharedRuntime({ cwd, git: gitPort });
  ensureSharedRuntime(resolution.paths);
  const mainRoot =
    resolution.commonDir === null
      ? cwd
      : safeMainRoot(gitPort, cwd);
  return {
    mainRoot,
    paths: resolution.paths,
    git: gitPort,
    now: options.now ?? ((): Date => new Date()),
    host: options.host ?? hostname(),
    pid: options.pid ?? process.pid,
    env: options.env ?? process.env,
    argv: options.argv ?? process.argv.slice(2),
  };
}

function safeMainRoot(
  gitPort: Pick<GitPort, "mainWorktreeRoot">,
  cwd: string,
): string {
  try {
    return gitPort.mainWorktreeRoot(cwd);
  } catch {
    return cwd;
  }
}

function ownerIdentity(
  context: LeaseContext,
  options: AcquireLeaseOptions,
): { ownerId: string; sessionKey?: string } | null {
  const sessionKey = sessionKeyFor(context, options.sessionKey);
  const ownerId = options.ownerId?.trim();
  if (ownerId !== undefined && ownerId !== "") {
    return {
      ownerId,
      ...(sessionKey === null ? {} : { sessionKey }),
    };
  }
  if (sessionKey === null) return null;
  return {
    ownerId: `session:${sessionKey}`,
    sessionKey,
  };
}

function sessionKeyFor(
  context: LeaseContext,
  explicit: string | undefined,
): string | null {
  const trimmed = explicit?.trim();
  if (trimmed !== undefined && trimmed !== "") return trimmed;
  return resolveSessionKey(context);
}

function resolveSessionKey(context: LeaseContext): string | null {
  try {
    // `argv` enables the pre-shell ticket bridge; without it every ZCode-style
    // shell command fails with LEASE_OWNER_UNKNOWN.
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
    // A missing session identity must not fall back to the CLI process pid:
    // every command is a new process, so the pid is never a stable owner.
  }
  return null;
}

function ownerUnknown(context: LeaseContext, taskRef: string): LeaseFailure {
  const hint = findSoleSessionKey(context.mainRoot);
  if (hint.key !== null) {
    return failure(
      "LEASE_OWNER_UNKNOWN",
      `no owner identity was found; refusing to create a lease for ${taskRef} without one. ` +
        `This checkout has exactly one session (${hint.key}).`,
      `phronia task lease acquire ${taskRef} --session-key ${hint.key}`,
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
  return failure(
    "LEASE_OWNER_UNKNOWN",
    `no owner identity was found; refusing to create a lease without one.${ambiguity}`,
    "pass --owner-id <id> or set PHRONIA_CONTEXT_ID (or --session-key <key>)",
    hint.candidates.length > 0 ? { candidates: hint.candidates } : undefined,
  );
}

function resolveTaskWorkspace(context: LeaseContext, taskRef: string): string {
  try {
    const registry = readRuntimeJson<WorktreeRegistry>(context.paths.worktrees);
    if (registry.ok && registry.value !== null) {
      const entry = registry.value.worktrees.find(
        (item) => item.taskRef === taskRef,
      );
      if (entry !== undefined && entry.path !== "") {
        return entry.path;
      }
    }
  } catch {
    // Missing/corrupt registry is a diagnostic concern, not a lease error.
  }
  return context.mainRoot;
}

function sameLeaseOwner(left: TaskLease, right: TaskLease): boolean {
  return (
    left.ownerType === right.ownerType &&
    left.ownerId === right.ownerId &&
    left.sessionKey === right.sessionKey
  );
}

function toTaskLease(record: LeaseRecordFile): TaskLease {
  return {
    taskRef: record.taskRef,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    ...(typeof record.sessionKey === "string" ? { sessionKey: record.sessionKey } : {}),
    workspace: record.workspace,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
    ttlSeconds: record.ttlSeconds,
  };
}

function busyFailure(owner: TaskLease): LeaseFailure {
  return failure(
    "LEASE_BUSY",
    `task ${owner.taskRef} is already leased by ${owner.ownerId}`,
    `wait for ${owner.ownerId}, or run \`phronia task lease release ${owner.taskRef}\``,
    leaseDetails(owner),
  );
}

function leaseDetails(owner: TaskLease): Record<string, unknown> {
  return {
    taskRef: owner.taskRef,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    ...(owner.sessionKey === undefined ? {} : { sessionKey: owner.sessionKey }),
    workspace: owner.workspace,
    acquiredAt: owner.acquiredAt,
    heartbeatAt: owner.heartbeatAt,
  };
}

export function failure(
  code: string,
  message: string,
  next: string,
  details?: Readonly<Record<string, unknown>>,
): LeaseFailure {
  return {
    ok: false,
    code,
    message,
    next,
    ...(details === undefined ? {} : { details }),
  };
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
