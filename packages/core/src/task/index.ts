// Public task API surface — canonical task record shape, factory,
// schema, I/O helpers, directory validation, and phase inference.
//
// Task API is intentionally independent from the channel API.

export type {
  TrellisTaskRecord,
  TaskRecordField,
} from "./schema.js";

export {
  TASK_RECORD_FIELD_ORDER,
  emptyTaskRecord,
  taskRecordSchema,
} from "./schema.js";

export type {
  LoadTaskRecordOptions,
  WriteTaskRecordOptions,
} from "./records.js";

export {
  loadTaskRecord,
  writeTaskRecord,
} from "./records.js";

export type { TaskDirParts } from "./paths.js";
export { validateTaskDirName, isValidTaskDirName } from "./paths.js";

export type { TrellisTaskPhase } from "./phase.js";
export { inferTaskPhase } from "./phase.js";
export * from "./cross-repo.js";

// Parallel planning, integration policy, workspace policy, and shared task
// index/lease policies (W1). Cross-flow barrel: the integration session owns
// this file; W3 only needs these re-exports to consume the pure policies.
export * from "./parallel/types.js";
export * from "./parallel/footprint.js";
export * from "./parallel/graph.js";
export * from "./parallel/planner.js";
export * from "./integration/types.js";
export * from "./integration/policy.js";
export * from "./integration/queue.js";
export * from "./workspace/types.js";
export * from "./workspace/policy.js";
export * from "./index-types.js";
export * from "./index-policy.js";

// Coordinator policy (W5). `classifyBatchState` is exported under a distinct
// name because `index-policy.ts` already exports the single-task classifier.
export * from "./coordinator/types.js";
export {
  buildDispatchManifest,
  buildPromptPrefix,
  canRunCoordinator,
  classifyBatchState as classifyCoordinatorBatch,
  coordinatorState,
  nextWave,
} from "./coordinator/policy.js";
