import {
  isThreadEvent,
  type ChannelEvent,
  type ThreadChannelEvent,
} from "./events.js";
import {
  asLinkedContextEntries,
  asStringArray,
  type LinkedContextEntry,
} from "./schema.js";

export interface ThreadState {
  thread: string;
  title?: string;
  status: string;
  labels: string[];
  assignees: string[];
  description?: string;
  linkedContext?: LinkedContextEntry[];
  summary?: string;
  openedAt?: string;
  updatedAt?: string;
  lastSeq: number;
  comments: number;
}

export function reduceThreads(events: ChannelEvent[]): ThreadState[] {
  const states = new Map<string, ThreadState>();
  for (const ev of events) {
    if (!isThreadEvent(ev)) continue;
    const key = ev.thread;
    const current =
      states.get(key) ??
      ({
        thread: key,
        status: "open",
        labels: [],
        assignees: [],
        lastSeq: ev.seq,
        comments: 0,
      } satisfies ThreadState);

    if (typeof ev.ts === "string") current.updatedAt = ev.ts;
    if (!current.openedAt && typeof ev.ts === "string") {
      current.openedAt = ev.ts;
    }
    current.lastSeq = ev.seq;

    applyThreadAction(current, ev);
    states.set(key, current);
  }
  return [...states.values()].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
}

export function formatThreadBoard(states: ThreadState[]): string[] {
  if (states.length === 0) return ["(no threads)"];
  return [
    "THREAD  STATUS  TITLE",
    ...states.map((state) => {
      const labels =
        state.labels.length > 0 ? ` labels=${state.labels.join(",")}` : "";
      const assignees =
        state.assignees.length > 0
          ? ` assignees=${state.assignees.join(",")}`
          : "";
      return `${state.thread} [${state.status}] ${state.title ?? ""}${labels}${assignees}`;
    }),
  ];
}

function applyThreadAction(current: ThreadState, ev: ThreadChannelEvent): void {
  switch (ev.action) {
    case "opened":
      current.status = typeof ev.status === "string" ? ev.status : "open";
      if (typeof ev.title === "string") current.title = ev.title;
      if (typeof ev.description === "string") {
        current.description = ev.description;
      }
      current.linkedContext =
        asLinkedContextEntries(ev.linkedContext) ?? current.linkedContext;
      current.labels = asStringArray(ev.labels) ?? current.labels;
      current.assignees = asStringArray(ev.assignees) ?? current.assignees;
      return;
    case "comment":
      current.comments += 1;
      return;
    case "status":
      if (typeof ev.status === "string") current.status = ev.status;
      return;
    case "labels":
      current.labels = asStringArray(ev.labels) ?? current.labels;
      return;
    case "assignees":
      current.assignees = asStringArray(ev.assignees) ?? current.assignees;
      return;
    case "summary":
      if (typeof ev.summary === "string") current.summary = ev.summary;
      return;
    case "processed":
      current.status = typeof ev.status === "string" ? ev.status : "processed";
      return;
    default:
      return;
  }
}
