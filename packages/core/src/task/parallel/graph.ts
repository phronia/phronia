/**
 * Dependency graph construction for parallel planning.
 *
 * `depends_on` is the only dependency source (design.md §5.3): parent/child
 * task links are not dependencies. References may be a full task ref
 * (`.phronia/tasks/10-28-a`), a task id, or the directory basename.
 *
 * All failures are returned as diagnostics with stable codes; the function
 * never throws and never logs.
 */

import { diagnostic } from "../../state/diagnostics.js";
import type { Diagnostic } from "../../state/diagnostics.js";
import type { TaskSnapshot } from "./types.js";

export interface DependencyGraph {
  /** Topologically ordered task refs. */
  readonly order: readonly string[];
  /** Dependency level per task ref; roots are level 0. */
  readonly levels: Readonly<Record<string, number>>;
  /** Resolved dependencies per task ref. */
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
}

export type DependencyGraphResult =
  | { readonly ok: true; readonly graph: DependencyGraph }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Resolve `depends_on` references and detect missing references and cycles.
 *
 * Missing references and cycles are both reported. When any error exists no
 * partial graph is returned, so callers cannot accidentally plan half a graph.
 */
export function buildDependencyGraph(
  tasks: readonly TaskSnapshot[],
): DependencyGraphResult {
  const lookup = buildLookup(tasks);
  const diagnostics: Diagnostic[] = [];
  const dependencies = new Map<string, readonly string[]>();

  for (const task of tasks) {
    const resolved: string[] = [];
    for (const reference of task.dependsOn) {
      const match = lookup.get(normalizeReference(reference));
      if (!match) {
        diagnostics.push(
          diagnostic(
            "DEPENDENCY_MISSING",
            "error",
            `task ${task.ref} depends_on unknown task "${reference}"`,
            {
              details: {
                taskRef: task.ref,
                missing: reference,
                candidates: tasks
                  .map((candidate) => candidate.ref)
                  .filter((ref) => ref !== task.ref),
              },
            },
          ),
        );
        continue;
      }
      if (!resolved.includes(match)) {
        resolved.push(match);
      }
    }
    dependencies.set(task.ref, resolved);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const cycle = findCycle(tasks, dependencies);
  if (cycle) {
    diagnostics.push(
      diagnostic(
        "DEPENDENCY_CYCLE",
        "error",
        `dependency cycle: ${cycle.join(" -> ")}`,
        { details: { cycle } },
      ),
    );
    return { ok: false, diagnostics };
  }

  const order: string[] = [];
  const levels = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (ref: string): number => {
    const known = levels.get(ref);
    if (known !== undefined) return known;
    // The graph is acyclic at this point, but guard anyway.
    if (visiting.has(ref)) return 0;
    visiting.add(ref);
    let level = 0;
    for (const dependency of dependencies.get(ref) ?? []) {
      level = Math.max(level, visit(dependency) + 1);
    }
    visiting.delete(ref);
    levels.set(ref, level);
    order.push(ref);
    return level;
  };

  for (const task of tasks) visit(task.ref);

  return {
    ok: true,
    graph: {
      order,
      levels: Object.fromEntries(levels),
      dependencies: Object.fromEntries(dependencies),
    },
  };
}

/** Tasks grouped by dependency level, preserving input order within a level. */
export function groupByLevel<T extends TaskSnapshot>(
  tasks: readonly T[],
  graph: DependencyGraph,
): ReadonlyMap<number, readonly T[]> {
  const groups = new Map<number, T[]>();
  for (const task of tasks) {
    const level = graph.levels[task.ref] ?? 0;
    const bucket = groups.get(level);
    if (bucket) bucket.push(task);
    else groups.set(level, [task]);
  }
  return groups;
}

function findCycle(
  tasks: readonly TaskSnapshot[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): readonly string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const walk = (ref: string): readonly string[] | null => {
    const status = state.get(ref);
    if (status === "done") return null;
    if (status === "visiting") {
      const start = stack.indexOf(ref);
      return [...stack.slice(start), ref];
    }
    state.set(ref, "visiting");
    stack.push(ref);
    for (const dependency of dependencies.get(ref) ?? []) {
      const cycle = walk(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(ref, "done");
    return null;
  };

  for (const task of tasks) {
    const cycle = walk(task.ref);
    if (cycle) return cycle;
  }
  return null;
}

function buildLookup(
  tasks: readonly TaskSnapshot[],
): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>();
  for (const task of tasks) {
    for (const key of candidateKeys(task)) {
      // First writer wins; duplicate ids are ambiguous but topologically
      // harmless because the planner still receives every task.
      if (!lookup.has(key)) lookup.set(key, task.ref);
    }
  }
  return lookup;
}

function candidateKeys(task: TaskSnapshot): readonly string[] {
  const keys = new Set<string>();
  keys.add(normalizeReference(task.ref));
  if (task.id !== "") keys.add(normalizeReference(task.id));
  const base = task.ref.split("/").filter((part) => part !== "").at(-1);
  if (base !== undefined && base !== "") keys.add(normalizeReference(base));
  return [...keys];
}

/**
 * Normalize a dependency reference so `.phronia/tasks/x`, `x`, and `./x`
 * compare identically. Case is preserved on purpose: task ids are
 * case-sensitive.
 */
export function normalizeReference(reference: string): string {
  let value = reference.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}
