import fs from "node:fs";
import fsp from "node:fs/promises";

import { withLock } from "./lock.js";
import {
  channelDir,
  eventsPath,
  lockPath,
  seqSidecarPath,
} from "./paths.js";
import { reconcileSeq, writeSidecar } from "./seq.js";
import type {
  ChannelType,
  ContextEntry,
  ContextMutationAction,
  ContextTarget,
  EventOrigin,
  ThreadAction,
} from "./schema.js";
import { parseEventOrigin } from "./schema.js";

export type ChannelEventKind =
  | "create"
  | "join"
  | "leave"
  | "message"
  | "thread"
  | "context"
  | "channel"
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
  "context",
  "channel",
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
  to?: string | string[];
  origin?: EventOrigin;
  meta?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface CreateChannelEvent extends BaseChannelEvent<"create"> {
  cwd?: string;
  task?: string;
  /**
   * Stored channel type. May be the legacy `"thread"` value on old event
   * logs — readers normalize through `reduceChannelMetadata` to
   * `"threads"`.
   */
  type?: ChannelType | "thread";
  description?: string;
  /** Canonical context entries. */
  context?: ContextEntry[];
  /**
   * Legacy alias kept for compatibility with channels created before
   * `context` was the canonical field.
   *
   * @deprecated
   */
  linkedContext?: ContextEntry[];
  labels?: string[];
  ephemeral?: boolean;
}

export interface MessageChannelEvent extends BaseChannelEvent<"message"> {
  text?: string;
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
  context?: ContextEntry[];
  /** Legacy alias on old event logs. */
  linkedContext?: ContextEntry[];
  /** Rename target (action === "rename"). */
  newThread?: string;
}

export interface ContextChannelEvent extends BaseChannelEvent<"context"> {
  target: ContextTarget;
  action: ContextMutationAction;
  context: ContextEntry[];
  thread?: string;
}

export interface ChannelMetadataEvent extends BaseChannelEvent<"channel"> {
  action: "title";
  title?: string | null;
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
    | "context"
    | "channel"
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
  | ContextChannelEvent
  | ChannelMetadataEvent
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

export function isContextEvent(ev: ChannelEvent): ev is ContextChannelEvent {
  return ev.kind === "context";
}

export function isChannelMetadataEvent(
  ev: ChannelEvent,
): ev is ChannelMetadataEvent {
  return ev.kind === "channel";
}

export async function ensureChannelDir(
  name: string,
  project?: string,
): Promise<string> {
  const dir = channelDir(name, project);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Read the last committed seq for a channel. Uses the same reconcile
 * path as `appendEvent` so callers that need a snapshot do not see a
 * stale sidecar.
 */
export async function readLastSeq(
  name: string,
  project?: string,
): Promise<number> {
  const file = eventsPath(name, project);
  if (!fs.existsSync(file)) return 0;
  return reconcileSeq(file, seqSidecarPath(name, project));
}

export interface AppendablePartial {
  kind: ChannelEventKind;
  by: string;
  ts?: string;
  [extra: string]: unknown;
}

/**
 * Append a channel event atomically under the channel lock.
 *
 * Internally reconciles the `.seq` sidecar with the JSONL tail to avoid
 * the legacy full-scan path. Sidecar repair happens automatically on
 * corruption, missing file, or sidecar drift in either direction.
 *
 * @internal Trellis CLI-internal write primitive — downstream consumers
 *   must go through the typed mutation APIs (`createChannel`,
 *   `sendMessage`, etc.).
 */
export async function appendEvent(
  name: string,
  partial: AppendablePartial,
  project?: string,
): Promise<ChannelEvent> {
  validateEventBase(partial);
  await ensureChannelDir(name, project);
  const jsonl = eventsPath(name, project);
  const sidecar = seqSidecarPath(name, project);
  return withLock(lockPath(name, project), async () => {
    const lastSeq = await reconcileSeq(jsonl, sidecar);
    const event = {
      ...partial,
      seq: lastSeq + 1,
      ts: partial.ts ?? new Date().toISOString(),
    } as ChannelEvent;
    await fsp.appendFile(jsonl, JSON.stringify(event) + "\n", "utf-8");
    await writeSidecar(sidecar, event.seq);
    return event;
  });
}

function validateEventBase(partial: AppendablePartial): void {
  const origin = partial.origin;
  if (origin !== undefined) {
    parseEventOrigin(typeof origin === "string" ? origin : String(origin));
  }
  const meta = partial.meta;
  if (
    meta !== undefined &&
    (meta === null || typeof meta !== "object" || Array.isArray(meta))
  ) {
    throw new Error("meta must be a plain JSON object");
  }
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
