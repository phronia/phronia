/**
 * Coordinator domain types (design.md §17.7, §18.1, §20.5, §22).
 *
 * These are plain data shapes. The CLI layer reads tasks, leases, and
 * workspaces into them; the policy layer only decides.
 */

import type { PlatformCapabilities } from "../../platform/capabilities.js";
import type { BatchStatusSummary, TaskLease } from "../index-types.js";

/** Who dispatches the work when native coordinator mode is unavailable. */
export type CoordinatorFallback = "multi-session" | "serial";

export interface CoordinatorGate {
  readonly available: boolean;
  readonly reason: string | null;
  readonly fallback: CoordinatorFallback | null;
}

/** The subset of a task the scheduler needs. No IO. */
export interface BatchTask {
  readonly taskRef: string;
  readonly footprint: readonly string[];
  readonly dependsOn: readonly string[];
  readonly status: string;
  readonly priority: string;
  readonly createdAt?: string;
}

export interface Batch {
  readonly id: string;
  /** 1-based wave number as shown to the user. */
  readonly wave: number;
  readonly tasks: readonly string[];
  readonly maxConcurrent: number;
}

export interface DispatchWorkspace {
  readonly taskRef: string;
  readonly path: string;
  readonly branch: string;
}

export interface DispatchManifestEntry {
  readonly taskRef: string;
  readonly workspace: string;
  readonly branch: string;
  /** Stable lease identity; Phronia has no separate opaque token. */
  readonly lease: string;
  readonly dependsOn: readonly string[];
  readonly promptPrefix: string;
}

export interface DispatchManifest {
  readonly batch: string;
  readonly wave: number;
  readonly tasks: readonly DispatchManifestEntry[];
}

/** Aggregated coordinator state for a batch; blocked tasks do not stop it. */
export interface CoordinatorState {
  readonly mode: "coordinator";
  readonly batch: string;
  readonly wave: number;
  readonly tasks: readonly string[];
  readonly summary: BatchStatusSummary;
  readonly blocked: readonly string[];
  readonly next: string | null;
}

export interface WaveScheduleInput {
  /** Tasks that appeared after the batch started. */
  readonly newTasks: readonly BatchTask[];
  /** Tasks already executing anywhere in the batch. */
  readonly running: readonly BatchTask[];
  /** Tasks currently in the open wave that still accepts members. */
  readonly openWave?: readonly BatchTask[];
  readonly maxConcurrent: number;
}

export interface WaveAssignment {
  /** New tasks that may start now without exceeding the cap. */
  readonly join: readonly string[];
  /** New tasks that must wait for a later wave. */
  readonly next: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
}

/** A lease plus the scheduler-relevant fields, kept structural for tests. */
export type CoordinatorLease = Pick<
  TaskLease,
  | "taskRef"
  | "ownerType"
  | "ownerId"
  | "workspace"
  | "acquiredAt"
  | "heartbeatAt"
  | "ttlSeconds"
>;

export type CoordinatorCapabilities = Pick<
  PlatformCapabilities,
  "subagentExecution" | "subagentWorkspace" | "subagentIdentity"
>;
