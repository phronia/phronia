/**
 * Task directory enumeration.
 *
 * Active tasks live under `<workflow>/tasks/<MM-DD-slug>/`; archived tasks
 * under `<workflow>/tasks/archive/<YYYY-MM>/<MM-DD-slug>/`.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import { diagnostic, type Diagnostic } from "../diagnostics.js";
import { isDirectory, listDir, type FsLike } from "../fs.js";
import { readTaskRecord, type TaskRecordView } from "./record.js";

export interface TaskSummary {
  ref: string;
  dir: string;
  id: string;
  title: string;
  status: string | null;
  package: string | null;
  archived: boolean;
  archiveMonth?: string;
}

export interface ListTasksOptions {
  includeArchived?: boolean;
  /** Safety valve for very large repositories. Default 5000. */
  maxEntries?: number;
}

export function listTasks(
  root: string,
  io: FsLike,
  options: ListTasksOptions = {},
  diagnostics: Diagnostic[] = [],
): TaskSummary[] {
  const maxEntries = options.maxEntries ?? 5000;
  const tasksDir = path.join(root, LAYOUT.paths.tasks);
  const summaries: TaskSummary[] = [];

  for (const entry of listDir(io, tasksDir)) {
    if (entry === "archive") {
      continue;
    }
    if (!isTaskDirName(entry)) {
      continue;
    }
    const ref = `${LAYOUT.paths.tasks}/${entry}`;
    if (!isDirectory(io, path.join(tasksDir, entry))) {
      continue;
    }
    const record = readTaskRecord(root, ref, io, diagnostics);
    if (record) {
      summaries.push(toSummary(record, false));
    }
    if (summaries.length >= maxEntries) {
      diagnostics.push(
        diagnostic(
          "state.task.list_truncated",
          "warn",
          `task listing stopped at ${maxEntries} entries`,
        ),
      );
      return summaries;
    }
  }

  if (!options.includeArchived) {
    return summaries.sort(byTitle);
  }

  const archiveDir = path.join(root, LAYOUT.paths.tasksArchive);
  for (const month of listDir(io, archiveDir)) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      continue;
    }
    const monthDir = path.join(archiveDir, month);
    if (!isDirectory(io, monthDir)) {
      continue;
    }
    for (const entry of listDir(io, monthDir)) {
      if (!isTaskDirName(entry)) {
        continue;
      }
      const ref = `${LAYOUT.paths.tasksArchive}/${month}/${entry}`;
      const record = readTaskRecord(root, ref, io, diagnostics);
      if (record) {
        summaries.push(toSummary(record, true, month));
      }
      if (summaries.length >= maxEntries) {
        diagnostics.push(
          diagnostic(
            "state.task.list_truncated",
            "warn",
            `task listing stopped at ${maxEntries} entries`,
          ),
        );
        return summaries.sort(byTitle);
      }
    }
  }

  return summaries.sort(byTitle);
}

function toSummary(
  record: TaskRecordView,
  archived: boolean,
  archiveMonth?: string,
): TaskSummary {
  return {
    ref: record.ref,
    dir: record.dir,
    id: record.id,
    title: record.title,
    status: record.status,
    package: record.package,
    archived,
    archiveMonth,
  };
}

function isTaskDirName(name: string): boolean {
  return /^\d{2}-\d{2}-[A-Za-z0-9._-]+$/.test(name);
}

function byTitle(left: TaskSummary, right: TaskSummary): number {
  return left.ref.localeCompare(right.ref);
}
