import {
  appendEvent,
  type MessageChannelEvent,
} from "../internal/store/events.js";
import { resolveChannelRef } from "./resolve.js";
import type { SendMessageOptions } from "./types.js";

export async function sendMessage(
  opts: SendMessageOptions,
): Promise<MessageChannelEvent> {
  const ref = resolveChannelRef({
    channel: opts.channel,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.projectKey !== undefined ? { projectKey: opts.projectKey } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  const event = await appendEvent(
    opts.channel,
    {
      kind: "message",
      by: opts.by,
      text: opts.text,
      ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    },
    ref.project,
  );
  return event as MessageChannelEvent;
}
