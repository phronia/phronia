/**
 * Memory floor: records Phronia itself writes under `.phronia/`.
 *
 * The floor is always available, unlike the seven harness session readers.
 * It covers session journals, task summaries, and spec sections. Search
 * results stay in their own partition so a curated journal hit never competes
 * with a chat transcript for the same score.
 */

import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import { isDirectory, listDir, nodeFs, readText, type FsLike } from "../state/fs.js";
import { listTasks } from "../state/tasks/list.js";
import { readTaskRecord } from "../state/tasks/record.js";
import type { MemWarning } from "./types.js";

export type MemoryKind = "journal" | "task-summary" | "spec";

export interface MemRecord {
  id: string;
  kind: MemoryKind;
  title: string;
  text: string;
  createdAt?: string;
  taskId?: string;
  branch?: string;
  source: {
    kind: "phronia";
    path: string;
    lineStart?: number;
    lineEnd?: number;
  };
  refs?: {
    taskPath?: string;
    specPath?: string;
  };
  trust: "curated" | "derived";
}

export interface FloorSearchOptions {
  kinds?: readonly MemoryKind[];
  limit?: number;
}

export interface FloorRecordHit {
  record: MemRecord;
  score: number;
  snippet: string;
}

export interface FloorSearchResult {
  hits: FloorRecordHit[];
  total: number;
  warnings: MemWarning[];
}

export interface FloorListResult {
  records: MemRecord[];
  warnings: MemWarning[];
}

const MAX_JOURNAL_SESSIONS = 500;
const MAX_TASKS = 500;
const MAX_TASK_TEXT = 4000;
const MAX_JOURNAL_TEXT = 4000;
const MAX_SPEC_SECTION = 4000;

export function listFloorRecords(
  root: string,
  io: FsLike = nodeFs,
  options: { maxTasks?: number } = {},
): FloorListResult {
  const warnings: MemWarning[] = [];
  const records: MemRecord[] = [];
  records.push(...readJournals(root, io, warnings));
  records.push(
    ...readTaskSummaries(root, io, warnings, options.maxTasks ?? MAX_TASKS),
  );
  records.push(...readSpecRecords(root, io, warnings));
  return { records, warnings };
}

export function searchFloor(
  root: string,
  query: string,
  options: FloorSearchOptions = {},
  io: FsLike = nodeFs,
): FloorSearchResult {
  const { records, warnings } = listFloorRecords(root, io);
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return { hits: [], total: 0, warnings };
  }
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const hits: FloorRecordHit[] = [];
  for (const record of records) {
    if (kinds && !kinds.has(record.kind)) continue;
    const titleHits = countOccurrences(record.title.toLowerCase(), needle);
    const refHits = countOccurrences(
      [record.taskId, record.source.path, record.branch].filter(Boolean).join(" ").toLowerCase(),
      needle,
    );
    const textHits = countOccurrences(record.text.toLowerCase(), needle);
    const score = titleHits * 5 + refHits * 3 + textHits;
    if (score === 0) continue;
    hits.push({ record, score, snippet: snippetFor(record.text, needle) });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (b.record.createdAt ?? "").localeCompare(a.record.createdAt ?? ""),
  );
  const limit = options.limit ?? 50;
  return {
    hits: hits.slice(0, limit),
    total: hits.length,
    warnings,
  };
}

function readJournals(
  root: string,
  io: FsLike,
  warnings: MemWarning[],
): MemRecord[] {
  const workspace = path.join(root, LAYOUT.paths.workspace);
  if (!isDirectory(io, workspace)) return [];
  const records: MemRecord[] = [];
  for (const developer of listDir(io, workspace)) {
    const dir = path.join(workspace, developer);
    if (!isDirectory(io, dir)) continue;
    for (const file of listDir(io, dir).sort()) {
      if (!file.startsWith("journal-") || !file.endsWith(".md")) continue;
      const full = path.join(dir, file);
      const content = readText(io, full);
      if (content === null) {
        warnings.push({
          code: "mem.floor.journal_unreadable",
          message: `journal is unreadable: ${path.relative(root, full)}`,
        });
        continue;
      }
      records.push(...parseJournal(root, developer, full, content));
      if (records.length >= MAX_JOURNAL_SESSIONS) return records;
    }
  }
  return records;
}

interface JournalSection {
  title: string;
  date?: string;
  task?: string;
  branch?: string;
  body: string;
  lineStart: number;
  lineEnd: number;
}

export function parseJournal(
  root: string,
  developer: string,
  file: string,
  content: string,
): MemRecord[] {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const lines = content.split(/\r?\n/);
  const sections: JournalSection[] = [];
  let current: JournalSection | null = null;

  lines.forEach((line, index) => {
    const heading = /^## Session\s+(\d+)\s*:\s*(.*)$/.exec(line);
    if (heading) {
      if (current) {
        current.lineEnd = index;
        sections.push(current);
      }
      current = {
        title: heading[2]?.trim() || `Session ${heading[1]}`,
        body: "",
        lineStart: index + 1,
        lineEnd: index + 1,
      };
      return;
    }
    if (!current) return;
    const field = /^\*\*(Date|Task|Branch)\*\*:\s*(.*)$/.exec(line);
    if (field) {
      const value = field[2]?.trim() ?? "";
      if (field[1] === "Date") current.date = value;
      else if (field[1] === "Task") current.task = value;
      else current.branch = value;
      return;
    }
    current.body += `${line}\n`;
  });
  if (current) sections.push(current);

  return sections.map((section) => {
    const number = section.title.match(/^Session\s+(\d+)/)?.[1] ?? "0";
    return {
      id: `journal:${developer}:${path.basename(relative)}#${number}`,
      kind: "journal" as const,
      title: `Journal — ${section.title}`,
      text: truncate(section.body.trim(), MAX_JOURNAL_TEXT),
      ...(section.date ? { createdAt: section.date } : {}),
      ...(section.branch ? { branch: section.branch } : {}),
      source: {
        kind: "phronia" as const,
        path: relative,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
      },
      ...(section.task ? { refs: { taskPath: section.task } } : {}),
      trust: "curated" as const,
    };
  });
}

function readTaskSummaries(
  root: string,
  io: FsLike,
  warnings: MemWarning[],
  maxTasks: number,
): MemRecord[] {
  const summaries = listTasks(root, io, {
    includeArchived: true,
    maxEntries: maxTasks,
  });
  if (summaries.length >= maxTasks) {
    warnings.push({
      code: "mem.floor.tasks_truncated",
      message: `memory floor read the first ${maxTasks} tasks; older archives are not indexed`,
    });
  }
  const records: MemRecord[] = [];
  for (const summary of summaries) {
    const record = readTaskRecord(root, summary.ref, io, []);
    if (!record) {
      warnings.push({
        code: "mem.floor.task_unreadable",
        message: `task record is unreadable: ${summary.ref}`,
      });
      continue;
    }
    const taskDir = path.join(root, summary.ref);
    const parts = [record.title, String(record.raw.description ?? "")];
    for (const artifact of ["prd.md", "design.md", "implement.md"]) {
      const file = path.join(taskDir, artifact);
      if (!isFile(io, file)) continue;
      const content = readText(io, file);
      if (content) parts.push(`## ${artifact}\n${content}`);
    }
    records.push({
      id: `task:${record.id}`,
      kind: "task-summary",
      title: `Task — ${record.title}`,
      text: truncate(parts.filter(Boolean).join("\n\n"), MAX_TASK_TEXT),
      ...(typeof record.raw.createdAt === "string"
        ? { createdAt: record.raw.createdAt }
        : {}),
      taskId: record.id,
      ...(record.branch ? { branch: record.branch } : {}),
      source: { kind: "phronia", path: `${summary.ref}/task.json` },
      refs: { taskPath: summary.ref },
      trust: "curated",
    });
  }
  return records;
}

function readSpecRecords(
  root: string,
  io: FsLike,
  warnings: MemWarning[],
): MemRecord[] {
  const specRoot = path.join(root, LAYOUT.paths.spec);
  if (!isDirectory(io, specRoot)) return [];
  const records: MemRecord[] = [];
  for (const file of walkMarkdown(io, specRoot)) {
    const content = readText(io, file);
    if (content === null) {
      warnings.push({
        code: "mem.floor.spec_unreadable",
        message: `spec is unreadable: ${path.relative(root, file)}`,
      });
      continue;
    }
    const relative = path.relative(root, file).split(path.sep).join("/");
    records.push(...splitSpecSections(relative, content));
  }
  return records;
}

function splitSpecSections(relative: string, content: string): MemRecord[] {
  const lines = content.split(/\r?\n/);
  const records: MemRecord[] = [];
  let title = path.basename(relative, ".md");
  let body: string[] = [];
  let start = 1;
  let sawSection = false;

  const flush = (end: number): void => {
    if (body.length === 0) return;
    const text = body.join("\n").trim();
    if (!text) return;
    const slug = slugify(title);
    records.push({
      id: `spec:${relative}#${slug}`,
      kind: "spec",
      title: `Spec — ${title}`,
      text: truncate(text, MAX_SPEC_SECTION),
      source: {
        kind: "phronia",
        path: relative,
        lineStart: start,
        lineEnd: end,
      },
      refs: { specPath: relative },
      trust: "curated",
    });
  };

  lines.forEach((line, index) => {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      if (sawSection) {
        flush(index);
      } else {
        // The preamble usually contains only the H1; treat the first H2 as the
        // start of the document's real content.
        body = [];
        sawSection = true;
      }
      title = heading[1]?.trim() ?? title;
      start = index + 2;
      return;
    }
    if (sawSection) body.push(line);
  });
  if (sawSection) {
    flush(lines.length);
  } else if (lines.some((line) => line.trim() && !line.startsWith("#"))) {
    body = lines;
    flush(lines.length);
  }
  return records;
}

function isFile(io: FsLike, target: string): boolean {
  try {
    return io.statSync(target).isFile();
  } catch {
    return false;
  }
}

function walkMarkdown(io: FsLike, dir: string): string[] {
  const out: string[] = [];
  for (const entry of listDir(io, dir)) {
    const full = path.join(dir, entry);
    try {
      if (io.statSync(full).isDirectory()) {
        out.push(...walkMarkdown(io, full));
      } else if (entry.endsWith(".md")) {
        out.push(full);
      }
    } catch {
      // A file that disappears mid-scan is skipped, not fatal.
    }
  }
  return out.sort();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function snippetFor(text: string, needle: string): string {
  const index = text.toLowerCase().indexOf(needle);
  if (index === -1) return text.slice(0, 200);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + needle.length + 120);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}
