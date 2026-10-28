/**
 * `phronia task coordinator status [--batch <id>]` (design.md §17, §20.5).
 *
 * Aggregates the task index, leases, and integration outcomes. Blocked tasks
 * are reported but do not stop the batch; stale leases are guidance only.
 */

import {
  coordinatorStatus,
  type CoordinatorFailure,
  type CoordinatorStatusResult,
} from "../services/coordinator.js";
import { exitCodeFor } from "./parallel.js";

export interface CoordinatorStatusCommandOptions {
  readonly cwd: string;
  readonly batch?: string;
  readonly platform?: string;
  readonly json?: boolean;
}

export function runCoordinatorStatus(
  options: CoordinatorStatusCommandOptions,
): number {
  const result = coordinatorStatus({
    cwd: options.cwd,
    ...(options.batch === undefined ? {} : { batch: options.batch }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(toJson(result), null, 2)}\n`);
  } else if (!result.ok) {
    printFailure(result);
  } else {
    printStatus(result);
  }
  return result.ok ? 0 : exitCodeFor(result.code);
}

function printStatus(result: Extract<CoordinatorStatusResult, { ok: true }>): void {
  process.stdout.write(
    `Coordinator ${result.batch ?? "all tasks"}${
      result.wave === null ? "" : ` wave ${result.wave}`
    }\n`,
  );
  if (result.capabilities !== null) {
    const gate = result.capabilities.coordinator;
    process.stdout.write(
      `Native coordinator: ${gate.available ? "available" : `unavailable (${gate.reason ?? "unknown"})`}${
        gate.fallback === null ? "" : `; fallback=${gate.fallback}`
      }\n`,
    );
  }
  process.stdout.write(
    `queued=${result.summary.queued.length} running=${result.summary.running.length} blocked=${result.summary.blocked.length} landed=${result.summary.landed.length} needs_human=${result.summary.needsHuman.length}\n`,
  );
  for (const task of result.tasks) {
    process.stdout.write(
      `  ${task.ref} [${task.batchState}] status=${task.status} integration=${task.integration.outcome}\n`,
    );
    if (task.workspace !== null) process.stdout.write(`    workspace: ${task.workspace}\n`);
    if (task.lease !== null) {
      process.stdout.write(
        `    lease: ${task.lease.ownerType}:${task.lease.ownerId}${
          task.lease.stale ? " (stale)" : ""
        }\n`,
      );
    }
  }
  for (const lease of result.staleLeases) {
    process.stderr.write(
      `stale lease: ${lease.taskRef} (${lease.ownerId}) — no auto-reclaim; run ${lease.next}\n`,
    );
  }
  if (result.next !== null) {
    process.stdout.write(`next: ${result.next}\n`);
  }
}

function toJson(result: CoordinatorStatusResult): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    batch: result.batch,
    wave: result.wave,
    tasks: result.tasks,
    summary: result.summary,
    staleLeases: result.staleLeases,
    capabilities: result.capabilities,
    next: result.next,
    diagnostics: result.diagnostics,
  };
}

function printFailure(failure: CoordinatorFailure): void {
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.stderr.write(`next: ${failure.next}\n`);
}
