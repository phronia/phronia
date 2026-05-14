import {
  readChannelEvents,
  type ChannelEvent,
} from "../internal/store/events.js";
import { reduceChannelMetadata } from "../internal/store/channel-metadata.js";

export async function readThreadsChannelEvents(
  channel: string,
  project: string,
  operation: string,
): Promise<ChannelEvent[]> {
  const events = await readChannelEvents(channel, project);
  const metadata = reduceChannelMetadata(events);
  if (metadata.type !== "threads") {
    throw new Error(
      `Channel '${channel}' is type '${metadata.type}'. '${operation}' requires a threads channel.`,
    );
  }
  return events;
}
