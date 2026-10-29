/**
 * Post-integration spec sync domain types.
 *
 * A task never writes `.phronia/spec/**` directly. It records intent in
 * `spec-delta.md`; after the code lands, the control plane applies the delta
 * under the integration lock. These shapes describe that intent and its
 * lifecycle, not the IO around it.
 */

/** Lifecycle stored in `meta.spec_sync.status`. */
export type SpecSyncState = "none" | "pending" | "synced" | "failed";

export interface SpecDelta {
  /** Repo-relative `.phronia/spec/**` files the task intends to change. */
  readonly targetFiles: readonly string[];
  /** What should change, as free-form bullets. */
  readonly intent: readonly string[];
  readonly rationale: readonly string[];
  readonly verification: readonly string[];
}

/**
 * Minimal task facts needed to decide whether a delta may be applied.
 * Deliberately structural so `state.TaskRecordView`, a raw record, or a test
 * fixture can all be passed.
 */
export interface SpecSyncTaskFacts {
  readonly meta: Readonly<Record<string, unknown>>;
  /** `spec-delta.md` exists in the task directory. */
  readonly hasDelta: boolean;
}

/** Per-task spec sync status projection (plan/status output). */
export interface SpecSyncResult {
  readonly taskRef: string;
  readonly state: SpecSyncState;
  readonly deltaPath: string | null;
  readonly commit: string | null;
  readonly syncedAt: string | null;
}

/** Invalid target reported by {@link validateSpecTargets}. */
export interface SpecTargetIssue {
  readonly target: string;
  readonly reason: string;
}
