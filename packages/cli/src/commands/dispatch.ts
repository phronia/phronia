/**
 * `phronia task parallel dispatch --batch <id>` (design.md §17.7, §18.3).
 *
 * Renders a dispatch manifest. It never starts an agent process: the
 * orchestrator uses the manifest with the harness's native sub-agent tool.
 */

import {
  dispatchBatch,
  type CoordinatorFailure,
  type DispatchResult,
} from "../services/coordinator.js";
import { exitCodeFor } from "./parallel.js";

export interface DispatchCommandOptions {
  readonly cwd: string;
  readonly batch: string;
  readonly wave?: number;
  readonly max?: number;
  readonly includePlanning?: boolean;
  readonly dryRun?: boolean;
  readonly platform?: string;
  readonly sessionKey?: string;
  readonly ownerId?: string;
  readonly json?: boolean;
}

export function runTaskDispatch(options: DispatchCommandOptions): number {
  const result = dispatchBatch({
    cwd: options.cwd,
    batchId: options.batch,
    ...(options.wave === undefined ? {} : { wave: options.wave }),
    ...(options.max === undefined ? {} : { maxConcurrent: options.max }),
    ...(options.includePlanning === true ? { includePlanning: true } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
  });

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(toJson(result), null, 2)}\n`);
  } else if (!result.ok) {
    printFailure(result);
  } else {
    printManifest(result);
  }
  return result.ok ? 0 : exitCodeFor(result.code);
}

function printManifest(result: Extract<DispatchResult, { ok: true }>): void {
  process.stdout.write(
    `Dispatch ${result.batch} wave ${result.wave}${
      result.dryRun ? " (dry run)" : ""
    }: ${result.tasks.length} task(s)\n`,
  );
  for (const task of result.tasks) {
    process.stdout.write(`\n${task.taskRef}\n`);
    process.stdout.write(`  workspace: ${task.workspace}\n`);
    process.stdout.write(`  branch: ${task.branch}\n`);
    process.stdout.write(`  lease: ${task.lease ?? "not acquired (dry run)"}\n`);
    process.stdout.write("  prompt prefix:\n");
    for (const line of task.promptPrefix.split("\n")) {
      process.stdout.write(`    ${line}\n`);
    }
  }
  for (const skipped of result.skipped) {
    process.stderr.write(`skipped ${skipped.taskRef}: ${skipped.code} ${skipped.message}\n`);
    process.stderr.write(`  next: ${skipped.next}\n`);
  }
  if (result.batchPath !== null) {
    process.stdout.write(`\nbatch summary: ${result.batchPath}\n`);
  }
  process.stdout.write(
    "\nPhronia did not start any agent process; dispatch the manifest with your harness.\n",
  );
}

function toJson(result: DispatchResult): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    batch: result.batch,
    wave: result.wave,
    dryRun: result.dryRun,
    manifest: result.manifest,
    tasks: result.tasks,
    skipped: result.skipped,
    batchPath: result.batchPath,
    manifestHash: result.manifestHash,
    diagnostics: result.diagnostics,
  };
}

function printFailure(failure: CoordinatorFailure): void {
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.stderr.write(`next: ${failure.next}\n`);
  const commands = failure.details?.commands;
  if (Array.isArray(commands)) {
    process.stderr.write("fallback plan:\n");
    for (const command of commands) {
      process.stderr.write(`  ${String(command)}\n`);
    }
  }
}
