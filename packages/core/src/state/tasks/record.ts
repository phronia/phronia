/**
 * Tolerant task.json reads.
 *
 * Unlike the strict `task/records.ts` SDK loader, the state layer must never
 * throw on a corrupt record: hooks need a diagnostic, not a crash.
 */

import path from "node:path";
import { diagnostic, type Diagnostic } from "../diagnostics.js";
import { isDirectory, readJson, type FsLike } from "../fs.js";
import { normalizeTaskRef, resolveTaskRef } from "./refs.js";

export interface TaskRecordView {
  /** Stored repo-relative reference. */
  ref: string;
  /** Absolute task directory. */
  dir: string;
  id: string;
  name: string;
  title: string;
  status: string | null;
  package: string | null;
  branch: string | null;
  baseBranch: string | null;
  parent: string | null;
  children: string[];
  relatedFiles: string[];
  meta: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export function readTaskRecord(
  root: string,
  taskRef: string,
  io: FsLike,
  diagnostics: Diagnostic[] = [],
): TaskRecordView | null {
  const resolved = resolveTaskRef(taskRef, root, io);
  if (!resolved) {
    diagnostics.push(
      diagnostic(
        "state.task.ref_outside_root",
        "warn",
        `task reference does not resolve inside the repository: ${taskRef}`,
      ),
    );
    return null;
  }
  if (!isDirectory(io, resolved.real)) {
    diagnostics.push(
      diagnostic("state.task.not_found", "warn", `task directory is missing: ${taskRef}`, {
        path: resolved.real,
      }),
    );
    return null;
  }

  const file = path.join(resolved.real, "task.json");
  const raw = readJson<unknown>(io, file);
  if (raw === null) {
    diagnostics.push(
      diagnostic("state.task.record_corrupt", "warn", `task.json is missing or invalid`, {
        path: file,
      }),
    );
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    diagnostics.push(
      diagnostic("state.task.record_corrupt", "warn", `task.json is not an object`, {
        path: file,
      }),
    );
    return null;
  }

  const record = raw as Record<string, unknown>;
  const id = stringField(record.id) ?? path.basename(resolved.real);
  return {
    ref: path.isAbsolute(taskRef) ? resolved.lexical : normalizeTaskRef(taskRef),
    dir: resolved.real,
    id,
    name: stringField(record.name) ?? id,
    title: stringField(record.title) ?? id,
    status: stringField(record.status),
    package: stringField(record.package),
    branch: stringField(record.branch),
    baseBranch: stringField(record.base_branch),
    parent: stringField(record.parent),
    children: stringArray(record.children),
    relatedFiles: stringArray(record.relatedFiles),
    meta: isPlainObject(record.meta) ? record.meta : {},
    raw: record,
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
