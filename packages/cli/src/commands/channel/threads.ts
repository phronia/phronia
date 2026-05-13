import {
  appendEvent,
  isThreadEvent,
  readChannelEvents,
  readChannelMetadata,
  type ThreadChannelEvent,
} from "./store/events.js";
import { resolveExistingChannelRef } from "./store/paths.js";
import {
  normalizeThreadKey,
  parseCsv,
  parseChannelScope,
  parseLinkedContext,
  parseThreadAction,
  type ThreadAction,
} from "./store/schema.js";
import { formatThreadBoard, reduceThreads } from "./store/thread-state.js";

export interface ThreadPostOptions {
  as: string;
  action: string;
  thread?: string;
  title?: string;
  text?: string;
  description?: string;
  status?: string;
  labels?: string;
  assignees?: string;
  summary?: string;
  scope?: string;
  linkedContextFile?: string[];
  linkedContextRaw?: string[];
}

export interface ThreadsOptions {
  scope?: string;
  status?: string;
  raw?: boolean;
}

export interface ThreadShowOptions {
  scope?: string;
  raw?: boolean;
}

export async function channelThreadPost(
  channelName: string,
  opts: ThreadPostOptions,
): Promise<void> {
  const ref = resolveExistingChannelRef(channelName, {
    scope: parseChannelScope(opts.scope),
  });
  const metadata = await readChannelMetadata(channelName, ref.project);
  if (metadata.type !== "thread") {
    throw new Error(
      `Channel '${channelName}' is type '${metadata.type}'. 'post' requires a thread channel.`,
    );
  }

  const action = parseThreadAction(opts.action);
  const thread = resolveThreadKey(action, opts.thread);
  const linkedContext = parseLinkedContext(
    opts.linkedContextFile,
    opts.linkedContextRaw,
  );
  const labels = parseCsv(opts.labels);
  const assignees = parseCsv(opts.assignees);

  const event = await appendEvent(
    channelName,
    {
      kind: "thread",
      by: opts.as,
      action,
      thread,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.text ? { text: opts.text } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(labels ? { labels } : {}),
      ...(assignees ? { assignees } : {}),
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(linkedContext ? { linkedContext } : {}),
    },
    ref.project,
  );
  console.log(JSON.stringify(event));
}

export async function channelThreadsList(
  channelName: string,
  opts: ThreadsOptions,
): Promise<void> {
  const ref = resolveExistingChannelRef(channelName, {
    scope: parseChannelScope(opts.scope),
  });
  const metadata = await readChannelMetadata(channelName, ref.project);
  if (metadata.type !== "thread") {
    throw new Error(
      `Channel '${channelName}' is type '${metadata.type}'. 'threads' requires a thread channel.`,
    );
  }
  const states = reduceThreads(
    await readChannelEvents(channelName, ref.project),
  ).filter((state) => (opts.status ? state.status === opts.status : true));
  if (opts.raw) {
    for (const state of states) console.log(JSON.stringify(state));
    return;
  }
  for (const line of formatThreadBoard(states)) console.log(line);
}

export async function channelThreadShow(
  channelName: string,
  threadKey: string,
  opts: ThreadShowOptions,
): Promise<void> {
  const ref = resolveExistingChannelRef(channelName, {
    scope: parseChannelScope(opts.scope),
  });
  const metadata = await readChannelMetadata(channelName, ref.project);
  if (metadata.type !== "thread") {
    throw new Error(
      `Channel '${channelName}' is type '${metadata.type}'. 'thread' requires a thread channel.`,
    );
  }
  const thread = normalizeThreadKey(threadKey);
  const events = (await readChannelEvents(channelName, ref.project)).filter(
    (ev): ev is ThreadChannelEvent => isThreadEvent(ev) && ev.thread === thread,
  );
  if (opts.raw) {
    for (const ev of events) console.log(JSON.stringify(ev));
    return;
  }
  if (events.length === 0) {
    throw new Error(`Thread '${thread}' not found in channel '${channelName}'`);
  }
  const state = reduceThreads(events)[0];
  console.log(
    `${state.thread} [${state.status}] ${state.title ?? ""}`.trimEnd(),
  );
  if (state.description) console.log(`description: ${state.description}`);
  if (state.labels.length > 0) console.log(`labels: ${state.labels.join(",")}`);
  if (state.assignees.length > 0) {
    console.log(`assignees: ${state.assignees.join(",")}`);
  }
  if (state.summary) console.log(`summary: ${state.summary}`);
  for (const ev of events) printThreadEvent(ev);
}

function resolveThreadKey(
  action: ThreadAction,
  value: string | undefined,
): string {
  if (value) return normalizeThreadKey(value);
  if (action === "opened") return `thread-${Date.now().toString(36)}`;
  throw new Error("--thread is required unless action is 'opened'");
}

function printThreadEvent(ev: ThreadChannelEvent): void {
  const ts = ev.ts.slice(0, 19).replace("T", " ");
  const action = ev.action ?? "?";
  const text = ev.text ? ` ${ev.text}` : "";
  console.log(`  ${ts} ${action} by=${ev.by}${text}`);
}
