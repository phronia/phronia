/**
 * `phronia task commit <ref>` (R23).
 *
 * Thin rendering layer over `services/integrate.ts::commitTask`. A worktree
 * task is committed only inside its own worktree; running this in the main
 * checkout is refused with `COMMIT_WRONG_WORKSPACE`.
 */

import {
  commitTask,
  type CommitTaskResult,
} from "../services/integrate.js";

export interface CommitCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly message?: string;
}

export function runTaskCommit(
  taskRef: string,
  options: CommitCommandOptions,
): number {
  const result = commitTask(taskRef, {
    cwd: options.cwd,
    ...(options.message === undefined ? {} : { message: options.message }),
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodeFor(result);
  }
  if (!result.ok) {
    process.stderr.write(`${result.code}: ${result.message}\n`);
    process.stderr.write(`next: ${result.next}\n`);
    return exitCodeFor(result);
  }
  process.stdout.write(`${result.message}\n`);
  if (result.commit !== null) {
    process.stdout.write(`  commit: ${result.commit}\n`);
  }
  process.stdout.write(`  workspace: ${result.workspace}\n`);
  return 0;
}

function exitCodeFor(result: CommitTaskResult): number {
  if (result.ok) return 0;
  switch (result.code) {
    case "COMMIT_WRONG_WORKSPACE":
    case "INTEGRATE_DIRTY_CHECKOUT":
    case "GIT_FAILED":
      return 2;
    default:
      return 2;
  }
}
