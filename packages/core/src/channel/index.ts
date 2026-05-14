// Public channel API surface.

export type {
  ChannelScope,
  ChannelType,
  ChannelRef,
  ChannelMetadata,
  ContextEntry,
  FileContextEntry,
  RawContextEntry,
  ContextTarget,
  ContextMutationAction,
  EventOrigin,
  ThreadAction,
} from "./internal/store/schema.js";

export {
  GLOBAL_PROJECT_KEY,
  CHANNEL_TYPES,
  THREAD_ACTIONS,
  EVENT_ORIGINS,
  parseChannelScope,
  parseChannelType,
  parseThreadAction,
  parseEventOrigin,
  normalizeThreadKey,
  buildContextEntries,
  contextEntryKey,
  asContextEntries,
  asStringArray,
} from "./internal/store/schema.js";

export type {
  ChannelEvent,
  ChannelEventKind,
  CreateChannelEvent,
  MessageChannelEvent,
  ThreadChannelEvent,
  ContextChannelEvent,
  ChannelMetadataEvent,
  SpawnedChannelEvent,
  KilledChannelEvent,
  DoneChannelEvent,
  ErrorChannelEvent,
  ProgressChannelEvent,
} from "./internal/store/events.js";

export {
  CHANNEL_EVENT_KINDS,
  parseChannelKind,
  isCreateEvent,
  isThreadEvent,
  isContextEvent,
  isChannelMetadataEvent,
} from "./internal/store/events.js";

export type { ChannelEventFilter } from "./internal/store/filter.js";
export type { WatchFilter } from "./internal/store/watch.js";

export {
  MEANINGFUL_EVENT_KINDS,
  matchesEventFilter,
} from "./internal/store/filter.js";

export {
  reduceChannelMetadata,
} from "./internal/store/channel-metadata.js";

export type {
  ThreadState,
  ThreadAliasResolver,
} from "./internal/store/thread-state.js";

export {
  reduceThreads,
  buildThreadAliasResolver,
  collectThreadTimeline,
} from "./internal/store/thread-state.js";

export {
  createChannel,
} from "./api/create.js";

export {
  sendMessage,
} from "./api/send.js";

export {
  postThread,
  renameThread,
} from "./api/post-thread.js";

export {
  addChannelContext,
  deleteChannelContext,
  listChannelContext,
  addThreadContext,
  deleteThreadContext,
  listThreadContext,
} from "./api/context.js";

export {
  setChannelTitle,
  clearChannelTitle,
} from "./api/title.js";

export {
  readChannelEvents,
  readChannelMetadata,
  listThreads,
  showThread,
} from "./api/read.js";

export {
  watchChannelEvents,
} from "./api/watch.js";
export type { WatchChannelOptions } from "./api/watch.js";

export { resolveChannelRef } from "./api/resolve.js";
export type { ResolveChannelRefOptions } from "./api/resolve.js";

export type {
  ChannelAddressOptions,
  MutationCommonOptions,
  CreateChannelOptions,
  SendMessageOptions,
  PostThreadOptions,
  ContextMutationOptions,
  ThreadContextMutationOptions,
  RenameThreadOptions,
  SetChannelTitleOptions,
  ClearChannelTitleOptions,
} from "./api/types.js";
