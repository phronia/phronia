import {
  isThreadEvent,
  type ChannelEvent,
  type ChannelEventKind,
} from "./events.js";
import type { ThreadAction } from "./schema.js";

export const MEANINGFUL_EVENT_KINDS: ReadonlySet<ChannelEventKind> = new Set([
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
  "done",
  "error",
] as ChannelEventKind[]);

export interface ChannelEventFilter {
  from?: string[];
  kind?: ChannelEventKind;
  tag?: string;
  to?: string;
  self?: string;
  includeProgress?: boolean;
  includeNonMeaningful?: boolean;
  thread?: string;
  action?: ThreadAction;
}

export function matchesEventFilter(
  ev: ChannelEvent,
  filter: ChannelEventFilter,
): boolean {
  if (filter.self && ev.by === filter.self) return false;

  if (!filter.includeNonMeaningful && !MEANINGFUL_EVENT_KINDS.has(ev.kind)) {
    return false;
  }

  if (!filter.includeProgress && ev.kind === "progress") return false;

  if (filter.kind && ev.kind !== filter.kind) return false;

  if (filter.thread !== undefined) {
    if (!isThreadEvent(ev)) return false;
    if (ev.thread !== filter.thread) return false;
  }

  if (filter.action !== undefined) {
    if (!isThreadEvent(ev)) return false;
    if (ev.action !== filter.action) return false;
  }

  if (filter.from && filter.from.length > 0) {
    if (!filter.from.includes(ev.by)) return false;
  }

  if (filter.tag !== undefined && (ev as { tag?: string }).tag !== filter.tag) {
    return false;
  }

  if (filter.to) {
    const evTo = (ev as { to?: string | string[] }).to;
    if (filter.to === "exclusive") {
      if (!evTo) return false;
    } else {
      if (!evTo) return true;
      if (Array.isArray(evTo)) return evTo.includes(filter.to);
      return evTo === filter.to;
    }
  }

  return true;
}
