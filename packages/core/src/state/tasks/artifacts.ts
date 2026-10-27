/**
 * Task artifact presence and curated JSONL counts.
 *
 * Mirrors `common/task_context.py` and `session-start.py`: a JSONL row counts
 * only when it has a truthy `file` (or `path`) value. Placeholder rows such as
 * `{"_example": "..."}` are not curated context.
 */

import path from "node:path";
import { diagnostic, type Diagnostic } from "../diagnostics.js";
import { isDirectory, readText, type FsLike } from "../fs.js";
import { resolveTaskRef } from "./refs.js";

export type ContextKind = "implement" | "check";

export interface TaskArtifacts {
  prd: boolean;
  design: boolean;
  implement: boolean;
  implementJsonl: boolean;
  checkJsonl: boolean;
  research: boolean;
  sizes: Record<string, number>;
}

const ARTIFACT_FILES = [
  "prd.md",
  "design.md",
  "implement.md",
  "implement.jsonl",
  "check.jsonl",
] as const;

export function inspectTaskArtifacts(
  root: string,
  taskRef: string,
  io: FsLike,
): TaskArtifacts {
  const resolved = resolveTaskRef(taskRef, root, io);
  const sizes: Record<string, number> = {};
  if (!resolved || !isDirectory(io, resolved.real)) {
    return {
      prd: false,
      design: false,
      implement: false,
      implementJsonl: false,
      checkJsonl: false,
      research: false,
      sizes,
    };
  }
  for (const name of ARTIFACT_FILES) {
    const content = readText(io, path.join(resolved.real, name));
    if (content !== null) {
      sizes[name] = Buffer.byteLength(content, "utf8");
    }
  }
  return {
    prd: "prd.md" in sizes,
    design: "design.md" in sizes,
    implement: "implement.md" in sizes,
    implementJsonl: "implement.jsonl" in sizes,
    checkJsonl: "check.jsonl" in sizes,
    research: isDirectory(io, path.join(resolved.real, "research")),
    sizes,
  };
}

/** Count JSONL rows with a truthy `file` or `path`. */
export function countCuratedEntries(
  root: string,
  taskRef: string,
  kind: ContextKind,
  io: FsLike,
  diagnostics: Diagnostic[] = [],
): number {
  const resolved = resolveTaskRef(taskRef, root, io);
  if (!resolved) {
    return 0;
  }
  const file = path.join(
    resolved.real,
    kind === "implement" ? "implement.jsonl" : "check.jsonl",
  );
  const content = readText(io, file);
  if (content === null) {
    return 0;
  }
  let count = 0;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const row = JSON.parse(trimmed) as unknown;
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        continue;
      }
      const record = row as Record<string, unknown>;
      const value = record.file ?? record.path;
      if (typeof value === "string" && value.trim().length > 0) {
        count += 1;
      }
    } catch {
      diagnostics.push(
        diagnostic(
          "state.task.jsonl_malformed",
          "warn",
          `malformed JSONL row in ${kind}.jsonl`,
          { path: file, details: { line: index + 1 } },
        ),
      );
    }
  }
  return count;
}
