import {
  readChannelEvents as readEventsInternal,
  type ChannelEvent,
  type ContextChannelEvent,
  type ThreadChannelEvent,
} from "../internal/store/events.js";
import { reduceChannelMetadata } from "../internal/store/channel-metadata.js";
import {
  collectThreadTimeline,
  reduceThreads,
  type ThreadState,
} from "../internal/store/thread-state.js";
import { normalizeThreadKey } from "../internal/store/schema.js";
import type { ChannelMetadata } from "../internal/store/schema.js";
import { readForumChannelEvents } from "./assert.js";
import { resolveChannelRef } from "./resolve.js";
import type { ChannelAddressOptions } from "./types.js";

export async function readChannelEvents(
  opts: ChannelAddressOptions,
): Promise<ChannelEvent[]> {
  const ref = resolveChannelRef({
    channel: opts.channel,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.projectKey !== undefined ? { projectKey: opts.projectKey } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  return readEventsInternal(opts.channel, ref.project);
}

export async function readChannelMetadata(
  opts: ChannelAddressOptions,
): Promise<ChannelMetadata> {
  const events = await readChannelEvents(opts);
  return reduceChannelMetadata(events);
}

export async function listForumThreads(
  opts: ChannelAddressOptions,
): Promise<ThreadState[]> {
  const ref = resolveChannelRef({
    channel: opts.channel,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.projectKey !== undefined ? { projectKey: opts.projectKey } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  const events = await readForumChannelEvents(
    opts.channel,
    ref.project,
    "forum",
  );
  return reduceThreads(events);
}

export async function showThread(
  opts: ChannelAddressOptions & { thread: string },
): Promise<(ThreadChannelEvent | ContextChannelEvent)[]> {
  const ref = resolveChannelRef({
    channel: opts.channel,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.projectKey !== undefined ? { projectKey: opts.projectKey } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  const events = await readForumChannelEvents(
    opts.channel,
    ref.project,
    "thread",
  );
  return collectThreadTimeline(events, normalizeThreadKey(opts.thread));
}
