/**
 * `phronia task footprint set|clear` (R1, PLAN-03).
 *
 * Thin rendering layer over `services/footprint.ts`; the service owns the
 * task.json read/write and validation.
 */

import {
  setTaskFootprint,
  type FootprintResult,
} from "../services/footprint.js";

export interface FootprintCommandOptions {
  readonly cwd: string;
  readonly paths?: readonly string[];
  readonly clear?: boolean;
  readonly json?: boolean;
}

export function runTaskFootprintSet(
  taskRef: string,
  options: FootprintCommandOptions,
): number {
  const result = setTaskFootprint({
    cwd: options.cwd,
    taskRef,
    ...(options.paths === undefined ? {} : { paths: options.paths }),
    ...(options.clear === true ? { clear: true } : {}),
  });

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 2;
  }
  if (!result.ok) {
    process.stderr.write(`${result.code}: ${result.message}\n`);
    process.stderr.write(`next: ${result.next}\n`);
    return 2;
  }
  process.stdout.write(
    result.touches.length === 0
      ? `Cleared footprint for ${result.taskRef}\n`
      : `Footprint for ${result.taskRef}:\n${result.touches
          .map((touch) => `  ${touch}`)
          .join("\n")}\n`,
  );
  return 0;
}

export function runTaskFootprintClear(
  taskRef: string,
  options: FootprintCommandOptions,
): number {
  return runTaskFootprintSet(taskRef, { ...options, clear: true });
}

export type { FootprintResult };
