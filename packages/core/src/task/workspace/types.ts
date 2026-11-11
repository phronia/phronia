/**
 * Workspace decision domain types (design.md §4.2, §18.1).
 *
 * The isolation unit is the task, not the session: one task maps to one branch
 * and at most one worktree. Decisions are pure data so the CLI can render,
 * confirm, and persist them without core knowing about terminals.
 */

import type {
  BaseRefFreshness,
  BaseRefResolution,
  BaseRefSource,
} from "./base.js";

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
  /**
   * Relative or absolute worktree directory.
   * @deprecated Use `worktreeRoot` (already resolved). Kept for one version so
   * callers that pass a raw relative directory keep working.
   */
  readonly worktreeDir?: string;
  /**
   * Already-resolved worktree root. When present it wins over `worktreeDir`.
   * Derive it with `resolveWorktreeRoot` rather than joining paths by hand, so
   * the layout default lives in exactly one place.
   */
  readonly worktreeRoot?: WorktreeRoot;
  /**
   * Resolved worktree base. When present it wins over `integrationBranch` and
   * carries provenance (source/commit/freshness) into the create decision.
   * Callers that omit it keep the legacy integration-branch behavior.
   */
  readonly base?: BaseRefResolution;
}

/**
 * Resolved task-worktree root.
 *
 * `absolute` is what the runtime writes to; `relativeFromRepo` is the
 * repository-relative POSIX form used for `.gitignore` patterns and JSON
 * output, and is null when the root cannot be expressed inside the repo.
 */
export interface WorktreeRoot {
  readonly absolute: string;
  readonly relativeFromRepo: string | null;
  readonly outsideRepo: boolean;
  readonly source: "config" | "default" | "ephemeral";
}

export interface WorkspaceBaseInfo {
  readonly source: BaseRefSource;
  readonly commit: string;
  readonly remote: boolean;
  readonly freshness: BaseRefFreshness;
  readonly behind: number | null;
  readonly ahead: number | null;
  readonly shouldAsk: boolean;
  readonly alternatives: readonly string[];
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
      baseInfo?: WorkspaceBaseInfo;
      reason: string;
      code?: string;
    }
  | { kind: "refuse"; code: string; reason: string; next: string };

export type WorkspaceDecisionKind = WorkspaceDecision["kind"];
