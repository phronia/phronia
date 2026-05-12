import fs from "node:fs";
import fsp from "node:fs/promises";

import { withLock } from "./lock.js";
import { eventsPath, channelDir, lockPath } from "./paths.js";

export type ChannelEventKind =
  | "create"
  | "join"
  | "leave"
  | "message"
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

export interface ChannelEvent {
  seq: number;
  ts: string;
  kind: ChannelEventKind;
  by: string;
  [extra: string]: unknown;
}

export async function ensureChannelDir(name: string): Promise<string> {
  const dir = channelDir(name);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function readLastSeq(name: string): Promise<number> {
  const file = eventsPath(name);
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
): Promise<ChannelEvent> {
  await ensureChannelDir(name);
  // Hold the channel-level lock so concurrent supervisors / CLIs can't
  // race seq assignment. The read-then-append window is the hot spot.
  return withLock(lockPath(name), async () => {
    const lastSeq = await readLastSeq(name);
    const event: ChannelEvent = {
      ...partial,
      seq: lastSeq + 1,
      ts: partial.ts ?? new Date().toISOString(),
    };
    await fsp.appendFile(
      eventsPath(name),
      JSON.stringify(event) + "\n",
      "utf-8",
    );
    return event;
  });
}
