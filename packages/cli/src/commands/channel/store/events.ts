import fs from "node:fs";
import fsp from "node:fs/promises";

import { withLock } from "./lock.js";
import { eventsPath, channelDir, lockPath } from "./paths.js";
import {
  asLinkedContextEntries,
  asStringArray,
  type ChannelMetadata,
  type ChannelType,
  type LinkedContextEntry,
  type ThreadAction,
} from "./schema.js";

export type ChannelEventKind =
  | "create"
  | "join"
  | "leave"
  | "message"
  | "thread"
  | "spawned"
  | "killed"
  | "respawned"
  | "progress"
  | "done"
  | "error"
  | "waiting"
  | "awake";

export const CHANNEL_EVENT_KINDS: ReadonlySet<ChannelEventKind> = new Set([
  "create",
  "join",
  "leave",
  "message",
  "thread",
  "spawned",
  "killed",
  "respawned",
  "progress",
  "done",
  "error",
  "waiting",
  "awake",
]);

export function parseChannelKind(
  v: string | undefined,
): ChannelEventKind | undefined {
  if (v === undefined) return undefined;
  if (!CHANNEL_EVENT_KINDS.has(v as ChannelEventKind)) {
    throw new Error(
      `Invalid --kind '${v}'. Must be one of: ${[...CHANNEL_EVENT_KINDS].join(", ")}`,
    );
  }
  return v as ChannelEventKind;
}

export interface BaseChannelEvent<
  K extends ChannelEventKind = ChannelEventKind,
> {
  seq: number;
  ts: string;
  kind: K;
  by: string;
  [extra: string]: unknown;
}

export interface CreateChannelEvent extends BaseChannelEvent<"create"> {
  cwd?: string;
  task?: string;
  type?: ChannelType;
  description?: string;
  linkedContext?: LinkedContextEntry[];
  labels?: string[];
  ephemeral?: boolean;
}

export interface MessageChannelEvent extends BaseChannelEvent<"message"> {
  text?: string;
  to?: string | string[];
  tag?: string;
}

export interface ThreadChannelEvent extends BaseChannelEvent<"thread"> {
  action?: ThreadAction;
  thread: string;
  title?: string;
  text?: string;
  description?: string;
  status?: string;
  labels?: string[];
  assignees?: string[];
  summary?: string;
  linkedContext?: LinkedContextEntry[];
}

export interface SpawnedChannelEvent extends BaseChannelEvent<"spawned"> {
  as?: string;
  provider?: string;
  pid?: number;
  agent?: string;
  files?: string[];
  manifests?: string[];
}

export interface KilledChannelEvent extends BaseChannelEvent<"killed"> {
  reason?: string;
  signal?: string;
}

export interface DoneChannelEvent extends BaseChannelEvent<"done"> {
  duration_ms?: number;
}

export interface ErrorChannelEvent extends BaseChannelEvent<"error"> {
  message?: string;
}

export interface ProgressChannelEvent extends BaseChannelEvent<"progress"> {
  detail?: Record<string, unknown>;
}

export type GenericChannelEvent = BaseChannelEvent<
  Exclude<
    ChannelEventKind,
    | "create"
    | "message"
    | "thread"
    | "spawned"
    | "killed"
    | "done"
    | "error"
    | "progress"
  >
>;

export type ChannelEvent =
  | CreateChannelEvent
  | MessageChannelEvent
  | ThreadChannelEvent
  | SpawnedChannelEvent
  | KilledChannelEvent
  | DoneChannelEvent
  | ErrorChannelEvent
  | ProgressChannelEvent
  | GenericChannelEvent;

export function isCreateEvent(ev: ChannelEvent): ev is CreateChannelEvent {
  return ev.kind === "create";
}

export function isThreadEvent(ev: ChannelEvent): ev is ThreadChannelEvent {
  return ev.kind === "thread" && typeof ev.thread === "string";
}

export function metadataFromCreateEvent(
  create: ChannelEvent | undefined,
): ChannelMetadata {
  if (!create || !isCreateEvent(create)) return { type: "chat" };
  const linkedContext = asLinkedContextEntries(create.linkedContext);
  const labels = asStringArray(create.labels);
  return {
    type: create.type === "thread" ? "thread" : "chat",
    ...(typeof create.description === "string"
      ? { description: create.description }
      : {}),
    ...(linkedContext ? { linkedContext } : {}),
    ...(labels ? { labels } : {}),
  };
}

export async function ensureChannelDir(
  name: string,
  project?: string,
): Promise<string> {
  const dir = channelDir(name, project);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function readLastSeq(
  name: string,
  project?: string,
): Promise<number> {
  const file = eventsPath(name, project);
  if (!fs.existsSync(file)) return 0;
  const content = await fsp.readFile(file, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return 0;
  const last = lines[lines.length - 1];
  try {
    const obj = JSON.parse(last) as { seq?: number };
    return typeof obj.seq === "number" ? obj.seq : 0;
  } catch {
    return 0;
  }
}

export interface AppendablePartial {
  kind: ChannelEventKind;
  by: string;
  ts?: string;
  [extra: string]: unknown;
}

export async function appendEvent(
  name: string,
  partial: AppendablePartial,
  project?: string,
): Promise<ChannelEvent> {
  await ensureChannelDir(name, project);
  // Hold the channel-level lock so concurrent supervisors / CLIs can't
  // race seq assignment. The read-then-append window is the hot spot.
  return withLock(lockPath(name, project), async () => {
    const lastSeq = await readLastSeq(name, project);
    const event = {
      ...partial,
      seq: lastSeq + 1,
      ts: partial.ts ?? new Date().toISOString(),
    } as ChannelEvent;
    await fsp.appendFile(
      eventsPath(name, project),
      JSON.stringify(event) + "\n",
      "utf-8",
    );
    return event;
  });
}

export async function readChannelEvents(
  name: string,
  project?: string,
): Promise<ChannelEvent[]> {
  const file = eventsPath(name, project);
  if (!fs.existsSync(file)) return [];
  const text = await fsp.readFile(file, "utf-8");
  const events: ChannelEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ChannelEvent);
    } catch {
      continue;
    }
  }
  return events;
}

export async function readChannelMetadata(
  name: string,
  project?: string,
): Promise<ChannelMetadata> {
  const events = await readChannelEvents(name, project);
  return metadataFromCreateEvent(events.find(isCreateEvent));
}
