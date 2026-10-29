/**
 * Shared integration lock.
 *
 * `task integrate` and `task spec commit` both land work in the main checkout
 * and must serialize on the same `<git-common-dir>/phronia/integration.lock`.
 * This module owns the record shape, acquisition, optional wait, and release;
 * callers keep their own queue/phase policy.
 *
 * The lock file, TTL, ownership fields, and `INTEGRATE_LOCK_BUSY` details are
 * unchanged from the original integrate implementation.
 */

import path from "node:path";
import os from "node:os";
import {
  isLeaseBusy,
  LeaseError,
  createLeaseStore,
  type LeaseHandle,
  type LeaseRecord,
  type LeaseStore,
} from "../adapters/lease.js";
import { createGitPort, type GitPort } from "../adapters/git.js";
import { resolveSharedRuntime } from "../adapters/shared-runtime.js";
import type { SharedRuntimePaths } from "@phronia/core/state";

export const DEFAULT_LOCK_TTL_SECONDS = 30 * 60;
export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const WAIT_POLL_MS = 500;

export type IntegrationLockPhase =
  | "acquiring"
  | "rebasing"
  | "verifying"
  | "merging"
  | "done";

export interface IntegrationLockRecord extends LeaseRecord {
  schemaVersion: number;
  owner: string;
  taskRef: string;
  host: string;
  pid: number;
  phase: IntegrationLockPhase;
  baseBranch: string;
  preLandSha: string;
  postLandSha: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
  /** Present when the caller knows which session owns the lock. */
  sessionKey?: string;
  /** `integrate` (default) or a control-plane operation such as spec sync. */
  kind?: "integrate" | "spec-sync";
}

export interface AcquireIntegrationLockOptions {
  /** Any checkout of the repository; the lock always lives in the common dir. */
  readonly cwd: string;
  readonly git?: GitPort;
  readonly sessionKey?: string;
  readonly taskRef: string;
  /** Base branch recorded for diagnostics. Defaults to the current branch. */
  readonly baseBranch?: string;
  /** Defaults to `acquiring`. */
  readonly phase?: IntegrationLockPhase;
  readonly preLandSha?: string;
  /** Defaults to {@link DEFAULT_LOCK_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
  /** Poll while another owner holds the lock (opt-in; default is fail fast). */
  readonly wait?: boolean;
  readonly waitTimeoutMs?: number;
  readonly owner?: string;
  readonly kind?: "integrate" | "spec-sync";
  /** Code returned when the lock is held. Integrate keeps its historical code. */
  readonly busyCode?: string;
  readonly now?: () => Date;
  readonly host?: string;
  readonly pid?: number;
  /** Pre-resolved runtime paths (keeps callers on one resolution). */
  readonly paths?: SharedRuntimePaths;
  readonly hostname?: () => string;
}

export interface IntegrationLockFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly next: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type IntegrationLockResult =
  | {
      readonly ok: true;
      readonly handle: LeaseHandle<IntegrationLockRecord>;
      readonly store: LeaseStore<IntegrationLockRecord>;
    }
  | IntegrationLockFailure;

/**
 * Acquire the integration lock.
 *
 * `wait` polls until the lock frees or `waitTimeoutMs` elapses; without it the
 * first busy result is returned, preserving the fast-fail behavior integrate
 * relies on for `--queue`.
 */
export function acquireIntegrationLock(
  options: AcquireIntegrationLockOptions,
): IntegrationLockResult {
  const git = options.git ?? createGitPort();
  const paths =
    options.paths ??
    resolveSharedRuntime({ cwd: path.resolve(options.cwd), git }).paths;
  const now = options.now ?? ((): Date => new Date());
  const host = options.host ?? (options.hostname ?? defaultHostname)();
  const pid = options.pid ?? process.pid;
  const ttl = Math.max(1, Math.floor(options.ttlSeconds ?? DEFAULT_LOCK_TTL_SECONDS));
  const busyCode = options.busyCode ?? "INTEGRATE_LOCK_BUSY";
  const baseBranch =
    nonEmpty(options.baseBranch) ??
    nonEmpty(safeBranch(git, options.cwd)) ??
    "main";
  const store = createLeaseStore<IntegrationLockRecord>({
    path: paths.integrationLock,
    now,
    host,
    pid,
    defaultTtlSeconds: ttl,
    liveness: "ttl",
  });

  const deadline =
    options.wait === true
      ? now().getTime() + (options.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS)
      : null;

  for (;;) {
    const result = tryAcquire({
      store,
      taskRef: options.taskRef,
      owner: options.owner ?? options.taskRef,
      sessionKey: options.sessionKey,
      kind: options.kind ?? "integrate",
      baseBranch,
      phase: options.phase ?? "acquiring",
      preLandSha: options.preLandSha ?? "",
      now,
      host,
      pid,
      ttl,
      busyCode,
    });
    if (result.ok || result.code !== busyCode || deadline === null) {
      return result;
    }
    if (now().getTime() >= deadline) {
      return {
        ...result,
        message: `${result.message}; timed out waiting for the integration lock`,
        next: "retry with a larger timeout, or finish the current integrator",
      };
    }
    sleepSync(WAIT_POLL_MS);
  }
}

interface TryAcquireInput {
  readonly store: LeaseStore<IntegrationLockRecord>;
  readonly taskRef: string;
  readonly owner: string;
  readonly sessionKey?: string;
  readonly kind: "integrate" | "spec-sync";
  readonly baseBranch: string;
  readonly phase: IntegrationLockPhase;
  readonly preLandSha: string;
  readonly now: () => Date;
  readonly host: string;
  readonly pid: number;
  readonly ttl: number;
  readonly busyCode: string;
}

function tryAcquire(input: TryAcquireInput): IntegrationLockResult {
  const nowIso = input.now().toISOString();
  const record: IntegrationLockRecord = {
    schemaVersion: 1,
    owner: input.owner,
    taskRef: input.taskRef,
    host: input.host,
    pid: input.pid,
    phase: input.phase,
    baseBranch: input.baseBranch,
    preLandSha: input.preLandSha,
    postLandSha: null,
    acquiredAt: nowIso,
    heartbeatAt: nowIso,
    ttlSeconds: input.ttl,
    kind: input.kind,
    ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey }),
  };
  try {
    const acquired = input.store.acquire(record);
    if (isLeaseBusy(acquired)) {
      return {
        ok: false,
        code: input.busyCode,
        message: `another integration is in progress: ${describeOwner(acquired.busy)}`,
        next:
          input.busyCode === "SPEC_SYNC_LOCK_BUSY"
            ? "wait for the current integrate/spec sync to finish, then retry"
            : "use --queue, --wait, or retry after the current integration finishes",
        details: {
          owner: acquired.busy.owner ?? null,
          phase: acquired.busy.phase ?? null,
          baseBranch: acquired.busy.baseBranch ?? null,
          preLandSha: acquired.busy.preLandSha ?? null,
          kind: acquired.busy.kind ?? null,
        },
      };
    }
    return { ok: true, handle: acquired, store: input.store };
  } catch (error) {
    if (error instanceof LeaseError) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        next: "inspect the shared runtime and retry",
      };
    }
    return {
      ok: false,
      code: input.busyCode,
      message: `cannot acquire the integration lock: ${errorMessage(error)}`,
      next: "inspect the shared runtime permissions and retry",
    };
  }
}

/** Release the lock; a leftover lock is recoverable, so this never throws. */
export function releaseIntegrationLock(
  handle: LeaseHandle<IntegrationLockRecord> | null,
  store: LeaseStore<IntegrationLockRecord> | null,
): void {
  if (handle === null || store === null) return;
  try {
    store.release(handle);
  } catch {
    // A lock that cannot be removed is still reported by the next run.
  }
}

function describeOwner(record: IntegrationLockRecord): string {
  const owner = record.owner ?? record.taskRef ?? "unknown";
  const phase = record.phase ?? "acquiring";
  return `${String(owner)} (${String(phase)})`;
}

function safeBranch(git: GitPort, cwd: string): string {
  try {
    return git.branch(cwd);
  } catch {
    return "";
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function defaultHostname(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown-host";
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
