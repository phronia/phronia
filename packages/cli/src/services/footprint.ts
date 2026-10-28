/**
 * `phronia task footprint set` — declare the paths/globs a task may change.
 *
 * This is the only supported writer for `meta.parallel.touches`. It preserves
 * every other task.json field, deduplicates the patterns, and never guesses a
 * footprint. The planner treats an empty list as unknown (serial), so
 * `--clear` is an explicit way to remove a declaration.
 */

import path from "node:path";
import { findProjectRoot } from "@phronia/core/layout";
import { openState } from "@phronia/core/state";
import {
  loadTaskRecord,
  normalizePatternList,
  writeTaskRecord,
} from "@phronia/core/task";

export interface SetFootprintOptions {
  readonly cwd: string;
  readonly taskRef: string;
  readonly paths?: readonly string[];
  readonly clear?: boolean;
}

export type FootprintResult =
  | {
      readonly ok: true;
      readonly taskRef: string;
      readonly taskDir: string;
      readonly touches: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly next: string;
    };

export function setTaskFootprint(
  options: SetFootprintOptions,
): FootprintResult {
  const root = findProjectRoot(path.resolve(options.cwd));
  if (root === null) {
    return failure(
      "PROJECT_NOT_FOUND",
      "no .phronia/ project found from the current directory",
      "run this command inside a Phronia project",
    );
  }

  const view = openState({ root }).tasks.read(options.taskRef);
  if (view === null) {
    return failure(
      "TASK_NOT_FOUND",
      `task not found: ${options.taskRef}`,
      "pass a task directory or ref under .phronia/tasks/",
    );
  }

  const touches =
    options.clear === true
      ? []
      : normalizePatternList(options.paths ?? []);
  if (options.clear !== true && touches.length === 0) {
    return failure(
      "FOOTPRINT_EMPTY",
      "no footprint paths were provided",
      "pass one or more repo-relative paths/globs, or --clear",
    );
  }

  for (const touch of touches) {
    const normalized = touch.replace(/\\/g, "/");
    if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      return failure(
        "FOOTPRINT_INVALID",
        `footprint must be repo-relative and may not escape the repository: ${touch}`,
        "pass a path such as packages/cli/src/commands/**",
      );
    }
  }

  let record;
  try {
    record = loadTaskRecord({ taskDir: view.dir, cwd: root });
  } catch (error) {
    return failure(
      "TASK_RECORD_INVALID",
      `cannot read ${path.join(view.dir, "task.json")}: ${errorMessage(error)}`,
      "repair the task record and retry",
    );
  }

  const meta = isRecord(record.meta) ? record.meta : {};
  const parallel = isRecord(meta.parallel) ? meta.parallel : {};
  record.meta = { ...meta, parallel: { ...parallel, touches } };

  try {
    writeTaskRecord({ taskDir: view.dir, record, cwd: root });
  } catch (error) {
    return failure(
      "TASK_RECORD_WRITE_FAILED",
      `cannot write ${path.join(view.dir, "task.json")}: ${errorMessage(error)}`,
      "commit or stash concurrent edits, then retry",
    );
  }

  return {
    ok: true,
    taskRef: view.ref,
    taskDir: view.dir,
    touches,
  };
}

function failure(code: string, message: string, next: string): FootprintResult {
  return { ok: false, code, message, next };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
