/**
 * `phronia task worktree add|list|attach|remove|prune`.
 *
 * The worktree primitives now delegate to `services/workspace.ts`, which uses
 * the W2 `GitPort` and the shared registry. `task.json.worktree_path` /
 * `branch` are no longer written; the legacy fields are still read as a
 * fallback (design.md §13).
 */

import {
  addWorktree as addWorktreeService,
  attachWorktree as attachWorktreeService,
  listWorktrees as listWorktreesService,
  pruneWorktrees as pruneWorktreesService,
  removeWorktree as removeWorktreeService,
  type PruneOptions,
  type PruneResult,
  type WorktreeOptions as ServiceWorktreeOptions,
  type WorktreeRecord,
  type WorktreeResult,
} from "../services/workspace.js";
import { exitCodeFor } from "./parallel.js";

export type { WorktreeRecord, WorktreeResult, PruneResult };

export interface WorktreeOptions {
  cwd: string;
  json?: boolean;
  force?: boolean;
  path?: string;
  branch?: string;
  base?: string;
  deleteBranch?: boolean;
  /** `--copy <path>` (repeatable); defaults to `parallel.copy`. */
  copy?: readonly string[];
  /** `--post-create <cmd>` (repeatable); defaults to `parallel.post_create`. */
  postCreate?: readonly string[];
}


export function addWorktree(
  taskRef: string,
  options: WorktreeOptions,
): WorktreeResult {
  return addWorktreeService(taskRef, toServiceOptions(options));
}

export function listWorktrees(options: {
  cwd: string;
  json?: boolean;
  includeMissing?: boolean;
}): WorktreeRecord[] {
  return listWorktreesService({
    cwd: options.cwd,
    ...(options.includeMissing === true ? { includeMissing: true } : {}),
  });
}

export function attachWorktree(
  taskRef: string,
  options: WorktreeOptions,
): WorktreeResult {
  return attachWorktreeService(taskRef, {
    cwd: options.cwd,
    ...(options.path === undefined ? {} : { path: options.path }),
  });
}

export function removeWorktree(
  taskRef: string,
  options: WorktreeOptions,
): WorktreeResult {
  return removeWorktreeService(taskRef, toServiceOptions(options));
}

export function pruneWorktrees(options: PruneOptions): PruneResult {
  return pruneWorktreesService(options);
}

export function runWorktreeAdd(
  taskRef: string,
  options: WorktreeOptions,
): number {
  return renderWorktree(addWorktree(taskRef, options), options.json === true);
}

export function runWorktreeAttach(
  taskRef: string,
  options: WorktreeOptions,
): number {
  return renderWorktree(attachWorktree(taskRef, options), options.json === true);
}

export function runWorktreeRemove(
  taskRef: string,
  options: WorktreeOptions,
): number {
  return renderWorktree(removeWorktree(taskRef, options), options.json === true);
}

export function runWorktreeList(options: WorktreeOptions): number {
  const records = listWorktrees({
    cwd: options.cwd,
    includeMissing: false,
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ worktrees: records }, null, 2)}\n`);
    return 0;
  }
  if (records.length === 0) {
    process.stdout.write("No task worktrees.\n");
    return 0;
  }
  for (const record of records) {
    process.stdout.write(
      `${record.taskRef.padEnd(40)} ${record.branch.padEnd(30)} ${record.path}\n`,
    );
  }
  return 0;
}

export function runWorktreePrune(options: WorktreeOptions & {
  dryRun?: boolean;
  olderThan?: string;
}): number {
  const result = pruneWorktrees({
    cwd: options.cwd,
    ...(options.dryRun === true ? { dryRun: true } : {}),
    ...(options.olderThan === undefined ? {} : { olderThan: options.olderThan }),
    ...(options.deleteBranch === true ? { deleteBranch: true } : {}),
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.stderr.write("next: pass --older-than with a valid duration (e.g. 7d)\n");
  } else {
    process.stdout.write(`${result.message}\n`);
    for (const kept of result.kept) {
      process.stdout.write(`  kept ${kept.taskRef || "(provisional)"}: ${kept.reason}\n`);
    }
  }
  return result.ok ? 0 : 2;
}

function renderWorktree(result: WorktreeResult, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.code ?? "WORKTREE_FAILED"}: ${result.message}\n`);
    if (result.next !== undefined && result.next !== "") {
      process.stderr.write(`next: ${result.next}\n`);
    }
  }
  return result.ok ? 0 : exitCodeFor(result.code ?? "GIT_FAILED");
}

function toServiceOptions(options: WorktreeOptions): ServiceWorktreeOptions {
  return {
    cwd: options.cwd,
    ...(options.force === true ? { force: true } : {}),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.deleteBranch === true ? { deleteBranch: true } : {}),
    ...(options.copy === undefined ? {} : { copy: options.copy }),
    ...(options.postCreate === undefined ? {} : { postCreate: options.postCreate }),
  };
}
