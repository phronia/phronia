/**
 * Workspace decision domain types (design.md §4.2, §18.1).
 *
 * The isolation unit is the task, not the session: one task maps to one branch
 * and at most one worktree. Decisions are pure data so the CLI can render,
 * confirm, and persist them without core knowing about terminals.
 */

export type WorkspaceKind = "phronia" | "platform";

export type WorktreePolicy = "auto" | "always" | "never";

export interface WorkspaceWorktree {
  readonly path: string;
  readonly branch: string;
  readonly kind?: WorkspaceKind;
  readonly provisional?: boolean;
  readonly taskRef?: string | null;
}

export interface WorkspaceClaim {
  readonly ownerType: "session" | "task";
  readonly ownerRef: string;
  readonly taskRef: string | null;
  readonly workspace: string;
  readonly state: string;
  readonly host?: string;
  readonly heartbeatAt?: string;
  readonly ttlSeconds?: number;
  /** Computed by the caller: `heartbeatAt + ttlSeconds < now`. */
  readonly stale?: boolean;
  /** True when the claim was made by the current session/task. */
  readonly ownedByCurrent?: boolean;
  /** True while the owner task is still `planning` or `in_progress`. */
  readonly ownerActive?: boolean;
}

export interface WorkspaceTaskContext {
  readonly ref: string;
  /** Used for the default worktree directory name; falls back to the ref. */
  readonly id?: string;
  readonly branch?: string | null;
  readonly exclusive?: boolean;
  readonly worktree?: WorkspaceWorktree | null;
  readonly worktreePolicy?: WorktreePolicy;
  readonly status?: string;
}

export interface WorkspaceTarget {
  readonly path: string;
  readonly branch: string;
  /** The path already exists on disk. */
  readonly exists?: boolean;
  /** Another worktree already checks out this branch. */
  readonly checkedOutAt?: string | null;
}

export interface WorkspacePolicyContext {
  /** Absolute path of the current checkout (usually the main worktree). */
  readonly currentCheckout: string;
  /** The integration branch; new worktrees fork from here, never from another task. */
  readonly integrationBranch: string;
  readonly task: WorkspaceTaskContext;
  readonly claim?: WorkspaceClaim | null;
  readonly mainDirty: boolean;
  readonly mainDirtyPaths?: number;
  /** Number of tasks scheduled together; > 1 requires isolation. */
  readonly parallelBatchSize?: number;
  /** Shared worktree registry, used to find the task's existing worktree. */
  readonly existingWorktrees?: readonly WorkspaceWorktree[];
  readonly target?: WorkspaceTarget;
  /** `--reuse-dirty`: explicitly accept a dirty current checkout. */
  readonly reuseDirty?: boolean;
  /** `--force`: same as `reuseDirty` for workspace decisions. */
  readonly force?: boolean;
  /** Relative or absolute worktree directory. Defaults to `.phronia/worktrees`. */
  readonly worktreeDir?: string;
}

export type WorkspaceDecision =
  | { kind: "reuse-current"; reason: string; code?: string }
  | {
      kind: "attach";
      path: string;
      branch: string;
      reason: string;
      code?: string;
    }
  | {
      kind: "create";
      path: string;
      branch: string;
      base: string;
      reason: string;
      code?: string;
    }
  | { kind: "refuse"; code: string; reason: string; next: string };

export type WorkspaceDecisionKind = WorkspaceDecision["kind"];
