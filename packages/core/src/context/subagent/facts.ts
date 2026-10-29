/**
 * Map read-only state into `DispatchFacts` (design.md §4.2).
 *
 * This is the only place that knows how Phronia stores tasks, sessions,
 * worktrees, claims, and leases. The policy stays pure; this module only
 * reads through the existing state readers and the runtime-facts adapter.
 * There are no platform branches here: capabilities are resolved from the
 * capability matrix and passed through.
 */

import path from "node:path";
import { capabilitiesFor } from "../../platform/capabilities.js";
import type { PlatformId } from "../../platform/ids.js";
import type { FsLike } from "../../state/fs.js";
import { nodeFs, realPath } from "../../state/fs.js";
import type { RuntimeFacts, RuntimeWorktree } from "../../state/runtime-facts.js";
import type { StateReader } from "../../state/index.js";
import type { ActiveTaskState } from "../../state/session/active-task.js";
import type { TaskRecordView } from "../../state/tasks/record.js";
import { taskRefsMatch } from "../../state/tasks/refs.js";
import { readParallelMeta } from "../../task/parallel/footprint.js";
import type {
  AgentMutation,
  ClaimFacts,
  DispatchEnforce,
  DispatchFacts,
  LeaseFacts,
  TaskFacts,
} from "../../task/dispatch/types.js";

export interface BuildDispatchFactsInput {
  readonly state: StateReader;
  /** Project root the harness named; never `process.cwd()`. */
  readonly root: string;
  readonly runtime: RuntimeFacts;
  /** Session pointer (`active(input, {platform})`). */
  readonly sessionActive: ActiveTaskState;
  /** Decision target (`active(input, {platform, taskRef})`). */
  readonly effectiveActive: ActiveTaskState;
  /** Explicit `Active task:` / task_ref from the payload. */
  readonly requestedRef: string | null;
  readonly agent: AgentMutation;
  readonly platform: { readonly id: PlatformId; readonly adapterId?: string | null };
  readonly enforce: DispatchEnforce;
  /** Current session identity, used to recognize our own claim/lease. */
  readonly sessionKey: string | null;
  readonly io?: FsLike;
}

/** implement/check mutate files; research/session only materialize context. */
export function agentMutationFor(agentType: string | null): AgentMutation {
  switch (agentType) {
    case "implement":
    case "check":
      return "mutating";
    case "research":
    case "session":
      return "read-only";
    default:
      return "unknown";
  }
}

export function buildDispatchFacts(input: BuildDispatchFactsInput): DispatchFacts {
  const io = input.io ?? nodeFs;
  const root = input.root;
  const capabilities = capabilitiesFor(input.platform.id, input.platform.adapterId);

  const taskCache = new Map<string, TaskRecordView | null>();
  const readTask = (ref: string): TaskRecordView | null => {
    const cached = taskCache.get(ref);
    if (cached !== undefined) {
      return cached;
    }
    const record = input.state.tasks.read(ref);
    taskCache.set(ref, record);
    return record;
  };

  const effectiveRef = input.effectiveActive.taskPath;
  const record = effectiveRef === null ? null : readTask(effectiveRef);
  const effectiveTask = record === null ? null : toTaskFacts(record, readTask);

  // The session pointer is the task this session is bound to. It differs from
  // the effective task when the payload names a child/sibling, which is exactly
  // the situation `DISPATCH_TASK_NOT_CHILD` has to explain.
  const sessionRef = input.sessionActive.taskPath;
  const sessionRecord = sessionRef === null ? null : readTask(sessionRef);
  const activeTask =
    sessionRecord === null ? null : toTaskFacts(sessionRecord, readTask);

  const checkoutRoot = input.runtime.toplevel ?? root;
  const checkoutReal = resolveReal(io, checkoutRoot);
  const registeredTaskRef =
    input.runtime.worktrees.find(
      (entry) =>
        entry.taskRef !== null &&
        samePath(resolveReal(io, entry.path), checkoutReal),
    )?.taskRef ?? null;

  const taskWorktree =
    record === null ? null : worktreeFor(input.runtime, record.ref, root, io);

  return {
    platform: {
      id: input.platform.id,
      hookPolicy: capabilities.hookPolicy,
      subagentWorkspace: capabilities.subagentWorkspace,
    },
    agent: input.agent,
    enforce: input.enforce,
    activeTaskRef: input.sessionActive.taskPath,
    activeTask,
    requestedTaskRef: input.requestedRef,
    effectiveTask,
    checkout: {
      root: checkoutRoot,
      mainRoot: input.runtime.mainRoot,
      isLinkedWorktree: input.runtime.isLinkedWorktree,
      branch: input.runtime.branch,
      registeredTaskRef,
      mainDirty: input.runtime.mainDirty,
    },
    workspace:
      effectiveTask === null
        ? null
        : {
            taskWorktree:
              taskWorktree === null
                ? null
                : resolveReal(io, taskWorktree.path),
            taskBranch:
              taskWorktree === null || taskWorktree.branch === ""
                ? effectiveTask.branch
                : taskWorktree.branch,
          },
    claim: toClaimFacts(input.runtime),
    lease: toLeaseFacts(input.runtime, record?.ref ?? effectiveRef, root, io),
    siblings: record === null ? null : siblingCounts(record, readTask),
    factsReliable: input.runtime.factsReliable,
    sessionKey: input.sessionKey,
  };
}

function toTaskFacts(
  record: TaskRecordView,
  readTask: (ref: string) => TaskRecordView | null,
): TaskFacts {
  const parallel = readParallelMeta(record.meta);
  let worktree = parallel.worktree;
  // A parent's `worktree: always` is an isolation policy for the whole
  // subtree, not just the container. Children inherit it unless they are
  // themselves explicit about isolation.
  if (record.parent !== null) {
    const parent = readTask(record.parent);
    if (parent !== null && readParallelMeta(parent.meta).worktree === "always") {
      worktree = "always";
    }
  }
  return {
    ref: record.ref,
    id: record.id,
    status: record.status,
    parent: record.parent,
    children: record.children,
    branch: record.branch,
    parallel: {
      worktree,
      exclusive: parallel.exclusive,
      dependsOn: parallel.dependsOn,
    },
  };
}

/**
 * Children drive isolation: a container reports its own children; a leaf
 * reports its parent's direct children (which includes itself). This is what
 * makes "two in-progress siblings" fire for leaves rather than only for the
 * parent.
 */
function siblingCounts(
  record: TaskRecordView,
  readTask: (ref: string) => TaskRecordView | null,
): DispatchFacts["siblings"] {
  const refs = siblingRefs(record, readTask);
  if (refs === null) {
    return null;
  }
  const statuses = refs.map((ref) => readTask(ref)?.status ?? null);
  return {
    total: statuses.length,
    inProgress: statuses.filter((status) => status === "in_progress").length,
    planning: statuses.filter((status) => status === "planning").length,
  };
}

function siblingRefs(
  record: TaskRecordView,
  readTask: (ref: string) => TaskRecordView | null,
): readonly string[] | null {
  if (record.children.length > 0) {
    return record.children;
  }
  if (record.parent === null) {
    return null;
  }
  const parent = readTask(record.parent);
  return parent === null ? null : parent.children;
}

function worktreeFor(
  runtime: RuntimeFacts,
  taskRef: string,
  root: string,
  io: FsLike,
): RuntimeWorktree | null {
  return (
    runtime.worktrees.find(
      (entry) =>
        entry.taskRef !== null &&
        taskRefsMatch(entry.taskRef, taskRef, root, io),
    ) ?? null
  );
}

function toClaimFacts(runtime: RuntimeFacts): ClaimFacts | null {
  const claim = runtime.claim;
  if (claim === null) {
    return null;
  }
  return {
    taskRef: claim.taskRef,
    ownerRef: claim.ownerRef,
    sessionKey: claim.sessionKey,
    stale: claim.stale,
    heartbeatAt: claim.heartbeatAt,
  };
}

function toLeaseFacts(
  runtime: RuntimeFacts,
  effectiveRef: string | null,
  root: string,
  io: FsLike,
): LeaseFacts | null {
  if (effectiveRef === null) {
    return null;
  }
  const matches = runtime.leases.filter((lease) =>
    taskRefsMatch(lease.taskRef, effectiveRef, root, io),
  );
  // Prefer a live lease; a stale one is still reported so the guard can say
  // the task had an owner rather than "none".
  const lease = matches.find((candidate) => !candidate.stale) ?? matches[0];
  if (lease === undefined) {
    return null;
  }
  return {
    ownerType: lease.ownerType,
    ownerId: lease.ownerId,
    sessionKey: lease.sessionKey,
    stale: lease.stale,
  };
}

function resolveReal(io: FsLike, target: string): string {
  return realPath(io, target) ?? path.resolve(target);
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}
