/**
 * Shared task index and task lease domain types (design.md §17.4, §17.5,
 * §18.1, §19.2, §19.3).
 */

import type { Diagnostic } from "../state/diagnostics.js";
import type { IntegrationOutcome } from "./integration/types.js";

export interface TaskIndexOwner {
  type: "session" | "subagent" | "task";
  id: string;
  sessionKey?: string;
}

export interface TaskIndexEntry {
  taskRef: string;
  title: string;
  status: string;
  priority: string;
  footprint: readonly string[];
  dependsOn: readonly string[];
  owner: TaskIndexOwner | null;
  workspace: string | null;
  updatedAt: string;
}

export interface TaskIndexFile {
  schemaVersion: 1;
  generatedAt?: string;
  tasks: readonly TaskIndexEntry[];
}

export interface TaskLease {
  taskRef: string;
  ownerType: "session" | "subagent" | "task";
  ownerId: string;
  sessionKey?: string;
  workspace: string;
  acquiredAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
}

export interface LeaseRequest {
  readonly taskRef: string;
  readonly ownerType: TaskLease["ownerType"];
  readonly ownerId: string;
  readonly sessionKey?: string;
  readonly workspace: string;
  readonly ttlSeconds?: number;
}

export type LeaseAcquireResult =
  | { readonly ok: true; readonly lease: TaskLease }
  | {
      readonly ok: false;
      readonly code: "LEASE_BUSY";
      readonly owner: TaskLease;
      readonly next: string;
      readonly diagnostics: readonly Diagnostic[];
    };

export type BatchTaskState =
  | "queued"
  | "running"
  | "blocked"
  | "landed"
  | "needs_human";

export interface BatchTaskInput {
  readonly taskRef: string;
  /** task.json status (`planning`, `in_progress`, `blocked`, ...). */
  readonly status: string;
  /** `meta.integration.outcome`. */
  readonly outcome?: IntegrationOutcome | string | null;
  /** Explicit batch state; overrides derivation. */
  readonly state?: BatchTaskState;
}

export interface BatchStatusSummary {
  readonly total: number;
  readonly byState: Readonly<Record<BatchTaskState, number>>;
  readonly queued: readonly string[];
  readonly running: readonly string[];
  readonly blocked: readonly string[];
  readonly landed: readonly string[];
  readonly needsHuman: readonly string[];
  /** True once no task is queued or running. */
  readonly done: boolean;
}

export interface NormalizeIndexSuccess {
  readonly ok: true;
  readonly entry: TaskIndexEntry;
}

export interface NormalizeIndexFailure {
  readonly ok: false;
  readonly diagnostics: readonly Diagnostic[];
}

export type NormalizeIndexResult = NormalizeIndexSuccess | NormalizeIndexFailure;
