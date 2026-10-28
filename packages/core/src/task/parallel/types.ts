/**
 * Parallel planning domain types.
 *
 * These are plain data shapes: no IO, no rendering, no process state. The CLI
 * layer is responsible for reading task records and configuration into these
 * shapes. Shapes follow design.md §18.1.
 */

import type { Diagnostic } from "../../state/diagnostics.js";

export type FootprintKind = "declared" | "related" | "package" | "unknown";

export interface Footprint {
  readonly raw: readonly string[];
  readonly kind: FootprintKind;
}

export interface TaskSnapshot {
  readonly ref: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly footprint: Footprint;
  readonly dependsOn: readonly string[];
  readonly exclusive: boolean;
  readonly workspace: string | null;
  /**
   * Parent tasks are coordination containers, not execution units. A container
   * never enters a wave; it is reported as a diagnostic so `--explain` can name
   * the children to start instead.
   */
  readonly container?: boolean;
  readonly childCount?: number;
  /** Direct child refs, used to render executable `task.py start` commands. */
  readonly children?: readonly string[];
}

/**
 * A snapshot plus the ordering hint used by the planner. The extra field is
 * optional so a plain {@link TaskSnapshot} remains assignable.
 */
export interface PlannerTask extends TaskSnapshot {
  readonly createdAt?: string;
}

export interface Wave {
  readonly index: number;
  readonly tasks: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
}

export interface ParallelPlan {
  readonly waves: readonly Wave[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Sources the planner reads when normalizing a footprint. */
export interface FootprintSources {
  /** Maps `task.package` to a repository-relative directory. */
  readonly packagePaths?: Readonly<Record<string, string>>;
  /** Maps `task.scope` to repository-relative glob(s). */
  readonly scopePaths?: Readonly<Record<string, string | readonly string[]>>;
}

/** Raw task fields that contribute to a footprint. */
export interface TaskFootprintInput {
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly relatedFiles?: readonly string[];
  readonly package?: string | null;
  readonly scope?: string | null;
}

/** Planner-visible fields of `meta.parallel`. */
export interface ParallelMeta {
  readonly touches: readonly string[];
  readonly dependsOn: readonly string[];
  readonly exclusive: boolean;
  readonly worktree: "auto" | "always" | "never" | null;
  readonly allowUnknownFootprint: boolean;
}

export interface PlannerOptions extends FootprintSources {
  /** Mirrors `parallel.enabled`. Disabled planning reports a diagnostic. */
  readonly enabled?: boolean;
  /** Maximum tasks in one wave. Values below 1 fall back to the default. */
  readonly maxConcurrent?: number;
  /**
   * Mirrors `--allow-unknown`: accept the risk of parallelizing tasks with no
   * footprint. Without it an unknown footprint is a singleton wave.
   */
  readonly allowUnknown?: boolean;
  /** Mirrors `parallel.conflicts.always_serial`. */
  readonly alwaysSerial?: readonly string[];
  /**
   * Refs the caller explicitly asked for (`--refs`). A container selected this
   * way is reported as a warning: the user picked the wrong execution unit.
   */
  readonly requestedRefs?: readonly string[];
}

export type OverlapKind =
  | "none"
  | "unknown"
  | "equal"
  | "prefix"
  | "glob"
  | "package";

export interface OverlapResult {
  readonly overlap: boolean;
  readonly kind: OverlapKind;
  readonly a: string;
  readonly b: string;
  /** Representative normalized path used in explain output. */
  readonly path: string;
  /** Human-readable reason, e.g. `overlap: src/shared/**`. */
  readonly reason: string;
}
