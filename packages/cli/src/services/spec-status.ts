/**
 * Spec-sync projection for `doctor` and `parallel status` (R10).
 *
 * The lifecycle itself lives in core (`readSpecSyncState`,
 * `resolveSpecDisplayState`, `spec-delta.md` detection); this module only
 * joins those facts with the task records the CLI already reads.
 */

import { openState, type TaskRecordView } from "@phronia/core/state";
import {
  readSpecSyncState,
  resolveSpecDisplayState,
  type SpecSyncState,
} from "@phronia/core/task";

/** `failed` stays distinct from `pending` so operators can act on it. */
export type SpecDisplayState = "none" | "pending" | "synced" | "failed";

export interface TaskSpecState {
  readonly taskRef: string;
  readonly state: SpecDisplayState;
  readonly raw: SpecSyncState;
  readonly hasDelta: boolean;
}

export interface SpecStateSummary {
  /** Delta exists and the sync is not recorded as `synced`. */
  readonly pending: readonly string[];
  /** `meta.spec_sync.status === "failed"`. */
  readonly failed: readonly string[];
  readonly synced: number;
}

export function taskSpecState(
  taskRef: string,
  view: Pick<TaskRecordView, "meta"> | null,
  hasDelta: boolean,
): TaskSpecState {
  const raw = readSpecSyncState(view?.meta ?? {});
  const display = resolveSpecDisplayState({ hasDelta, syncState: raw });
  return {
    taskRef,
    state: raw === "failed" ? "failed" : display,
    raw,
    hasDelta,
  };
}

/** Every non-archived task in the main checkout. */
export function readSpecStates(root: string): TaskSpecState[] {
  const state = openState({ root });
  return state.tasks.list().map((summary) => {
    const view = state.tasks.read(summary.ref);
    return taskSpecState(
      summary.ref,
      view,
      state.tasks.artifacts(summary.ref).specDelta,
    );
  });
}

export function summarizeSpecStates(
  states: readonly TaskSpecState[],
): SpecStateSummary {
  return {
    pending: states
      .filter((state) => state.hasDelta && state.raw !== "synced")
      .map((state) => state.taskRef),
    failed: states
      .filter((state) => state.raw === "failed")
      .map((state) => state.taskRef),
    synced: states.filter((state) => state.raw === "synced").length,
  };
}
