/**
 * Inbox watcher: tails events.jsonl for `kind:message` events addressed
 * to this worker and forwards them into the worker's stdin via the
 * adapter's `encodeUserMessage`. A persisted cursor file keeps respawns
 * from replaying messages the previous supervisor already delivered.
 *
 * Step 3 of the supervisor refactor: pulled out of supervisor.ts so the
 * orchestrator only needs to call `runInboxWatcher(...)`. Cursor
 * read/write helpers stay private to this module.
 */

import type { ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";

import type { WorkerAdapter } from "../adapters/index.js";
import { workerFile } from "../store/paths.js";
import { watchEvents } from "../store/watch.js";

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

export interface InboxWatcherArgs {
  channelName: string;
  workerName: string;
  adapter: WorkerAdapter;
  ctx: unknown;
  child: Child;
  signal: AbortSignal;
}

export async function runInboxWatcher(args: InboxWatcherArgs): Promise<void> {
  const { channelName, workerName, adapter, ctx, child, signal } = args;
  // Resume from persisted cursor: first-time spawn → 0 (read full backlog);
  // respawn after kill → last forwarded seq (no replay).
  let cursor = readInboxCursor(channelName, workerName);

  for await (const ev of watchEvents(
    channelName,
    {
      self: workerName, // ignore our own events
      to: workerName, // workers ONLY consume explicit `to`
      kind: "message",
    },
    // First run with cursor=0 reads backlog from start; subsequent runs
    // use sinceSeq to skip already-processed events. Both cases tail
    // future events normally.
    { signal, sinceSeq: cursor, fromStart: cursor === 0 ? true : undefined },
  )) {
    if (signal.aborted) return;
    // Workers must NOT consume each other's broadcast `message` events.
    // Only ingest messages explicitly addressed to this worker via `to`.
    const evTo = (ev as { to?: string | string[] }).to;
    if (!evTo) continue;
    const toList = Array.isArray(evTo) ? evTo : [evTo];
    if (!toList.includes(workerName)) continue;

    const text = ((ev as { text?: string }).text ?? "").trim();
    if (!text) continue;
    const tag = (ev as { tag?: string }).tag;

    // Block until the adapter says it can accept input (e.g. codex
    // thread/start has produced a threadId). Drop the message if we
    // never get ready before being aborted.
    if (!adapter.isReady(ctx)) {
      const deadline = Date.now() + 60_000;
      while (
        !adapter.isReady(ctx) &&
        Date.now() < deadline &&
        !signal.aborted
      ) {
        await sleep(25);
      }
      if (!adapter.isReady(ctx)) {
        // never became ready; advance the cursor anyway so we don't
        // re-attempt this exact event on next start.
        cursor = ev.seq;
        writeInboxCursor(channelName, workerName, cursor);
        continue;
      }
    }

    try {
      child.stdin.write(adapter.encodeUserMessage(text, tag, ctx));
      cursor = ev.seq;
      writeInboxCursor(channelName, workerName, cursor);
    } catch {
      // stdin closed, worker exiting — bail out
      return;
    }
  }
}

/**
 * Per-worker inbox consumption cursor. Persisted to
 * `<worker>.inbox-cursor` so a respawn (same worker name) doesn't replay
 * messages that the previous supervisor already forwarded into the worker
 * process. The cursor is the highest seq we've already turned into a
 * worker stdin write.
 */
function readInboxCursor(channelName: string, workerName: string): number {
  try {
    const raw = fs.readFileSync(
      workerFile(channelName, workerName, "inbox-cursor"),
      "utf-8",
    );
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeInboxCursor(
  channelName: string,
  workerName: string,
  seq: number,
): void {
  try {
    fs.writeFileSync(
      workerFile(channelName, workerName, "inbox-cursor"),
      String(seq),
      "utf-8",
    );
  } catch {
    // ignore — cursor is best-effort; worst case we replay a message
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
