/**
 * Runtime-state lines for the session and per-turn breadcrumbs.
 *
 * These lines are separate from the workflow breadcrumb body on purpose: the
 * body comes from the user-editable `workflow.md`, while these lines report
 * facts Phronia read from git and the shared runtime. A failed read renders
 * `unknown (read failed)` — the lines are never silently omitted, so "not
 * checked" cannot be mistaken for "nothing to report".
 */

import { diagnostic, type Diagnostic } from "../state/diagnostics.js";
import { nodeFs } from "../state/fs.js";
import {
  readRuntimeFacts,
  type RuntimeClaim,
  type RuntimeFacts,
  type RuntimeLease,
} from "../state/runtime-facts.js";
import type { ActiveTaskState } from "../state/session/active-task.js";
import type { TaskRecordView } from "../state/tasks/record.js";
import { taskRefsMatch } from "../state/tasks/refs.js";
import {
  readSpecSyncState,
  resolveSpecDisplayState,
} from "../task/spec/policy.js";
import type { StateReader } from "../state/index.js";

export interface RuntimeStateOptions {
  readonly state: StateReader;
  /** Null when the session has no pointer; callers decide whether to render. */
  readonly active: ActiveTaskState | null;
  readonly task: TaskRecordView | null;
  /** Include the parent-task "start a child" line (per-turn breadcrumb). */
  readonly includeNext?: boolean;
  /** Epoch seconds override (tests / deterministic ticket reads). */
  readonly now?: number;
}

export interface RuntimeStateView {
  readonly lines: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface RuntimeStateFormatInput {
  readonly facts: RuntimeFacts | null;
  readonly root: string;
  readonly activeTaskRef: string | null;
  readonly task: TaskRecordView | null;
  readonly childStatuses: readonly (string | null)[];
  readonly includeNext: boolean;
  /** `spec-delta.md` exists for the active task. */
  readonly hasSpecDelta?: boolean;
}

export function buildRuntimeStateLines(
  options: RuntimeStateOptions,
): RuntimeStateView {
  const diagnostics: Diagnostic[] = [];
  let facts: RuntimeFacts | null = null;
  try {
    facts = readRuntimeFacts({
      root: options.state.root,
      // The breadcrumb never renders dirtiness; do not pay for a status spawn
      // on every user prompt.
      includeMainDirty: false,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    diagnostics.push(...facts.diagnostics);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "context.runtime_state.read_failed",
        "warn",
        `runtime facts could not be read: ${errorMessage(error)}`,
        {
          path: options.state.root,
          details: { next: "run phronia doctor" },
        },
      ),
    );
  }

  const task = options.task;
  const childStatuses =
    task === null
      ? []
      : task.children.map(
          (childRef) => options.state.tasks.read(childRef)?.status ?? null,
        );
  const hasSpecDelta =
    task === null ? false : options.state.tasks.artifacts(task.ref).specDelta;

  return {
    lines: formatRuntimeStateLines({
      facts,
      root: options.state.root,
      activeTaskRef: options.active?.taskPath ?? null,
      task,
      childStatuses,
      includeNext: options.includeNext === true,
      hasSpecDelta,
    }),
    diagnostics,
  };
}

/** Format the fact lines (plus the parent `next` line) without IO. */
export function formatRuntimeStateLines(
  input: RuntimeStateFormatInput,
): readonly string[] {
  const lines = [
    `workspace: ${describeWorkspace(input.facts, input.root)}`,
    `claim: ${describeClaim(input.facts)}`,
    `lease: ${describeLease(input.facts, input.activeTaskRef, input.root)}`,
    `parallel: ${describeParallel(
      input.activeTaskRef,
      input.task,
      input.childStatuses,
    )}`,
    `spec: ${describeSpec(input.task, input.hasSpecDelta === true)}`,
  ];
  if (
    input.includeNext &&
    input.task !== null &&
    input.task.children.length > 0
  ) {
    lines.push(
      `next: start a child before dispatching implement/check (children: ${input.task.children.length})`,
    );
  }
  return lines;
}

function describeWorkspace(facts: RuntimeFacts | null, root: string): string {
  if (!facts?.factsReliable) {
    return "unknown (read failed)";
  }
  if (facts.isLinkedWorktree) {
    return `worktree ${root}`;
  }
  const claim = facts.claim;
  if (claim === null) {
    return "main (unclaimed)";
  }
  if (claim.stale) {
    return `main (claim stale: ${describeClaimOwner(claim)})`;
  }
  return `main (claimed by ${describeClaimOwner(claim)})`;
}

function describeClaim(facts: RuntimeFacts | null): string {
  if (!facts?.factsReliable) {
    return "unknown (read failed)";
  }
  const claim = facts.claim;
  if (claim === null) {
    return "none";
  }
  const owner = describeClaimOwner(claim);
  return claim.stale ? `stale (${owner})` : owner;
}

function describeClaimOwner(claim: RuntimeClaim): string {
  // ownerRef already carries its type (`session:<key>` / `task:<ref>`).
  return claim.taskRef !== null ? `task ${claim.taskRef}` : claim.ownerRef;
}

function describeLease(
  facts: RuntimeFacts | null,
  activeTaskRef: string | null,
  root: string,
): string {
  if (!facts?.factsReliable) {
    return "unknown (read failed)";
  }
  if (activeTaskRef === null) {
    return "none";
  }
  const lease = facts.leases.find((candidate) =>
    taskRefsMatch(candidate.taskRef, activeTaskRef, root, nodeFs),
  );
  if (lease === undefined) {
    return "none";
  }
  return describeLeaseOwner(lease);
}

function describeLeaseOwner(lease: RuntimeLease): string {
  const owner = `${lease.ownerType} ${lease.ownerId}`;
  return lease.stale ? `stale (${owner})` : owner;
}

function describeParallel(
  activeTaskRef: string | null,
  task: TaskRecordView | null,
  childStatuses: readonly (string | null)[],
): string {
  if (activeTaskRef === null) {
    return "none";
  }
  if (task === null) {
    return "unknown";
  }
  if (task.children.length === 0) {
    return "serial";
  }
  const inProgress = childStatuses.filter(
    (status) => status === "in_progress",
  ).length;
  const planning = childStatuses.filter(
    (status) => status === "planning",
  ).length;
  return `${inProgress} in_progress children (planning ${planning}; total ${task.children.length})`;
}

/**
 * Spec is control-plane state: a task with `spec-delta.md` is pending until
 * `meta.spec_sync.status=synced`. The breadcrumb never reads code or git.
 */
function describeSpec(
  task: TaskRecordView | null,
  hasSpecDelta: boolean,
): "none" | "pending" | "synced" {
  if (task === null) {
    return "none";
  }
  return resolveSpecDisplayState({
    hasDelta: hasSpecDelta,
    syncState: readSpecSyncState(task.meta),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
