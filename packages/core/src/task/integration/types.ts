/**
 * Integration domain types: mode resolution, conflict classification, and the
 * shared integration queue. Shapes follow design.md §18.1 and §8.
 */

import type { Diagnostic } from "../../state/diagnostics.js";
import type { Footprint } from "../parallel/types.js";

export type IntegrationMode = "auto" | "local" | "remote";

export type IntegrationOutcome =
  | "none"
  | "landed"
  | "pushed"
  | "blocked"
  | "needs_human";

export type ConflictKind =
  | "mechanical"
  | "semantic"
  | "generated"
  | "duplicate"
  | "race"
  | "needs_human";

export type ResolvedMode = Exclude<IntegrationMode, "auto">;

export type ModeSource = "task" | "cli" | "project" | "auto";

export type ConfirmationMode = "auto" | "always" | "never";

export interface IntegrationModeContext {
  /** `meta.integration.mode` (a user-confirmed choice is recorded here). */
  readonly taskMode?: IntegrationMode | null;
  /** `--mode`. */
  readonly cliMode?: IntegrationMode | null;
  /** `parallel.integration.mode`. */
  readonly projectMode?: IntegrationMode | null;
  readonly hasOrigin: boolean;
  readonly forgeCliAvailable: boolean;
  readonly confirm?: ConfirmationMode;
  /** A task using the main checkout cannot be integrated remotely. */
  readonly taskUsesMain?: boolean;
  /** Defaults to true; local integration is always available. */
  readonly localAvailable?: boolean;
  /** Defaults to `hasOrigin`; remote also needs the branch to be pushable. */
  readonly remoteAvailable?: boolean;
  /** Projects that require review/CI prefer remote but still ask once. */
  readonly requiresReviewOrCi?: boolean;
  /** Whether a mode was already recorded on the task. Defaults to taskMode. */
  readonly modeRecorded?: boolean;
}

export interface IntegrationModeResolution {
  readonly mode: ResolvedMode;
  readonly source: ModeSource;
  /** One-line explanation, safe to print verbatim. */
  readonly reason: string;
  readonly shouldAsk: boolean;
  readonly alternatives: readonly ResolvedMode[];
  /** True when an explicit mode was rejected (e.g. remote for a main task). */
  readonly invalid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ConflictInput {
  /**
   * Paths that produced rebase conflicts. Empty means the rebase was clean;
   * a clean rebase with `verificationFailed` is the semantic case.
   */
  readonly conflictFiles?: readonly string[];
  /** Paths that are add/add duplicates. */
  readonly addAddFiles?: readonly string[];
  /** `parallel.conflicts.generated`. */
  readonly generatedPatterns?: readonly string[];
  /** `parallel.conflicts.always_serial`. */
  readonly alwaysSerialPatterns?: readonly string[];
  /** The task footprint, used to decide whether a conflict is mechanical. */
  readonly footprint?: Footprint;
  /** Verification ran on the rebased tree and failed. */
  readonly verificationFailed?: boolean;
  /** Fast-forward failed because the integration branch moved. */
  readonly baseMoved?: boolean;
  /** `parallel.conflicts.mechanical_max_files` (default 5). */
  readonly mechanicalMaxFiles?: number;
  /** `parallel.conflicts.regenerate` is configured. */
  readonly regenerateConfigured?: boolean;
}

export interface ConflictClassification {
  readonly kind: ConflictKind;
  readonly files: readonly string[];
  readonly reason: string;
  readonly next: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** One waiting entry in `<git-common-dir>/phronia/integration.json`. */
export interface QueueEntry {
  readonly taskRef: string;
  readonly enqueuedAt: string;
  readonly mode: IntegrationMode;
  readonly baseBranch?: string;
}

export interface DequeueResult {
  readonly entry: QueueEntry | null;
  readonly queue: readonly QueueEntry[];
}

export interface EnqueueResult {
  readonly entry: QueueEntry;
  readonly queue: readonly QueueEntry[];
  readonly added: boolean;
}
