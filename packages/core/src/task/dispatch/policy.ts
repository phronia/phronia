/**
 * Dispatch admission policy (design.md §4.5).
 *
 * Invariant: this function is a pure decision. It reads no files, runs no
 * processes, and never consults `process.cwd()` or a platform enum. The rule
 * order below is the public contract — first match wins — because reordering
 * changes which stable `DISPATCH_*` code callers observe.
 *
 * `enforce` is intentionally not applied here. The policy always reports the
 * factual verdict (`block` or `allow`); S2 downgrades a block to an advisory
 * guard for `enforce: warn|off` and for platforms whose `hookPolicy` cannot
 * block. That split keeps the decision testable and the degradation visible.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import type {
  ClaimFacts,
  DispatchCode,
  DispatchFacts,
  DispatchVerdict,
  GuardBlock,
  LeaseFacts,
  TaskFacts,
} from "./types.js";

/** Built from the layout so a path change cannot leave stale instructions. */
const TASK_SCRIPT = `python3 ./${LAYOUT.paths.scripts}/task.py`;

/** Repo-relative task-ref prefixes accepted by the workspace layout. */
const TASK_REF_MARKERS = [
  `${LAYOUT.rootDirName}/tasks/`,
  `${LAYOUT.legacyRootDirName}/tasks/`,
] as const;

/** True when the task is a coordination container, never an execution unit. */
export function isParentTask(task: TaskFacts | null): boolean {
  return task !== null && task.children.length > 0;
}

/**
 * Isolation intent, in two independent signals:
 * an explicit task policy (`always`/`exclusive`) or a parent with at least two
 * in-progress children. Footprints are not consulted: a declared footprint
 * says "may run in parallel", not "is running in parallel".
 *
 * Fact mapping (S2) inherits a parent's `meta.parallel.worktree=always` into
 * the child's `TaskFacts.parallel.worktree`, so this function only reads the
 * effective task.
 */
export function requiresIsolation(
  task: TaskFacts | null,
  siblings: DispatchFacts["siblings"],
): boolean {
  if (task === null) {
    return false;
  }
  if (task.parallel.worktree === "always" || task.parallel.exclusive) {
    return true;
  }
  return siblings !== null && siblings.inProgress >= 2;
}

export function evaluateDispatch(facts: DispatchFacts): DispatchVerdict {
  // 1. Only mutating Phronia agents are in the contract. read-only/unknown
  // agents keep their existing path (research must never be blocked).
  if (facts.agent !== "mutating") {
    return allow(
      "DISPATCH_OUTSIDE_CONTRACT",
      "info",
      `agent is ${facts.agent}; dispatch admission only applies to mutating agents`,
      [],
      facts,
    );
  }

  // 2. No effective task: preserve the pull-based degradation. There is no
  // workspace contract to violate without a task. (`enforce: off` is applied
  // by S2 after this function, so it cannot short-circuit the factual verdict.)
  const task = facts.effectiveTask;
  if (task === null) {
    return allow(
      "DISPATCH_NO_ACTIVE_TASK",
      "info",
      "no active task could be resolved; dispatch admission is skipped",
      [],
      facts,
    );
  }

  // 3 (design rule 4). Cross-task access: an explicit task must be the active task or its
  // direct child. With no active pointer there is nothing to violate, so the
  // explicit task proceeds to the structural checks below.
  const wrongTask = checkTaskLineage(facts, task);
  if (wrongTask !== null) {
    return wrongTask;
  }

  // 4 (design rule 5). Parent/container tasks are never implementation targets.
  if (isParentTask(task)) {
    return block(
      "DISPATCH_PARENT_TASK",
      `parent task ${task.ref} has ${task.children.length} children; a parent is a coordination container, not an implementation target`,
      task.children.map((child) => `${TASK_SCRIPT} start ${child}`).concat(
        "re-dispatch implement with Active task: <child>",
      ),
      facts,
    );
  }

  // 5 (design rule 6). Status gate: planning/blocked/completed tasks cannot be implemented.
  if (task.status !== "in_progress") {
    return block(
      "DISPATCH_TASK_NOT_IN_PROGRESS",
      `task ${task.ref} is ${task.status ?? "unknown"}; implement/check dispatch requires status in_progress`,
      [
        `${TASK_SCRIPT} start ${task.ref}`,
        `re-dispatch implement with Active task: ${task.ref}`,
      ],
      facts,
    );
  }

  // 6 (design rules 7–8). Checkout ownership, then claim.
  const checkout = checkCheckout(facts, task);
  if (checkout !== null) {
    return checkout;
  }

  // 7 (design rule 9). Advisory lease conflict (same task in two sessions is allowed).
  const lease = checkLease(facts, task);
  if (lease !== null) {
    return lease;
  }

  // 8 (design rule 10). Partial read failure is visible but never a reason to block.
  if (!facts.factsReliable) {
    return allowWithGuard(
      "DISPATCH_FACTS_UNRELIABLE",
      "warn",
      `runtime facts for ${task.ref} could not be read reliably; workspace ownership cannot be verified`,
      "runtime facts are partial; the workspace contract cannot be verified",
      [
        "git rev-parse --git-common-dir",
        "phronia doctor",
        ensureCommand(task.ref),
      ],
      facts,
    );
  }

  return allow(
    "DISPATCH_OK",
    "info",
    `task ${task.ref} satisfies workspace, status, and ownership preconditions`,
    [],
    facts,
  );
}

/**
 * Rule 3: an explicit `Active task:` may only select the active task itself or
 * one of its direct children. Comparing raw strings is wrong: task.json may
 * store directory names, repo-relative refs, or absolute paths.
 */
function checkTaskLineage(
  facts: DispatchFacts,
  task: TaskFacts,
): DispatchVerdict | null {
  const requested = facts.requestedTaskRef;
  const active = facts.activeTaskRef;
  if (requested === null || active === null) {
    return null;
  }
  if (refsEqual(requested, active)) {
    return null;
  }
  if (task.parent !== null && refsEqual(task.parent, active)) {
    return null;
  }
  return block(
    "DISPATCH_TASK_NOT_CHILD",
    `requested task ${requested} is neither the active task ${active} nor one of its children`,
    [
      `${TASK_SCRIPT} start ${requested}`,
      `re-dispatch implement with Active task: ${requested}`,
    ],
    facts,
  );
}

/** Rules 6–7: current checkout must be the task's registered workspace. */
function checkCheckout(
  facts: DispatchFacts,
  task: TaskFacts,
): DispatchVerdict | null {
  const checkout = facts.checkout;
  const taskWorktree = facts.workspace?.taskWorktree ?? null;

  // Git failed or the directory is not a repository. The rule set cannot
  // prove any checkout fact; `DISPATCH_FACTS_UNRELIABLE` covers it later.
  if (checkout.mainRoot === null) {
    return null;
  }

  if (checkout.isLinkedWorktree) {
    const registered = checkout.registeredTaskRef;
    // 7a. A worktree registered to another task is a proven conflict.
    if (registered !== null && !refsEqual(registered, task.ref)) {
      return block(
        "DISPATCH_CHECKOUT_OWNED_BY_OTHER",
        `checkout ${checkout.root} is registered to ${registered}, not ${task.ref}`,
        checkoutRecoveryCommands(facts, task),
        facts,
      );
    }
    // 7b. A task with a worktree must run in that worktree. Check this before
    // the unregistered fallback: otherwise an unregistered checkout would
    // downgrade a proven wrong-checkout violation to a warning.
    if (taskWorktree !== null && !samePath(taskWorktree, checkout.root)) {
      return wrongCheckout(facts, task, taskWorktree);
    }
    // 7c. An unregistered worktree is unproven ownership, not a violation.
    if (registered === null) {
      return allowWithGuard(
        "DISPATCH_CHECKOUT_UNREGISTERED",
        "warn",
        `linked worktree ${checkout.root} is not registered to any task`,
        "this linked worktree is not registered; Phronia cannot prove which task owns it",
        [ensureCommand(task.ref), "phronia task worktree prune"],
        facts,
      );
    }
    // 7d. Registered to this task and running in it.
    return null;
  }

  // Main checkout.
  if (taskWorktree !== null) {
    return wrongCheckout(facts, task, taskWorktree);
  }

  if (requiresIsolation(task, facts.siblings)) {
    if (task.parallel.worktree === "never") {
      return allowWithGuard(
        "DISPATCH_ISOLATION_DISABLED",
        "warn",
        `task ${task.ref} requires isolation, but parallel.worktree=never`,
        "this task requires isolation while worktree=never; two tasks may edit the same checkout",
        [
          ensureCommand(task.ref),
          "or set meta.parallel.worktree to auto/always before dispatch",
        ],
        facts,
      );
    }
    return block(
      "DISPATCH_ISOLATION_REQUIRED",
      isolationReason(facts, task),
      [
        ensureCommand(task.ref),
        "open a new session in the printed task worktree (Phronia cannot move this session)",
        `Active task: ${task.ref}`,
        `phronia task integrate ${task.ref}`,
      ],
      facts,
    );
  }

  const claim = facts.claim;
  if (claim !== null && !claim.stale) {
    if (claim.taskRef !== null && refsEqual(claim.taskRef, task.ref)) {
      return null;
    }
    if (
      claim.sessionKey !== null &&
      facts.sessionKey !== null &&
      claim.sessionKey === facts.sessionKey
    ) {
      return null;
    }
    return block(
      "DISPATCH_MAIN_CLAIMED",
      `main checkout is claimed by ${describeClaimOwner(claim)}, not ${task.ref}`,
      checkoutRecoveryCommands(facts, task),
      facts,
    );
  }

  if (claim !== null && claim.stale && checkout.mainDirty === true) {
    return block(
      "DISPATCH_STALE_CLAIM_DIRTY",
      "the main checkout has a stale claim and uncommitted changes; never reclaim automatically",
      [
        "git status --short",
        "git stash push -u   # or commit the changes",
        "phronia task workspace reclaim --force",
      ],
      facts,
    );
  }

  if (claim === null || claim.stale) {
    return allowWithGuard(
      "DISPATCH_NO_CLAIM",
      "warn",
      `main checkout is not claimed by ${task.ref}; a second session could share this tree`,
      "main is unclaimed; a second session or a parallel implement sub-agent will share this tree",
      [
        ensureCommand(task.ref),
        "re-dispatch implement after the workspace is recorded",
      ],
      facts,
    );
  }

  return null;
}

/** Rule 8: another live session owns this task's lease. Advisory only. */
function checkLease(
  facts: DispatchFacts,
  task: TaskFacts,
): DispatchVerdict | null {
  const lease = facts.lease;
  if (lease === null || lease.stale) {
    return null;
  }
  if (
    lease.sessionKey !== null &&
    facts.sessionKey !== null &&
    lease.sessionKey === facts.sessionKey
  ) {
    return null;
  }
  if (leaseOwnedByCurrent(lease, facts, task)) {
    return null;
  }
  return allowWithGuard(
    "DISPATCH_LEASE_OTHER_OWNER",
    "warn",
    `task ${task.ref} is leased to ${lease.ownerType} ${lease.ownerId}; another session may be working on it`,
    "another live session holds this task's lease; two sessions on one task share one worktree",
    [
      `phronia task lease status ${task.ref} --json`,
      "re-dispatch from the session that owns the lease, or release it explicitly",
    ],
    facts,
  );
}

function leaseOwnedByCurrent(
  lease: LeaseFacts,
  facts: DispatchFacts,
  task: TaskFacts,
): boolean {
  const identities = [facts.sessionKey, facts.activeTaskRef, task.ref];
  return identities.some(
    (identity) => identity !== null && lease.ownerId === identity,
  );
}

function wrongCheckout(
  facts: DispatchFacts,
  task: TaskFacts,
  worktree: string,
): DispatchVerdict {
  return block(
    "DISPATCH_WRONG_CHECKOUT",
    `task ${task.ref} has a worktree at ${worktree}, but the current checkout is ${facts.checkout.root}`,
    [`cd ${worktree}`, "re-dispatch implement from that checkout"],
    facts,
  );
}

function checkoutRecoveryCommands(
  facts: DispatchFacts,
  task: TaskFacts,
): readonly string[] {
  const worktree = facts.workspace?.taskWorktree ?? null;
  if (worktree !== null) {
    return [`cd ${worktree}`, "re-dispatch implement from that checkout"];
  }
  return [
    ensureCommand(task.ref),
    "open a new session in the printed task worktree",
    `Active task: ${task.ref}`,
  ];
}

function isolationReason(facts: DispatchFacts, task: TaskFacts): string {
  if (task.parallel.worktree === "always") {
    return `task ${task.ref} sets meta.parallel.worktree=always, but the current checkout is the main tree`;
  }
  if (task.parallel.exclusive) {
    return `task ${task.ref} is exclusive, but the current checkout is the main tree`;
  }
  const siblings = facts.siblings;
  const count = siblings === null ? 0 : siblings.inProgress;
  return `task ${task.ref} has ${count} in-progress siblings; parallel intent requires a worktree, but the current checkout is the main tree`;
}

function ensureCommand(taskRef: string): string {
  return `phronia task workspace ensure ${taskRef}`;
}

function block(
  code: DispatchCode,
  reason: string,
  next: readonly string[],
  facts: DispatchFacts,
): DispatchVerdict {
  return {
    decision: "block",
    code,
    severity: "error",
    reason,
    next,
    details: detailsFor(facts),
    guard: null,
  };
}

function allow(
  code: DispatchCode,
  severity: "info" | "warn",
  reason: string,
  next: readonly string[],
  facts: DispatchFacts,
): DispatchVerdict {
  return {
    decision: "allow",
    code,
    severity,
    reason,
    next,
    details: detailsFor(facts),
    guard: null,
  };
}

function allowWithGuard(
  code: DispatchCode,
  severity: "info" | "warn",
  reason: string,
  risk: string,
  next: readonly string[],
  facts: DispatchFacts,
): DispatchVerdict {
  return {
    decision: "allow",
    code,
    severity,
    reason,
    next,
    details: detailsFor(facts),
    guard: buildGuard(code, severity, risk, next, facts),
  };
}

/**
 * Guard body. The outer `<workspace-guard>` envelope and the platform-specific
 * "cannot block" wording are S2's responsibility; these lines are neutral and
 * safe to inject on every platform.
 */
function buildGuard(
  code: DispatchCode,
  severity: "info" | "warn",
  risk: string,
  next: readonly string[],
  facts: DispatchFacts,
): GuardBlock {
  const task = facts.effectiveTask;
  const lines: string[] = [];
  if (task !== null) {
    lines.push(`task: ${task.ref} (${task.status ?? "unknown"})`);
  }
  if (
    facts.activeTaskRef !== null &&
    (task === null || !refsEqual(facts.activeTaskRef, task.ref))
  ) {
    lines.push(`active: ${facts.activeTaskRef}`);
  }
  lines.push(`workspace: ${describeWorkspace(facts)}`);
  lines.push(`claim: ${describeClaim(facts.claim)}`);
  lines.push(`lease: ${describeLease(facts.lease)}`);
  lines.push(`parallel: ${describeParallel(facts)}`);
  lines.push(`risk: ${risk}`);
  if (next.length > 0) {
    lines.push("next:");
    next.forEach((command, index) => {
      lines.push(`  ${index + 1}. ${command}`);
    });
  }
  return { code, severity, lines };
}

function describeWorkspace(facts: DispatchFacts): string {
  if (!facts.factsReliable) {
    return "unknown (read failed)";
  }
  if (facts.checkout.isLinkedWorktree) {
    return `worktree ${facts.checkout.root}`;
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

function describeClaim(claim: ClaimFacts | null): string {
  if (claim === null) {
    return "none";
  }
  const owner = describeClaimOwner(claim);
  return claim.stale ? `stale (${owner})` : owner;
}

function describeClaimOwner(claim: ClaimFacts): string {
  // ownerRef already carries its type (`session:<key>` / `task:<ref>`); adding
  // another prefix would render `session session:<key>`.
  return claim.taskRef !== null ? `task ${claim.taskRef}` : claim.ownerRef;
}

function describeLease(lease: LeaseFacts | null): string {
  if (lease === null) {
    return "none";
  }
  const owner = `${lease.ownerType} ${lease.ownerId}`;
  return lease.stale ? `stale (${owner})` : owner;
}

function describeParallel(facts: DispatchFacts): string {
  const siblings = facts.siblings;
  if (siblings === null) {
    return "serial";
  }
  return `${siblings.inProgress} in_progress children (planning ${siblings.planning})`;
}

function detailsFor(facts: DispatchFacts): Readonly<Record<string, unknown>> {
  const task = facts.effectiveTask;
  return {
    agent: facts.agent,
    activeTask: facts.activeTaskRef,
    requestedTask: facts.requestedTaskRef,
    effectiveTask: task?.ref ?? null,
    status: task?.status ?? null,
    checkout: facts.checkout,
    workspace: facts.workspace,
    claim: facts.claim,
    lease: facts.lease,
    siblings: facts.siblings,
    factsReliable: facts.factsReliable,
  };
}

/**
 * Normalize a task ref to its repo-relative task key.
 *
 * `task.json` may store `10-28-foo`, `.phronia/tasks/10-28-foo`, or an absolute
 * path. The fact mapper is expected to canonicalize first; this fallback keeps
 * the policy correct when a caller hands it a raw record.
 */
function refKey(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  for (const marker of TASK_REF_MARKERS) {
    const index = normalized.indexOf(marker);
    if (index >= 0) {
      return normalized.slice(index + marker.length);
    }
  }
  return normalized.startsWith("tasks/")
    ? normalized.slice("tasks/".length)
    : normalized;
}

function refsEqual(left: string, right: string): boolean {
  return refKey(left) === refKey(right);
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}
