/**
 * Dispatch-admission domain types (design.md §4.1–§4.4).
 *
 * `evaluateDispatch` answers one question: "may this implementation/check
 * dispatch happen right now?" It is a pure function over facts. The read-only
 * state layer gathers the facts; the context layer renders the verdict. Keeping
 * the shapes here means no caller has to re-derive claim/lease/worktree rules.
 *
 * No field in this module implies IO, process state, or a platform branch.
 */

import type {
  HookPolicy,
  SubagentWorkspace,
} from "../../platform/capabilities.js";
import type { PlatformId } from "../../platform/ids.js";
import type { DispatchEnforce } from "../../state/config/readers.js";

export type { DispatchEnforce };

/** How a dispatched agent mutates the checkout. */
export type AgentMutation = "mutating" | "read-only" | "unknown";

/** Stable, English, public codes (design.md §4.4). */
export type DispatchCode =
  | "DISPATCH_PARENT_TASK"
  | "DISPATCH_TASK_NOT_IN_PROGRESS"
  | "DISPATCH_TASK_NOT_CHILD"
  | "DISPATCH_WRONG_CHECKOUT"
  | "DISPATCH_CHECKOUT_OWNED_BY_OTHER"
  | "DISPATCH_ISOLATION_REQUIRED"
  | "DISPATCH_MAIN_CLAIMED"
  | "DISPATCH_STALE_CLAIM_DIRTY"
  | "DISPATCH_NO_CLAIM"
  | "DISPATCH_LEASE_OTHER_OWNER"
  | "DISPATCH_NO_ACTIVE_TASK"
  | "DISPATCH_ISOLATION_DISABLED"
  | "DISPATCH_CHECKOUT_UNREGISTERED"
  | "DISPATCH_PLATFORM_CANNOT_BLOCK"
  | "DISPATCH_FACTS_UNRELIABLE"
  | "DISPATCH_OUTSIDE_CONTRACT"
  | "DISPATCH_OK";

/** The dispatch target's task intent, normalized to the fields policy reads. */
export interface TaskFacts {
  readonly ref: string;
  readonly id: string;
  /** Null when task.json could not be read or has no status. */
  readonly status: string | null;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly branch: string | null;
  readonly parallel: {
    readonly worktree: "auto" | "always" | "never" | null;
    readonly exclusive: boolean;
    readonly dependsOn: readonly string[];
  };
}

/** `workspace.claim.json` facts (owner of the main checkout). */
export interface ClaimFacts {
  readonly taskRef: string | null;
  readonly ownerRef: string;
  readonly sessionKey: string | null;
  readonly stale: boolean;
  readonly heartbeatAt: string | null;
}

/** `leases/<hash>.json` facts (who is doing a task). */
export interface LeaseFacts {
  readonly ownerType: "session" | "subagent" | "task";
  readonly ownerId: string;
  readonly sessionKey: string | null;
  readonly stale: boolean;
}

/**
 * Everything `evaluateDispatch` is allowed to look at.
 *
 * `sessionKey` is the current session identity. It is not part of
 * `design.md` §4.2's field list, but §4.5 rules 8d/9 compare claim/lease
 * owners against it; keeping it in the facts avoids the policy inventing an
 * identity source.
 */
export interface DispatchFacts {
  readonly platform: {
    readonly id: PlatformId;
    readonly hookPolicy: HookPolicy;
    readonly subagentWorkspace: SubagentWorkspace;
  };
  readonly agent: AgentMutation;
  /**
   * Whether dispatch admission may block. Included for diagnostics only:
   * S2 maps `warn`/`off` and the platform capability to deny vs guard.
   */
  readonly enforce: DispatchEnforce;

  /** Task the session currently points at (may be null). */
  readonly activeTaskRef: string | null;
  /** Task explicitly named by the payload/prompt (`Active task:`). */
  readonly requestedTaskRef: string | null;
  /** Decision target: requested ?? active. */
  readonly effectiveTask: TaskFacts | null;
  readonly checkout: {
    /** `request.projectRoot`; never `process.cwd()`. */
    readonly root: string;
    /** Null when git could not report the main worktree. */
    readonly mainRoot: string | null;
    readonly isLinkedWorktree: boolean;
    readonly branch: string;
    /** Task registered for the current checkout, null when unregistered. */
    readonly registeredTaskRef: string | null;
    /** Main checkout dirtiness; null when the read failed. */
    readonly mainDirty: boolean | null;
  };

  readonly workspace: {
    /** The effective task's worktree, null when it has none. */
    readonly taskWorktree: string | null;
    readonly taskBranch: string | null;
  } | null;

  readonly claim: ClaimFacts | null;
  readonly lease: LeaseFacts | null;
  /** Parent-relative sibling counts; null for a leaf/no parent context. */
  readonly siblings: {
    readonly total: number;
    readonly inProgress: number;
    readonly planning: number;
  } | null;
  /** False when a required fact could not be read. Never a reason to block. */
  readonly factsReliable: boolean;
  /** Current session identity, used only to recognize our own claim/lease. */
  readonly sessionKey: string | null;
}

/** An allow-time advisory block; S2 wraps it for the target platform. */
export interface GuardBlock {
  readonly code: DispatchCode;
  readonly severity: "info" | "warn" | "error";
  /** Formatted body lines (no outer `<workspace-guard>` tags). */
  readonly lines: readonly string[];
}

export interface DispatchVerdict {
  readonly decision: "allow" | "block";
  readonly code: DispatchCode;
  readonly severity: "info" | "warn" | "error";
  readonly reason: string;
  /** Executable commands, in stable order. Empty when nothing is actionable. */
  readonly next: readonly string[];
  /** Structured facts for shims, doctor, and audit logs. */
  readonly details: Readonly<Record<string, unknown>>;
  /** Set only for allow + advisory; null for block and plain allow. */
  readonly guard: GuardBlock | null;
}
