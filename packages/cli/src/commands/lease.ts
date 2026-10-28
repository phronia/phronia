/**
 * `phronia task lease acquire|release|status`.
 *
 * Thin rendering layer over `services/lease.ts`; business rules (atomic
 * acquisition, TTL, ownership) live in core/W2.
 */

import {
  acquireTaskLease,
  leaseStatus,
  releaseTaskLease,
  type LeaseFailure,
  type LeaseStatusResult,
} from "../services/lease.js";
import { exitCodeFor } from "./parallel.js";

export interface LeaseCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly ownerType?: "session" | "subagent" | "task";
  readonly ownerId?: string;
  readonly sessionKey?: string;
  readonly workspace?: string;
  readonly ttlSeconds?: number;
  readonly force?: boolean;
}

export function runLeaseAcquire(
  taskRef: string,
  options: LeaseCommandOptions,
): number {
  const result = acquireTaskLease(taskRef, {
    cwd: options.cwd,
    ...(options.ownerType === undefined ? {} : { ownerType: options.ownerType }),
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    printFailure(result);
  } else {
    process.stdout.write(
      `Lease acquired: ${result.lease.taskRef} by ${result.lease.ownerType}:${result.lease.ownerId}\n`,
    );
    process.stdout.write(`  workspace: ${result.lease.workspace}\n`);
    process.stdout.write(`  ttl: ${result.lease.ttlSeconds}s\n`);
    process.stdout.write(`  file: ${result.path}\n`);
  }
  return result.ok ? 0 : exitCodeFor(result.code);
}

export function runLeaseRelease(
  taskRef: string,
  options: LeaseCommandOptions,
): number {
  const result = releaseTaskLease(taskRef, {
    cwd: options.cwd,
    ...(options.force === true ? { force: true } : {}),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    printFailure(result);
  } else if (result.released) {
    process.stdout.write(`Lease released: ${taskRef}\n`);
  } else {
    process.stdout.write(`No lease to release for ${taskRef}\n`);
  }
  return result.ok ? 0 : exitCodeFor(result.code);
}

export function runLeaseStatus(
  taskRef: string,
  options: LeaseCommandOptions,
): number {
  const result = leaseStatus(taskRef, { cwd: options.cwd });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    printFailure(result);
  } else {
    printStatus(taskRef, result);
  }
  return result.ok ? 0 : exitCodeFor(result.code);
}

function printStatus(
  taskRef: string,
  result: Extract<LeaseStatusResult, { ok: true }>,
): void {
  if (result.lease === null) {
    process.stdout.write(`No lease for ${taskRef}\n`);
    return;
  }
  const lease = result.lease;
  process.stdout.write(
    `${lease.taskRef}: ${lease.ownerType}:${lease.ownerId}${
      result.stale ? " (stale)" : ""
    }\n`,
  );
  process.stdout.write(`  workspace: ${lease.workspace}\n`);
  process.stdout.write(`  acquired: ${lease.acquiredAt}\n`);
  process.stdout.write(`  heartbeat: ${lease.heartbeatAt}\n`);
  process.stdout.write(
    `  remaining: ${result.stale ? 0 : result.remainingSeconds}s / ${lease.ttlSeconds}s\n`,
  );
  process.stdout.write(`  file: ${result.path}\n`);
}

function printFailure(failure: LeaseFailure): void {
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.stderr.write(`next: ${failure.next}\n`);
}
