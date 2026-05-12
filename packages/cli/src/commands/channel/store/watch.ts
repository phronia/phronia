import fs from "node:fs";

import { eventsPath, channelDir } from "./paths.js";
import type { ChannelEvent, ChannelEventKind } from "./events.js";

/**
 * meaningful kinds — these wake a wait() call.
 * progress / waiting / awake are status pings and never wake.
 */
const MEANINGFUL_KINDS: ReadonlySet<ChannelEventKind> = new Set([
  "create",
  "join",
  "leave",
  "message",
  "spawned",
  "killed",
  "respawned",
  "done",
  "error",
] as ChannelEventKind[]);

export interface WatchFilter {
  /** Only events from one of these agents wake us. */
  from?: string[];
  /** Only events with this kind wake us. */
  kind?: ChannelEventKind;
  /** Only events with this tag wake us (most useful with kind=say). */
  tag?: string;
  /**
   * `to` filter:
   *  - "any"        — events with no `to` (broadcast) OR explicitly to us; default
   *  - "<agent>"    — explicitly targeted at <agent>; broadcasts also pass
   *  - "exclusive"  — only events explicitly targeted (no broadcasts)
   */
  to?: string;
  /** The agent name watching; used to filter out events the agent itself produced. */
  self?: string;
  /** Include progress events too (defaults to false). */
  includeProgress?: boolean;
}

export function matchesFilter(ev: ChannelEvent, filter: WatchFilter): boolean {
  // Don't wake on our own events (avoid self-loop)
  if (filter.self && ev.by === filter.self) return false;

  if (!filter.includeProgress && !MEANINGFUL_KINDS.has(ev.kind)) return false;

  if (filter.kind && ev.kind !== filter.kind) return false;

  if (filter.from && filter.from.length > 0) {
    if (!filter.from.includes(ev.by)) return false;
  }

  if (filter.tag !== undefined && (ev as ChannelEvent).tag !== filter.tag) {
    return false;
  }

  // `to` routing: events with `to` set are targeted; broadcasts (no `to`)
  // generally pass through.
  if (filter.to) {
    const evTo = (ev as ChannelEvent).to as string | string[] | undefined;
    if (filter.to === "exclusive") {
      if (!evTo) return false;
    } else {
      if (!evTo) return true; // broadcast — pass
      if (Array.isArray(evTo)) {
        return evTo.includes(filter.to);
      }
      return evTo === filter.to;
    }
  }

  return true;
}

interface ReadProgress {
  byteOffset: number;
  carry: string;
}

async function readNewEvents(
  filePath: string,
  state: ReadProgress,
): Promise<ChannelEvent[]> {
  if (!fs.existsSync(filePath)) {
    // File was deleted (e.g. `--force` recreate) — reset offset so when
    // the file reappears we'll re-scan it from byte 0.
    state.byteOffset = 0;
    state.carry = "";
    return [];
  }
  const stat = await fs.promises.stat(filePath);
  if (stat.size < state.byteOffset) {
    // File was truncated / rotated / replaced — re-scan from start so
    // post-truncate events aren't lost forever.
    state.byteOffset = 0;
    state.carry = "";
  }
  if (stat.size <= state.byteOffset) return [];

  const fh = await fs.promises.open(filePath, "r");
  try {
    const length = stat.size - state.byteOffset;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, state.byteOffset);
    state.byteOffset = stat.size;
    const text = state.carry + buf.toString("utf-8");
    const lines = text.split("\n");
    state.carry = lines.pop() ?? "";
    const events: ChannelEvent[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t) as ChannelEvent);
      } catch {
        // corrupted line — skip
        continue;
      }
    }
    return events;
  } finally {
    await fh.close();
  }
}

/**
 * Watch the channel events.jsonl for events matching the filter.
 *
 * Yields each matching event as it arrives. Caller may break to stop;
 * the function cleans up on iterator return.
 *
 * Implementation: fs.watch with a 200ms safety poll for platforms where
 * fs.watch is lossy (Windows, NFS, etc.).
 */
export async function* watchEvents(
  channelName: string,
  filter: WatchFilter,
  opts: { signal?: AbortSignal; fromStart?: boolean; sinceSeq?: number } = {},
): AsyncGenerator<ChannelEvent, void, unknown> {
  const file = eventsPath(channelName);
  // Ensure channel dir exists so fs.watch on its parent works
  if (!fs.existsSync(channelDir(channelName))) {
    await fs.promises.mkdir(channelDir(channelName), { recursive: true });
  }

  // Three modes:
  //   default (from-now): start at EOF. Used by `wait` so a previous
  //     turn's `done` doesn't unblock a fresh wait immediately.
  //   fromStart=true: start at offset 0 and yield existing events
  //     before tailing. Used by first-time supervisor inbox catch-up.
  //   sinceSeq=N: like fromStart=true but skip events with seq <= N.
  //     Used by supervisor inbox watcher after the first run so a
  //     respawn doesn't replay already-processed messages.
  let initialOffset = 0;
  if (!opts.fromStart && opts.sinceSeq === undefined) {
    try {
      if (fs.existsSync(file)) {
        initialOffset = (await fs.promises.stat(file)).size;
      }
    } catch {
      initialOffset = 0;
    }
  }
  const state: ReadProgress = { byteOffset: initialOffset, carry: "" };
  const sinceSeq = opts.sinceSeq;

  let resolveNext: (() => void) | null = null;

  const wake = (): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(channelDir(channelName), () => wake());
  } catch {
    // ignore — fall back to polling
  }

  // 200ms safety polling (Windows / NFS / macOS fs.watch quirks)
  const poll = setInterval(wake, 200);

  const abortHandler = (): void => wake();
  opts.signal?.addEventListener("abort", abortHandler);

  try {
    while (true) {
      if (opts.signal?.aborted) return;

      const fresh = await readNewEvents(file, state);
      for (const ev of fresh) {
        if (sinceSeq !== undefined && ev.seq <= sinceSeq) continue;
        if (matchesFilter(ev, filter)) yield ev;
        if (opts.signal?.aborted) return;
      }

      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  } finally {
    clearInterval(poll);
    watcher?.close();
    opts.signal?.removeEventListener("abort", abortHandler);
  }
}
