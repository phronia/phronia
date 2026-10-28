/**
 * LeaseStore adapter (design.md §4.6, §7.1, §18.2, §19.5, §20.1).
 *
 * One implementation serves the three mutual-exclusion primitives:
 * `leases/<task>.json` (who is doing a task), `workspace.claim.json` (who owns
 * the main checkout), and `integration.lock` (who is integrating). The store
 * only performs atomic create/update/delete and generic staleness checks; it
 * does not interpret business state.
 *
 * Guarantees:
 * - acquire is `open(path, "wx")` — no read-then-write window;
 * - heartbeat rewrites through a same-directory temp file + rename;
 * - release closes any handle before unlinking (Windows-safe);
 * - a stale record is moved aside, never deleted in place;
 * - a handle that no longer owns the record gets `LEASE_LOST` instead of
 *   clobbering another owner.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SHARED_RUNTIME_SCHEMA_VERSION } from "@phronia/core/state";

const ACQUIRE_ATTEMPTS = 5;
const OWNERSHIP_KEYS = [
  "acquiredAt",
  "host",
  "pid",
  "ownerRef",
  "taskRef",
  "workspace",
] as const;

export type LeaseErrorCode = "LEASE_UNAVAILABLE" | "LEASE_LOST";

export class LeaseError extends Error {
  readonly code: LeaseErrorCode;

  constructor(code: LeaseErrorCode, message: string) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

/** Generic JSON envelope; concrete records add their own fields. */
export interface LeaseRecord {
  schemaVersion?: number;
  acquiredAt?: string;
  heartbeatAt?: string;
  ttlSeconds?: number;
  host?: string;
  pid?: number;
  [key: string]: unknown;
}

export interface LeaseHandle<T extends LeaseRecord = LeaseRecord> {
  readonly path: string;
  /** Last known record; updated by {@link LeaseStore.heartbeat}. */
  record: T;
}

export interface LeaseBusy<T extends LeaseRecord = LeaseRecord> {
  readonly busy: T;
}

export type LeaseAcquireResult<T extends LeaseRecord = LeaseRecord> =
  | LeaseHandle<T>
  | LeaseBusy<T>;

export interface LeaseStore<T extends LeaseRecord = LeaseRecord> {
  readonly path: string;
  /**
   * Atomically create the record. Returns the existing record under `busy`
   * when another owner holds it and it is not reclaimable.
   */
  acquire(record: T): LeaseAcquireResult<T>;
  /** Refresh `heartbeatAt` (and optionally other fields) with temp+rename. */
  heartbeat(handle: LeaseHandle<T>, patch?: Partial<T>): void;
  /** Close then unlink, but only when the handle still owns the record. */
  release(handle: LeaseHandle<T>): void;
  /** Current record, or null when missing/corrupt. */
  read(): T | null;
  /** TTL staleness, plus dead-pid when `liveness: "ttl-or-pid"`. */
  isStale(record: T, at?: Date): boolean;
}

/**
 * Staleness policy.
 *
 * `ttl` (the default) is the only safe default for workspace claims and task
 * leases: each `phronia` command is a short-lived process, so its pid is dead
 * as soon as the command returns even though the session is still active.
 * `ttl-or-pid` is opt-in and requires an injected `isProcessAlive` probe.
 */
export type LeaseLiveness = "ttl" | "ttl-or-pid";

export interface LeaseStoreOptions<T extends LeaseRecord = LeaseRecord> {
  readonly path: string;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
  /** Injectable hostname; defaults to `os.hostname()`. */
  readonly host?: string;
  /** Injectable pid; defaults to `process.pid`. */
  readonly pid?: number;
  /** Applied when a record has no `ttlSeconds`. */
  readonly defaultTtlSeconds?: number;
  /**
   * Staleness policy. Defaults to `"ttl"`; pid is diagnostic-only unless the
   * caller opts into `"ttl-or-pid"` and supplies `isProcessAlive`.
   */
  readonly liveness?: LeaseLiveness;
  /**
   * Decides whether an existing record may be reclaimed. Defaults to
   * {@link isLeaseStale}; pass a stricter predicate for task leases, where an
   * expired lease should require an explicit orchestrator reclaim.
   */
  readonly reclaimWhen?: (record: T, at: Date) => boolean;
  /**
   * Best-effort liveness probe for same-host records. Only consulted when
   * `liveness` is `"ttl-or-pid"`.
   */
  readonly isProcessAlive?: (pid: number) => boolean;
}

export function isLeaseBusy<T extends LeaseRecord>(
  result: LeaseAcquireResult<T>,
): result is LeaseBusy<T> {
  return "busy" in result;
}

/**
 * TTL staleness shared by acquire, the store's `isStale`, and callers that
 * implement their own policy.
 *
 * PID liveness is consulted only when `liveness` is `"ttl-or-pid"` **and** an
 * explicit `isProcessAlive` probe is supplied. The default is TTL-only because
 * command processes exit immediately while their session keeps working.
 */
export function isLeaseStale(
  record: LeaseRecord,
  at: Date,
  options: {
    readonly host?: string;
    readonly liveness?: LeaseLiveness;
    readonly isProcessAlive?: (pid: number) => boolean;
  } = {},
): boolean {
  const heartbeat = Date.parse(record.heartbeatAt ?? "");
  const ttl = record.ttlSeconds;
  if (
    Number.isFinite(heartbeat) &&
    typeof ttl === "number" &&
    ttl > 0 &&
    at.getTime() > heartbeat + ttl * 1000
  ) {
    return true;
  }

  if (
    options.liveness === "ttl-or-pid" &&
    options.isProcessAlive !== undefined &&
    options.host !== undefined &&
    record.host === options.host &&
    typeof record.pid === "number" &&
    record.pid > 0
  ) {
    return !options.isProcessAlive(record.pid);
  }

  return false;
}

export function createLeaseStore<T extends LeaseRecord = LeaseRecord>(
  options: LeaseStoreOptions<T>,
): LeaseStore<T> {
  const target = path.resolve(options.path);
  const directory = path.dirname(target);
  const now = options.now ?? ((): Date => new Date());
  const host = options.host ?? os.hostname();
  const pid = options.pid ?? process.pid;
  const liveness: LeaseLiveness = options.liveness ?? "ttl";
  let staleCounter = 0;

  const reclaimWhen =
    options.reclaimWhen ??
    ((record: T, at: Date): boolean =>
      isLeaseStale(record, at, {
        host,
        liveness,
        ...(options.isProcessAlive === undefined
          ? {}
          : { isProcessAlive: options.isProcessAlive }),
      }));

  function readRecord(): T | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as T)
        : null;
    } catch {
      return null;
    }
  }

  function moveAside(): boolean {
    staleCounter += 1;
    const suffix = `${now().getTime()}.${pid}.${staleCounter}`;
    const aside = `${target}.stale.${suffix}`;
    try {
      fs.renameSync(target, aside);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return true;
      }
      // Windows can refuse the rename while another process holds the file.
      return false;
    }
    try {
      fs.unlinkSync(aside);
    } catch {
      // Best effort: a leftover `.stale.*` file is harmless.
    }
    return true;
  }

  return {
    path: target,

    acquire(input: T): LeaseAcquireResult<T> {
      fs.mkdirSync(directory, { recursive: true });
      const record = normalizeRecord(input, {
        acquiredAt: now().toISOString(),
        host,
        pid,
        defaultTtlSeconds: options.defaultTtlSeconds,
      }) as T;

      for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
        let fd: number | null = null;
        try {
          fd = fs.openSync(target, "wx");
          try {
            fs.writeFileSync(fd, serialize(record), "utf8");
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
            fd = null;
          }
          return { path: target, record };
        } catch (error) {
          if (fd !== null) {
            try {
              fs.closeSync(fd);
            } catch {
              // Already closed.
            }
          }
          if (!isErrno(error, "EEXIST")) {
            throw new LeaseError(
              "LEASE_UNAVAILABLE",
              `cannot create lease ${target}: ${errorMessage(error)}`,
            );
          }
        }

        const current = readRecord();
        if (current === null) {
          // Corrupt/empty file: reclaim it so a crash cannot wedge the lock.
          if (!moveAside()) {
            const busy = readRecord();
            if (busy !== null) {
              return { busy };
            }
          }
          continue;
        }
        if (!reclaimWhen(current, now())) {
          return { busy: current };
        }
        if (!moveAside()) {
          const busy = readRecord();
          if (busy !== null) {
            return { busy };
          }
        }
      }

      const current = readRecord();
      if (current !== null) {
        return { busy: current };
      }
      throw new LeaseError(
        "LEASE_UNAVAILABLE",
        `cannot acquire lease ${target} after ${ACQUIRE_ATTEMPTS} attempts`,
      );
    },

    heartbeat(handle: LeaseHandle<T>, patch: Partial<T> = {}): void {
      const current = readRecord();
      if (current === null || !sameOwner(current, handle.record)) {
        throw new LeaseError(
          "LEASE_LOST",
          `lease ${target} is no longer owned by this handle`,
        );
      }
      const updated = {
        ...current,
        ...patch,
        heartbeatAt: now().toISOString(),
      } as T;
      writeAtomic(target, updated);
      handle.record = updated;
    },

    release(handle: LeaseHandle<T>): void {
      const current = readRecord();
      if (current !== null && !sameOwner(current, handle.record)) {
        throw new LeaseError(
          "LEASE_LOST",
          `refusing to release lease ${target}: owned by another handle`,
        );
      }
      // The file descriptor is closed immediately after writing, so unlink is
      // safe on Windows as well.
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw new LeaseError(
            "LEASE_UNAVAILABLE",
            `cannot release lease ${target}: ${errorMessage(error)}`,
          );
        }
      }
    },

    read(): T | null {
      return readRecord();
    },

    isStale(record: T, at: Date = now()): boolean {
      return isLeaseStale(record, at, {
        host,
        liveness,
        ...(options.isProcessAlive === undefined
          ? {}
          : { isProcessAlive: options.isProcessAlive }),
      });
    },
  };
}

function normalizeRecord(
  input: LeaseRecord,
  defaults: {
    readonly acquiredAt: string;
    readonly host: string;
    readonly pid: number;
    readonly defaultTtlSeconds?: number;
  },
): LeaseRecord {
  const record: LeaseRecord = { ...input };
  record.schemaVersion ??= SHARED_RUNTIME_SCHEMA_VERSION;
  record.acquiredAt ??= defaults.acquiredAt;
  record.heartbeatAt ??= record.acquiredAt;
  record.host ??= defaults.host;
  record.pid ??= defaults.pid;
  record.ttlSeconds ??= defaults.defaultTtlSeconds;
  return record;
}

function sameOwner(a: LeaseRecord, b: LeaseRecord): boolean {
  if (a.acquiredAt === undefined || b.acquiredAt === undefined) {
    return false;
  }
  return OWNERSHIP_KEYS.every(
    (key) => JSON.stringify(a[key]) === JSON.stringify(b[key]),
  );
}

function writeAtomic(target: string, record: LeaseRecord): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomSuffix()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx");
    fs.writeFileSync(fd, serialize(record), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // Temp file may not exist.
    }
    throw new LeaseError(
      "LEASE_UNAVAILABLE",
      `cannot update lease ${target}: ${errorMessage(error)}`,
    );
  }
}

function serialize(record: LeaseRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
