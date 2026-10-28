/**
 * Integration queue policy.
 *
 * The queue only holds waiting entries; the current lander lives in
 * `integration.lock`. Ordering is FIFO by `enqueuedAt` with a deterministic
 * tie-break on `taskRef` (design.md §7.2, §19.5).
 */

import type {
  DequeueResult,
  EnqueueResult,
  QueueEntry,
} from "./types.js";

/** Stable ascending order: oldest first, invalid timestamps last. */
export function compareQueueEntries(left: QueueEntry, right: QueueEntry): number {
  const leftTime = parseTime(left.enqueuedAt);
  const rightTime = parseTime(right.enqueuedAt);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.taskRef.localeCompare(right.taskRef);
}

/** Return a sorted copy; input is never mutated. */
export function sortQueue(
  queue: readonly QueueEntry[],
): readonly QueueEntry[] {
  return [...queue].sort(compareQueueEntries);
}

/**
 * Add an entry unless the task is already waiting. Re-enqueueing keeps the
 * original `enqueuedAt`, so a retry cannot jump the queue.
 */
export function enqueueTask(
  queue: readonly QueueEntry[],
  entry: QueueEntry,
): EnqueueResult {
  const existing = queue.find((item) => item.taskRef === entry.taskRef);
  if (existing) {
    return { entry: existing, queue: sortQueue(queue), added: false };
  }
  const next = sortQueue([...queue, entry]);
  return { entry, queue: next, added: true };
}

/** Remove a task from the queue and report the removed entry, if any. */
export function dequeueTask(
  queue: readonly QueueEntry[],
  taskRef: string,
): DequeueResult {
  const entry = queue.find((item) => item.taskRef === taskRef) ?? null;
  return {
    entry,
    queue:
      entry === null
        ? sortQueue(queue)
        : queue.filter((item) => item.taskRef !== taskRef),
  };
}

/** First waiting entry, or null when the queue is empty. */
export function peekQueue(queue: readonly QueueEntry[]): QueueEntry | null {
  const sorted = sortQueue(queue);
  return sorted[0] ?? null;
}

/** Zero-based queue position, or null when the task is not queued. */
export function queuePosition(
  queue: readonly QueueEntry[],
  taskRef: string,
): number | null {
  const index = sortQueue(queue).findIndex((item) => item.taskRef === taskRef);
  return index === -1 ? null : index;
}

export function isQueued(
  queue: readonly QueueEntry[],
  taskRef: string,
): boolean {
  return queue.some((item) => item.taskRef === taskRef);
}

/**
 * Deduplicate and sort a queue loaded from disk. When duplicates exist the
 * earliest `enqueuedAt` wins.
 */
export function normalizeQueue(
  queue: readonly QueueEntry[],
): readonly QueueEntry[] {
  const byTask = new Map<string, QueueEntry>();
  for (const entry of sortQueue(queue)) {
    if (!byTask.has(entry.taskRef)) byTask.set(entry.taskRef, entry);
  }
  return sortQueue([...byTask.values()]);
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}
