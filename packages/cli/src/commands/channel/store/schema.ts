import path from "node:path";

export const GLOBAL_PROJECT_KEY = "_global";

export type ChannelScope = "project" | "global";
export type ChannelType = "chat" | "thread";

export type ThreadAction =
  | "opened"
  | "comment"
  | "status"
  | "labels"
  | "assignees"
  | "summary"
  | "processed";

export const CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([
  "chat",
  "thread",
]);

export const THREAD_ACTIONS: ReadonlySet<ThreadAction> = new Set([
  "opened",
  "comment",
  "status",
  "labels",
  "assignees",
  "summary",
  "processed",
]);

export interface FileLinkedContext {
  type: "file";
  path: string;
}

export interface RawLinkedContext {
  type: "raw";
  text: string;
}

export type LinkedContextEntry = FileLinkedContext | RawLinkedContext;

export interface ChannelRef {
  name: string;
  scope: ChannelScope;
  project: string;
  dir: string;
}

export interface ChannelMetadata {
  type: ChannelType;
  description?: string;
  linkedContext?: LinkedContextEntry[];
  labels?: string[];
}

export function parseChannelScope(
  v: string | undefined,
): ChannelScope | undefined {
  if (v === undefined) return undefined;
  if (v !== "project" && v !== "global") {
    throw new Error("Invalid --scope. Must be one of: project, global");
  }
  return v;
}

export function parseChannelType(v: string | undefined): ChannelType {
  if (v === undefined) return "chat";
  if (!CHANNEL_TYPES.has(v as ChannelType)) {
    throw new Error("Invalid --type. Must be one of: chat, thread");
  }
  return v as ChannelType;
}

export function parseThreadAction(v: string): ThreadAction {
  if (!THREAD_ACTIONS.has(v as ThreadAction)) {
    throw new Error(
      `Invalid thread action '${v}'. Must be one of: ${[...THREAD_ACTIONS].join(", ")}`,
    );
  }
  return v as ThreadAction;
}

export function normalizeThreadKey(v: string): string {
  const trimmed = v.trim();
  if (!trimmed) throw new Error("Thread key must not be empty");
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      "Thread key may only contain letters, numbers, '.', '_' and '-'",
    );
  }
  return trimmed;
}

export function parseLinkedContext(
  files: string[] | undefined,
  raw: string[] | undefined,
): LinkedContextEntry[] | undefined {
  const entries: LinkedContextEntry[] = [];
  for (const file of files ?? []) {
    const value = file.trim();
    if (!path.isAbsolute(value)) {
      throw new Error(`--linked-context-file must be absolute: ${file}`);
    }
    entries.push({ type: "file", path: value });
  }
  for (const text of raw ?? []) {
    if (!text.trim()) {
      throw new Error("--linked-context-raw must not be empty");
    }
    entries.push({ type: "raw", text });
  }
  return entries.length > 0 ? entries : undefined;
}

export function parseCsv(value: string | undefined): string[] | undefined {
  const out = value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return out && out.length > 0 ? out : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => typeof item === "string") as string[];
}

export function asLinkedContextEntries(
  value: unknown,
): LinkedContextEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is LinkedContextEntry => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    if (candidate.type === "file") return typeof candidate.path === "string";
    if (candidate.type === "raw") return typeof candidate.text === "string";
    return false;
  });
  return entries.length > 0 ? entries : undefined;
}
