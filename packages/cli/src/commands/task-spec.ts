/**
 * `phronia task spec plan|commit|status`.
 *
 * Thin rendering layer over `services/spec-sync.ts`; the service owns the
 * lock, git verification, commit, and `meta.spec_sync` write.
 */

import {
  commitSpecSync,
  planSpecSync,
  statusSpecSync,
  type SpecSyncFailure,
} from "../services/spec-sync.js";

export interface TaskSpecCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly allowMissing?: boolean;
  readonly sessionKey?: string;
  readonly refs?: readonly string[];
}

export function runTaskSpecPlan(
  refs: readonly string[],
  options: TaskSpecCommandOptions,
): number {
  const result = planSpecSync({
    cwd: options.cwd,
    refs,
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 2;
  }
  if (!result.ok) return renderFailure(result);

  for (const task of result.tasks) {
    process.stdout.write(
      `${task.taskRef}: ${task.status}${task.status === "none" ? " (no spec-delta.md)" : ""}\n`,
    );
    if (task.delta !== null) process.stdout.write(`  delta: ${task.delta}\n`);
    if (task.targetFiles.length > 0) {
      process.stdout.write(`  targets: ${task.targetFiles.join(", ")}\n`);
    }
    process.stdout.write(
      `  landed diff: ${task.landedDiff.baseSha ?? "?"}..${task.landedDiff.commit ?? "?"} (${task.landedDiff.files.length} file(s))\n`,
    );
    for (const file of task.currentSpec) {
      process.stdout.write(`  current: ${file.path} ${file.sha256 ?? "(missing)"}\n`);
    }
  }
  return 0;
}

export function runTaskSpecCommit(
  refs: readonly string[],
  options: TaskSpecCommandOptions,
): number {
  const result = commitSpecSync({
    cwd: options.cwd,
    refs,
    ...(options.allowMissing === true ? { allowMissing: true } : {}),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : exitCodeFor(result);
  }
  if (!result.ok) return renderFailure(result);

  process.stdout.write(`Synced ${result.files.length} spec file(s): ${result.commit}\n`);
  if (result.metadataCommit !== null) {
    process.stdout.write(`Recorded meta.spec_sync: ${result.metadataCommit}\n`);
  }
  for (const task of result.tasks) {
    process.stdout.write(`  ${task.taskRef}: ${task.status}\n`);
  }
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  return 0;
}

export function runTaskSpecStatus(
  refs: readonly string[],
  options: TaskSpecCommandOptions,
): number {
  const result = statusSpecSync({
    cwd: options.cwd,
    ...(refs.length === 0 ? {} : { refs }),
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 2;
  }
  if (!result.ok) return renderFailure(result);

  for (const task of result.tasks) {
    const detail =
      task.state === "synced" && task.commit !== null
        ? ` (${task.commit})`
        : task.deltaPath === null
          ? ""
          : ` (${task.deltaPath})`;
    process.stdout.write(`${task.state.padEnd(8)} ${task.taskRef}${detail}\n`);
  }
  return 0;
}

function renderFailure(result: SpecSyncFailure): number {
  process.stderr.write(`${result.code}: ${result.message}\n`);
  process.stderr.write(`next: ${result.next}\n`);
  return exitCodeFor(result);
}

function exitCodeFor(result: SpecSyncFailure): number {
  return result.code === "SPEC_SYNC_LOCK_BUSY" ? 3 : 2;
}
