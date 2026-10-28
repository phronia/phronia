/**
 * Deterministic wave planner.
 *
 * Rules (design.md §5.3):
 * - dependency levels come from `depends_on`; tasks never move to an earlier
 *   level;
 * - within a level tasks are sorted by priority, creation time, then ref, and
 *   greedily packed into waves up to `max_concurrent`;
 * - unknown footprints, `exclusive` tasks, and always-serial paths each form a
 *   singleton wave.
 *
 * Every task carries a human-readable reason so `--explain` is always able to
 * answer "why serial?" / "why parallel?".
 */

import { diagnostic } from "../../state/diagnostics.js";
import type { Diagnostic } from "../../state/diagnostics.js";
import {
  footprintOverlap,
  normalizePathPattern,
} from "./footprint.js";
import { buildDependencyGraph, groupByLevel } from "./graph.js";
import type {
  Footprint,
  OverlapResult,
  ParallelPlan,
  PlannerOptions,
  PlannerTask,
  Wave,
} from "./types.js";

export const DEFAULT_MAX_CONCURRENT = 3;

/** Mirrors `parallel.conflicts.always_serial` defaults in design.md §5.5. */
export const DEFAULT_ALWAYS_SERIAL: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "**/migrations/**",
  "**/migration/**",
  "docs/requirements.md",
  ".phronia/config.yaml",
  ".phronia/workflow.md",
  ".phronia/spec/**",
  ".phronia/gate.yaml",
];

interface PendingWave {
  readonly tasks: PlannerTask[];
  readonly reasons: Record<string, string>;
  readonly sealed: boolean;
}

interface ConflictInfo {
  readonly ref: string;
  readonly result: OverlapResult;
}

export function planParallel(
  tasks: readonly PlannerTask[],
  options: PlannerOptions = {},
): ParallelPlan {
  if (options.enabled === false) {
    return {
      waves: [],
      diagnostics: [
        diagnostic(
          "PARALLEL_DISABLED",
          "warn",
          "parallel planning is disabled (parallel.enabled=false)",
          { details: { next: "set parallel.enabled: true" } },
        ),
      ],
    };
  }

  if (tasks.length === 0) {
    return {
      waves: [],
      diagnostics: [
        diagnostic("PARALLEL_NO_TASKS", "info", "no active tasks to plan"),
      ],
    };
  }

  const requested = new Set(options.requestedRefs ?? []);
  const containers = tasks.filter((task) => task.container === true);
  const containerRefs = new Set(containers.map((task) => task.ref));
  const diagnostics: Diagnostic[] = containers.map((task) =>
    containerDiagnostic(task, requested.has(task.ref)),
  );

  const graphResult = buildDependencyGraph(tasks);
  if (!graphResult.ok) {
    return { waves: [], diagnostics: [...diagnostics, ...graphResult.diagnostics] };
  }

  const maxConcurrent = resolveMaxConcurrent(options.maxConcurrent);
  const allowUnknown = options.allowUnknown === true;
  const alwaysSerial = options.alwaysSerial ?? DEFAULT_ALWAYS_SERIAL;
  const waves: Wave[] = [];

  // A plan made only of containers has no execution units. Return the
  // container diagnostics rather than a bare PARALLEL_NO_TASKS, so the caller
  // can still print the children to start.
  if (tasks.length === containers.length) {
    return { waves: [], diagnostics };
  }

  const groups = groupByLevel(tasks, graphResult.graph);
  const levels = [...groups.keys()].sort((a, b) => a - b);

  for (const level of levels) {
    const sorted = [...(groups.get(level) ?? [])]
      .filter((task) => !containerRefs.has(task.ref))
      .sort(compareTasks);
    const pending: PendingWave[] = [];

    for (const task of sorted) {
      const forced = forcedSingleton(task, alwaysSerial, allowUnknown);
      if (forced) {
        pending.push({
          tasks: [task],
          reasons: { [task.ref]: forced.reason },
          sealed: true,
        });
        if (forced.diagnostic) diagnostics.push(forced.diagnostic);
        continue;
      }

      const placed = tryPack(task, pending, maxConcurrent, allowUnknown);
      if (placed) continue;

      const conflict = firstConflict(task, pending, allowUnknown);
      const joinable = pending.filter((wave) => !wave.sealed);
      const allFull =
        joinable.length > 0 &&
        joinable.every((wave) => wave.tasks.length >= maxConcurrent);
      const reason =
        conflict !== null
          ? joinReason(
              baseReason(task),
              `${conflict.result.reason} with ${conflict.ref}`,
            )
          : allFull
            ? joinReason(baseReason(task), `max_concurrent: ${maxConcurrent}`)
            : baseReason(task);
      pending.push({
        tasks: [task],
        reasons: { [task.ref]: reason },
        sealed: false,
      });
    }

    for (const wave of pending) {
      waves.push({
        index: waves.length,
        tasks: wave.tasks.map((task) => task.ref),
        reasons: wave.reasons,
      });
    }
  }

  if (waves.length > 1 && waves.every((wave) => wave.tasks.length === 1)) {
    diagnostics.push(
      diagnostic(
        "PARALLEL_SERIAL_ONLY",
        "info",
        "no tasks can share a wave; every task must run serially",
        {
          details: {
            reasons: Object.fromEntries(
              waves.flatMap((wave) =>
                Object.entries(wave.reasons).map(([ref, reason]) => [
                  ref,
                  reason,
                ]),
              ),
            ),
          },
        },
      ),
    );
  }

  return { waves, diagnostics };
}

/**
 * Parent tasks coordinate children; they are never execution units.
 *
 * A container selected explicitly via `--refs` is a warning (the caller picked
 * the wrong unit) while one merely present in the backlog is informational.
 */
function containerDiagnostic(
  task: PlannerTask,
  explicit: boolean,
): Diagnostic {
  const children = task.children ?? [];
  const childCount = task.childCount ?? children.length;
  const next = children.map(
    (child) => `python3 ./.phronia/scripts/task.py start ${child}`,
  );
  const noun = childCount === 1 ? "child" : "children";
  return diagnostic(
    "PARALLEL_CONTAINER_TASK",
    explicit ? "warn" : "info",
    explicit
      ? `task ${task.ref} is a parent/coordinator container (${childCount} ${noun}); it cannot be scheduled. Start a child instead`
      : `task ${task.ref} is a parent/coordinator container (${childCount} ${noun}); excluded from waves`,
    {
      details: {
        taskRef: task.ref,
        childCount,
        children,
        next,
        explicit,
      },
    },
  );
}

function tryPack(
  task: PlannerTask,
  pending: readonly PendingWave[],
  maxConcurrent: number,
  allowUnknown: boolean,
): boolean {
  for (const wave of pending) {
    if (wave.sealed) continue;
    if (wave.tasks.length >= maxConcurrent) continue;
    if (firstConflict(task, [wave], allowUnknown) !== null) continue;
    wave.tasks.push(task);
    wave.reasons[task.ref] = baseReason(task);
    return true;
  }
  return false;
}

function firstConflict(
  task: PlannerTask,
  pending: readonly PendingWave[],
  allowUnknown: boolean,
): ConflictInfo | null {
  for (const wave of pending) {
    if (wave.sealed) continue;
    for (const member of wave.tasks) {
      const result = footprintOverlap(task.footprint, member.footprint);
      if (!result.overlap) continue;
      if (result.kind === "unknown" && allowUnknown) continue;
      return { ref: member.ref, result };
    }
  }
  return null;
}

interface ForcedSingleton {
  readonly reason: string;
  readonly diagnostic?: Diagnostic;
}

function forcedSingleton(
  task: PlannerTask,
  alwaysSerial: readonly string[],
  allowUnknown: boolean,
): ForcedSingleton | null {
  if (task.exclusive) return { reason: "exclusive" };

  const serialPattern = matchAlwaysSerial(task.footprint, alwaysSerial);
  if (serialPattern !== null) {
    return { reason: `always_serial: ${serialPattern}` };
  }

  if (isUnknown(task.footprint) && !allowUnknown) {
    return {
      reason: "unknown_footprint",
      diagnostic: diagnostic(
        "FOOTPRINT_UNKNOWN",
        "warn",
        `task ${task.ref} has no footprint; scheduled serially. Run \`phronia task footprint set ${task.ref} <path-or-glob>...\` to allow parallel scheduling.`,
        {
          details: {
            taskRef: task.ref,
            next: `phronia task footprint set ${task.ref} <path-or-glob>...`,
          },
        },
      ),
    };
  }

  return null;
}

function matchAlwaysSerial(
  footprint: Footprint,
  patterns: readonly string[],
): string | null {
  if (footprint.kind === "unknown") return null;
  for (const pattern of patterns) {
    const normalized = normalizePathPattern(pattern);
    if (normalized === "") continue;
    const serialFootprint: Footprint = {
      raw: [normalized],
      kind: "declared",
    };
    if (footprintOverlap(footprint, serialFootprint).overlap) return pattern;
  }
  return null;
}

function baseReason(task: PlannerTask): string {
  if (task.dependsOn.length > 0) {
    return `depends_on: ${task.dependsOn.join(", ")}`;
  }
  return "independent";
}

function joinReason(base: string, suffix: string): string {
  return `${base}; ${suffix}`;
}

function isUnknown(footprint: Footprint): boolean {
  return footprint.kind === "unknown" || footprint.raw.length === 0;
}

function resolveMaxConcurrent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_CONCURRENT;
  }
  return Math.floor(value);
}

function compareTasks(left: PlannerTask, right: PlannerTask): number {
  const priority = priorityRank(left.priority) - priorityRank(right.priority);
  if (priority !== 0) return priority;

  const leftCreated = left.createdAt ?? "";
  const rightCreated = right.createdAt ?? "";
  if (leftCreated !== rightCreated) {
    if (leftCreated === "") return 1;
    if (rightCreated === "") return -1;
    return leftCreated < rightCreated ? -1 : 1;
  }

  return left.ref.localeCompare(right.ref);
}

function priorityRank(priority: string): number {
  switch (priority.toUpperCase()) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
    default:
      return 99;
  }
}
