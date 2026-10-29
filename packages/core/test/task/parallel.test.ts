import { describe, expect, it } from "vitest";

import {
  footprintOverlap,
  normalizeFootprint,
  pathMatchesPattern,
  pathWithinFootprint,
  readParallelMeta,
} from "../../src/task/parallel/footprint.js";
import {
  buildDependencyGraph,
  groupByLevel,
} from "../../src/task/parallel/graph.js";
import { planParallel } from "../../src/task/parallel/planner.js";
import type {
  Footprint,
  ParallelPlan,
  PlannerOptions,
  PlannerTask,
} from "../../src/task/parallel/types.js";

function declared(...raw: string[]): Footprint {
  return { raw, kind: "declared" };
}

function task(
  ref: string,
  footprint: Footprint,
  overrides: Partial<PlannerTask> = {},
): PlannerTask {
  const basename = ref.split("/").filter((part) => part !== "").at(-1) ?? ref;
  return {
    ref,
    id: basename,
    title: ref,
    status: "in_progress",
    priority: "P2",
    footprint,
    dependsOn: [],
    exclusive: false,
    workspace: null,
    ...overrides,
  };
}

function plan(
  tasks: readonly PlannerTask[],
  options: PlannerOptions = {},
): ParallelPlan {
  return planParallel(tasks, options);
}

function waveOf(result: ParallelPlan, ref: string): number {
  return result.waves.findIndex((wave) => wave.tasks.includes(ref));
}

describe("normalizeFootprint", () => {
  it("prefers meta.parallel.touches over relatedFiles and package", () => {
    const footprint = normalizeFootprint(
      {
        meta: { parallel: { touches: ["src/a/**"] } },
        relatedFiles: ["src/b.ts"],
        package: "cli",
      },
      { packagePaths: { cli: "packages/cli" } },
    );
    expect(footprint).toEqual({ raw: ["src/a/**"], kind: "declared" });
  });

  it("falls back to relatedFiles", () => {
    const footprint = normalizeFootprint({
      relatedFiles: ["src/b.ts", "src/c.ts"],
      package: "cli",
    });
    expect(footprint).toEqual({
      raw: ["src/b.ts", "src/c.ts"],
      kind: "related",
    });
  });

  it("falls back to a mapped package path", () => {
    const footprint = normalizeFootprint(
      { package: "cli" },
      { packagePaths: { cli: "packages/cli" } },
    );
    expect(footprint).toEqual({
      raw: ["packages/cli/**"],
      kind: "package",
    });
  });

  it("uses the conventional packages/<name> path when no mapping exists", () => {
    const footprint = normalizeFootprint({ package: "core" });
    expect(footprint).toEqual({ raw: ["packages/core/**"], kind: "package" });
  });

  it("uses scope mappings when present", () => {
    const footprint = normalizeFootprint(
      { scope: "backend", package: "cli" },
      { scopePaths: { backend: ["packages/core/src/**"] } },
    );
    expect(footprint).toEqual({
      raw: ["packages/core/src/**"],
      kind: "declared",
    });
  });

  it("returns unknown when nothing is declared", () => {
    expect(normalizeFootprint({})).toEqual({ raw: [], kind: "unknown" });
  });

  it("ignores malformed meta.parallel values instead of guessing", () => {
    const footprint = normalizeFootprint({
      meta: { parallel: { touches: "src/a/**", depends_on: [1, "x"] } },
      relatedFiles: ["src/b.ts"],
    });
    expect(footprint).toEqual({
      raw: ["src/b.ts"],
      kind: "related",
    });
    expect(readParallelMeta({ parallel: { touches: "nope" } }).touches).toEqual(
      [],
    );
  });

  it("normalizes separators, ./ prefixes, trailing slashes, and duplicates", () => {
    const footprint = normalizeFootprint({
      meta: {
        parallel: {
          touches: [".\\src\\a\\**", "src/a/**", "./src//b/", ""],
        },
      },
    });
    expect(footprint.raw).toEqual(["src/a/**", "src/b"]);
  });

  it("reads depends_on and exclusive flags from meta.parallel", () => {
    const meta = readParallelMeta({
      parallel: {
        depends_on: ["10-28-a"],
        exclusive: true,
        worktree: "always",
        allow_unknown_footprint: true,
      },
    });
    expect(meta).toEqual({
      touches: [],
      dependsOn: ["10-28-a"],
      exclusive: true,
      worktree: "always",
      allowUnknownFootprint: true,
    });
  });
});

describe("footprintOverlap", () => {
  const cases: readonly {
    name: string;
    a: Footprint;
    b: Footprint;
    overlap: boolean;
    kind?: string;
    path?: string;
  }[] = [
    {
      name: "equal literal paths overlap",
      a: declared("src/shared/**"),
      b: declared("src/shared/**"),
      overlap: true,
      kind: "equal",
      path: "src/shared/**",
    },
    {
      name: "a directory prefix overlaps",
      a: declared("src/a"),
      b: declared("src/a/b.ts"),
      overlap: true,
      kind: "prefix",
      path: "src/a",
    },
    {
      name: "a trailing /** glob covers a child path",
      a: declared("src/a/**"),
      b: declared("src/a/b.ts"),
      overlap: true,
      kind: "glob",
      path: "src/a/**",
    },
    {
      name: "a leading **/ glob matches matching segments",
      a: declared("**/migrations/**"),
      b: declared("db/migrations/001.sql"),
      overlap: true,
      kind: "glob",
      path: "**/migrations/**",
    },
    {
      name: "unknown overlaps everything",
      a: { raw: [], kind: "unknown" },
      b: declared("src/b.ts"),
      overlap: true,
      kind: "unknown",
    },
    {
      name: "the same package-level footprint overlaps",
      a: { raw: ["packages/cli/**"], kind: "package" },
      b: { raw: ["packages/cli/**"], kind: "package" },
      overlap: true,
      kind: "package",
      path: "packages/cli/**",
    },
    {
      name: "different packages do not overlap",
      a: { raw: ["packages/a/**"], kind: "package" },
      b: { raw: ["packages/b/**"], kind: "package" },
      overlap: false,
      kind: "none",
    },
    {
      name: "different file-level literals do not overlap",
      a: declared("src/a.ts"),
      b: declared("src/b.ts"),
      overlap: false,
      kind: "none",
    },
    {
      name: "comparison is case-insensitive",
      a: declared("Src/Shared/**"),
      b: declared("src/shared/**"),
      overlap: true,
      kind: "equal",
      path: "Src/Shared/**",
    },
    {
      name: "unrelated globs do not overlap",
      a: declared("src/a/*.ts"),
      b: declared("src/b/*.ts"),
      overlap: false,
      kind: "none",
    },
    {
      name: "a common string prefix is not a directory prefix",
      a: declared("src/a"),
      b: declared("src/ab"),
      overlap: false,
      kind: "none",
    },
    {
      name: "trailing slashes are ignored",
      a: declared("src/shared/"),
      b: declared("src/shared"),
      overlap: true,
      kind: "equal",
      path: "src/shared",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = footprintOverlap(testCase.a, testCase.b);
      expect(result.overlap).toBe(testCase.overlap);
      expect(result.kind).toBe(testCase.kind);
      if (testCase.path !== undefined) {
        expect(result.path).toBe(testCase.path);
        expect(result.reason).toBe(`overlap: ${testCase.path}`);
      }
    });
  }
});

describe("pathMatchesPattern", () => {
  it("matches design always-serial patterns", () => {
    expect(pathMatchesPattern("pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(true);
    expect(pathMatchesPattern("**/migrations/**", "db/migrations/x.sql")).toBe(
      true,
    );
    expect(pathMatchesPattern(".phronia/spec/**", ".phronia/spec/core/a.md")).toBe(
      true,
    );
    expect(pathMatchesPattern("**/dist/**", "packages/core/dist/index.js")).toBe(
      true,
    );
    expect(pathMatchesPattern("**/migrations/**", "src/app.ts")).toBe(false);
    expect(pathMatchesPattern("src/*.ts", "src/a.ts")).toBe(true);
    expect(pathMatchesPattern("src/*.ts", "src/nested/a.ts")).toBe(false);
    expect(pathMatchesPattern("src/**/*.ts", "src/nested/a.ts")).toBe(true);
  });
});

describe("pathWithinFootprint", () => {
  it("treats a literal directory footprint as covering its children", () => {
    expect(pathWithinFootprint("src/a/b.ts", declared("src/a"))).toBe(true);
    expect(pathWithinFootprint("src/ab.ts", declared("src/a"))).toBe(false);
    expect(pathWithinFootprint("src/a/b.ts", declared("src/a/**"))).toBe(true);
    expect(pathWithinFootprint("src/b.ts", declared("src/a"))).toBe(false);
  });
});

describe("buildDependencyGraph", () => {
  it("resolves refs by id and basename and assigns levels", () => {
    const result = buildDependencyGraph([
      task(".phronia/tasks/10-28-a", declared("src/a/**")),
      task(".phronia/tasks/10-28-b", declared("src/b/**"), {
        id: "b",
        dependsOn: ["10-28-a"],
      }),
      task(".phronia/tasks/10-28-c", declared("src/c/**"), {
        id: "c",
        dependsOn: [".phronia/tasks/10-28-b"],
      }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.levels).toEqual({
      ".phronia/tasks/10-28-a": 0,
      ".phronia/tasks/10-28-b": 1,
      ".phronia/tasks/10-28-c": 2,
    });
    expect(result.graph.order).toEqual([
      ".phronia/tasks/10-28-a",
      ".phronia/tasks/10-28-b",
      ".phronia/tasks/10-28-c",
    ]);
  });

  it("groups tasks by dependency level", () => {
    const tasks = [
      task("a", declared("src/a/**")),
      task("b", declared("src/b/**"), { dependsOn: ["a"] }),
    ];
    const result = buildDependencyGraph(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const groups = groupByLevel(tasks, result.graph);
    expect(groups.get(0)?.map((item) => item.ref)).toEqual(["a"]);
    expect(groups.get(1)?.map((item) => item.ref)).toEqual(["b"]);
  });

  it("reports a missing dependency with candidates", () => {
    const result = buildDependencyGraph([
      task("a", declared("src/a/**")),
      task("b", declared("src/b/**"), { dependsOn: ["ghost"] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(1);
    const [missing] = result.diagnostics;
    expect(missing.code).toBe("DEPENDENCY_MISSING");
    expect(missing.details).toEqual({
      taskRef: "b",
      missing: "ghost",
      candidates: ["a"],
    });
  });

  it("reports a cycle path and returns no partial graph", () => {
    const result = buildDependencyGraph([
      task("A", declared("src/a/**"), { dependsOn: ["B"] }),
      task("B", declared("src/b/**"), { dependsOn: ["A"] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("DEPENDENCY_CYCLE");
    expect(result.diagnostics[0]?.message).toContain("A -> B -> A");
    expect(result.diagnostics[0]?.details).toEqual({ cycle: ["A", "B", "A"] });
  });

  it("detects self-cycles", () => {
    const result = buildDependencyGraph([
      task("A", declared("src/a/**"), { dependsOn: ["A"] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.details).toEqual({ cycle: ["A", "A"] });
  });

  it("detects longer cycles", () => {
    const result = buildDependencyGraph([
      task("A", declared("src/a/**"), { dependsOn: ["C"] }),
      task("B", declared("src/b/**"), { dependsOn: ["A"] }),
      task("C", declared("src/c/**"), { dependsOn: ["B"] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.message).toContain("A -> C -> B -> A");
  });
});

describe("planParallel", () => {
  it("PLAN-01: packs three independent tasks into one wave", () => {
    const result = plan([
      task("a", declared("src/a/**")),
      task("b", declared("src/b/**")),
      task("c", declared("src/c/**")),
    ]);
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]?.tasks).toEqual(["a", "b", "c"]);
    expect(result.waves[0]?.reasons).toEqual({
      a: "independent",
      b: "independent",
      c: "independent",
    });
  });

  it("PLAN-02: splits overlapping tasks and explains the overlap", () => {
    const result = plan([
      task("a", declared("src/shared/**")),
      task("b", declared("src/shared/**")),
    ]);
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0]?.tasks).toEqual(["a"]);
    expect(result.waves[1]?.tasks).toEqual(["b"]);
    expect(result.waves[1]?.reasons.b).toContain("overlap: src/shared/**");
    expect(result.waves[1]?.reasons.b).toContain("a");
  });

  it("PLAN-03: schedules an unknown footprint alone with a next command", () => {
    const result = plan([
      task("a", declared("src/a/**")),
      task("unknown", { raw: [], kind: "unknown" }),
    ]);
    expect(result.waves).toHaveLength(2);
    expect(waveOf(result, "unknown")).toBe(1);
    expect(result.waves[1]?.reasons.unknown).toBe("unknown_footprint");
    const diagnostic = result.diagnostics.find(
      (item) => item.code === "FOOTPRINT_UNKNOWN",
    );
    expect(diagnostic?.message).toContain(
      "phronia task footprint set unknown",
    );
  });

  it("PLAN-04: rejects a dependency cycle without emitting partial waves", () => {
    const result = plan([
      task("A", declared("src/a/**"), { dependsOn: ["B"] }),
      task("B", declared("src/b/**"), { dependsOn: ["A"] }),
    ]);
    expect(result.waves).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("DEPENDENCY_CYCLE");
    expect(result.diagnostics[0]?.message).toContain("A -> B -> A");
  });

  it("never places a dependent task before its dependency", () => {
    const result = plan([
      task("A", declared("src/a/**")),
      task("B", declared("src/b/**"), { dependsOn: ["A"] }),
      task("C", declared("src/c/**")),
    ]);
    expect(waveOf(result, "B")).toBeGreaterThan(waveOf(result, "A"));
    expect(waveOf(result, "C")).toBe(0);
    expect(result.waves[1]?.reasons.B).toBe("depends_on: A");
  });

  it("honors max_concurrent and explains the overflow", () => {
    const result = plan(
      [
        task("a", declared("src/a/**")),
        task("b", declared("src/b/**")),
        task("c", declared("src/c/**")),
      ],
      { maxConcurrent: 2 },
    );
    expect(result.waves.map((wave) => wave.tasks)).toEqual([["a", "b"], ["c"]]);
    expect(result.waves[1]?.reasons.c).toContain("max_concurrent: 2");
  });

  it("isolates exclusive tasks", () => {
    const result = plan([
      task("a", declared("src/a/**"), { exclusive: true }),
      task("b", declared("src/b/**")),
    ]);
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0]?.reasons.a).toBe("exclusive");
  });

  it("isolates always-serial paths", () => {
    const result = plan([
      task("lock", declared("pnpm-lock.yaml")),
      task("code", declared("src/code.ts")),
    ]);
    expect(result.waves).toHaveLength(2);
    const lockWave = result.waves.find((wave) => wave.tasks.includes("lock"));
    expect(lockWave?.reasons.lock).toBe("always_serial: pnpm-lock.yaml");
  });

  it("isolates a directory footprint covering an always-serial path", () => {
    const result = plan([
      task("docs", declared("docs")),
      task("code", declared("src/code.ts")),
    ]);
    const docsWave = result.waves.find((wave) => wave.tasks.includes("docs"));
    expect(docsWave?.reasons.docs).toBe("always_serial: docs/requirements.md");
  });

  it("reports disabled planning instead of returning a silent empty plan", () => {
    const result = plan([task("a", declared("src/a/**"))], {
      enabled: false,
    });
    expect(result.waves).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("PARALLEL_DISABLED");
    expect(result.diagnostics[0]?.severity).toBe("warn");
  });

  it("packs unknown footprints when --allow-unknown is explicit", () => {
    const result = plan(
      [
        task("a", declared("src/a/**")),
        task("unknown", { raw: [], kind: "unknown" }),
      ],
      { allowUnknown: true },
    );
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]?.tasks).toEqual(["a", "unknown"]);
  });

  it("sorts by priority before creation time and ref", () => {
    const result = plan([
      task("low", declared("src/low/**"), {
        priority: "P2",
        createdAt: "2026-01-01",
      }),
      task("high", declared("src/high/**"), {
        priority: "P0",
        createdAt: "2026-02-01",
      }),
    ]);
    expect(result.waves[0]?.tasks).toEqual(["high", "low"]);
  });

  it("does not pack across dependency levels even when footprints are disjoint", () => {
    const result = plan([
      task("a", declared("src/a/**")),
      task("b", declared("src/b/**"), {
        dependsOn: ["a"],
        priority: "P0",
      }),
    ]);
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0]?.tasks).toEqual(["a"]);
    expect(result.waves[1]?.tasks).toEqual(["b"]);
  });

  it("reports a no-tasks diagnostic", () => {
    const result = plan([]);
    expect(result.waves).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("PARALLEL_NO_TASKS");
  });

  it("adds a serial-only diagnostic when every wave is a singleton", () => {
    const result = plan([
      task("a", declared("src/shared/**")),
      task("b", declared("src/shared/**")),
    ]);
    expect(
      result.diagnostics.some((item) => item.code === "PARALLEL_SERIAL_ONLY"),
    ).toBe(true);
  });

  it("PLAN-05: a container task never enters a wave", () => {
    const result = plan([
      task(".phronia/tasks/parent", declared("src/all/**"), {
        container: true,
        childCount: 2,
        children: [".phronia/tasks/a", ".phronia/tasks/b"],
      }),
    ]);
    expect(result.waves).toEqual([]);
    const diagnostic = result.diagnostics.find(
      (item) => item.code === "PARALLEL_CONTAINER_TASK",
    );
    expect(diagnostic?.severity).toBe("info");
    expect(diagnostic?.details?.taskRef).toBe(".phronia/tasks/parent");
    expect(diagnostic?.details?.next).toEqual([
      "python3 ./.phronia/scripts/task.py start .phronia/tasks/a",
      "python3 ./.phronia/scripts/task.py start .phronia/tasks/b",
    ]);
  });

  it("PLAN-06: a parent/leaf mix plans only the leaf", () => {
    const result = plan([
      task(".phronia/tasks/parent", declared("src/all/**"), {
        container: true,
        childCount: 1,
        children: [".phronia/tasks/leaf"],
      }),
      task(".phronia/tasks/leaf", declared("src/leaf/**")),
    ]);
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]?.tasks).toEqual([".phronia/tasks/leaf"]);
    expect(
      result.diagnostics.some((item) => item.code === "PARALLEL_CONTAINER_TASK"),
    ).toBe(true);
  });

  it("PLAN-07: an explicit --refs container warns instead of scheduling", () => {
    const result = plan(
      [
        task(".phronia/tasks/parent", declared("src/all/**"), {
          container: true,
          childCount: 2,
          children: [".phronia/tasks/a", ".phronia/tasks/b"],
        }),
        task(".phronia/tasks/a", declared("src/a/**")),
      ],
      { requestedRefs: [".phronia/tasks/parent"] },
    );
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]?.tasks).toEqual([".phronia/tasks/a"]);
    const diagnostic = result.diagnostics.find(
      (item) => item.code === "PARALLEL_CONTAINER_TASK",
    );
    expect(diagnostic?.severity).toBe("warn");
    expect(diagnostic?.message).toContain("Start a child instead");
  });

  it("PLAN-S1: spec is no longer always-serial", () => {
    const result = plan([
      task("spec", declared(".phronia/spec/**")),
      task("code", declared("src/code.ts")),
    ]);

    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]?.tasks).toEqual(["code", "spec"]);
    expect(
      result.diagnostics.some((item) => item.code === "SPEC_IS_POST_INTEGRATION"),
    ).toBe(true);
  });

  it("PLAN-S2: a spec footprint warns but does not force a singleton", () => {
    const result = plan([
      task("a", declared(".phronia/spec/cli/backend/a.md")),
      task("b", declared("src/b.ts")),
    ]);

    expect(result.waves).toHaveLength(1);
    const diagnostic = result.diagnostics.find(
      (item) => item.code === "SPEC_IS_POST_INTEGRATION",
    );
    expect(diagnostic?.severity).toBe("warn");
    expect(diagnostic?.details?.taskRef).toBe("a");
    expect(diagnostic?.details?.next).toEqual([
      "write the intent to spec-delta.md",
      "remove .phronia/spec/** from meta.parallel.touches",
    ]);
  });

  it("PLAN-S3: a spec-only task is excluded from waves with an info diagnostic", () => {
    const result = plan([
      task(".phronia/tasks/spec", declared(".phronia/spec/a.md"), {
        kind: "spec",
      }),
      task(".phronia/tasks/code", declared("src/code.ts")),
    ]);

    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]?.tasks).toEqual([".phronia/tasks/code"]);
    const diagnostic = result.diagnostics.find(
      (item) => item.code === "PARALLEL_SPEC_ONLY",
    );
    expect(diagnostic?.severity).toBe("info");
    expect(diagnostic?.details?.taskRef).toBe(".phronia/tasks/spec");
    expect(
      result.diagnostics.some((item) => item.code === "SPEC_IS_POST_INTEGRATION"),
    ).toBe(false);
  });

  it("PLAN-S4: an all-spec-only plan reports the control-plane diagnostic", () => {
    const result = plan([
      task(".phronia/tasks/spec", declared(".phronia/spec/a.md"), {
        kind: "spec",
      }),
    ]);

    expect(result.waves).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "PARALLEL_SPEC_ONLY",
    ]);
  });
});
