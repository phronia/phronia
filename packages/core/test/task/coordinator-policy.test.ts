import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../../src/platform/capabilities.js";
import {
  buildDispatchManifest,
  buildPromptPrefix,
  canRunCoordinator,
  classifyBatchState,
  coordinatorState,
  nextWave,
} from "../../src/task/coordinator/policy.js";
import type {
  Batch,
  BatchTask,
} from "../../src/task/coordinator/types.js";
import type { TaskLease } from "../../src/task/index-types.js";

const batch: Batch = {
  id: "b1",
  wave: 1,
  tasks: [".phronia/tasks/a", ".phronia/tasks/b"],
  maxConcurrent: 2,
};

const tasks: BatchTask[] = [
  {
    taskRef: ".phronia/tasks/a",
    footprint: ["src/a/**"],
    dependsOn: [],
    status: "in_progress",
    priority: "P1",
  },
  {
    taskRef: ".phronia/tasks/b",
    footprint: ["src/b/**"],
    dependsOn: [".phronia/tasks/a"],
    status: "in_progress",
    priority: "P2",
  },
];

describe("coordinator capability gate (R22, COORD-01/03)", () => {
  it("allows Claude Code (nested + per-task)", () => {
    expect(canRunCoordinator(CAPABILITIES["claude-code"])).toEqual({
      available: true,
      reason: null,
      fallback: null,
    });
  });

  it("degrades Codex and ZCode to multi-session", () => {
    for (const platform of ["codex", "zcode"] as const) {
      const gate = canRunCoordinator(CAPABILITIES[platform]);
      expect(gate.available).toBe(false);
      expect(gate.fallback).toBe("multi-session");
      expect(gate.reason).toContain("subagentWorkspace: inherited");
    }
  });

  it("degrades a platform without a sub-agent surface to serial", () => {
    const gate = canRunCoordinator(CAPABILITIES.kilo);
    expect(gate.available).toBe(false);
    expect(gate.fallback).toBe("serial");
    expect(gate.reason).toContain("subagentExecution: none");
  });

  it("treats unknown capabilities as unsupported", () => {
    const gate = canRunCoordinator(CAPABILITIES.cursor);
    expect(gate.available).toBe(false);
    expect(gate.fallback).toBe("multi-session");
    expect(gate.reason).toContain("unknown");
  });
});

describe("dispatch manifest shaping (R21, COORD-01)", () => {
  const leases: TaskLease[] = [
    lease(".phronia/tasks/a", "agent-1"),
    lease(".phronia/tasks/b", "agent-2"),
  ];
  const workspaces = [
    { taskRef: ".phronia/tasks/a", path: "/repo/.phronia/worktrees/a", branch: "phronia/a" },
    { taskRef: ".phronia/tasks/b", path: "/repo/.phronia/worktrees/b", branch: "phronia/b" },
  ];

  it("emits taskRef/workspace/branch/lease/dependsOn/promptPrefix", () => {
    const manifest = buildDispatchManifest(batch, tasks, leases, workspaces);
    expect(manifest.batch).toBe("b1");
    expect(manifest.wave).toBe(1);
    expect(manifest.tasks).toHaveLength(2);
    expect(manifest.tasks[1]).toMatchObject({
      taskRef: ".phronia/tasks/b",
      workspace: "/repo/.phronia/worktrees/b",
      branch: "phronia/b",
      lease: "subagent:agent-2",
      dependsOn: [".phronia/tasks/a"],
    });
    expect(manifest.tasks[0]?.promptPrefix).toBe(
      buildPromptPrefix(".phronia/tasks/a", "/repo/.phronia/worktrees/a"),
    );
    expect(manifest.tasks[0]?.promptPrefix.split("\n")[0]).toBe(
      "Active task: .phronia/tasks/a",
    );
    expect(manifest.tasks[0]?.promptPrefix).toContain("Commit your changes");
  });

  it("is deterministic for stable input (manifest hash is stable)", () => {
    expect(JSON.stringify(buildDispatchManifest(batch, tasks, leases, workspaces))).toBe(
      JSON.stringify(buildDispatchManifest(batch, tasks, leases, workspaces)),
    );
  });

  it("omits tasks with no workspace or lease instead of inventing one", () => {
    const manifest = buildDispatchManifest(
      batch,
      tasks,
      leases.slice(0, 1),
      workspaces.slice(0, 1),
    );
    expect(manifest.tasks.map((task) => task.taskRef)).toEqual([
      ".phronia/tasks/a",
    ]);
  });
});

describe("mid-batch scheduling (R24, COORD-02)", () => {
  const running: BatchTask[] = [
    {
      taskRef: ".phronia/tasks/a",
      footprint: ["src/a/**"],
      dependsOn: [],
      status: "in_progress",
      priority: "P1",
    },
  ];

  it("lets a non-overlapping task join the open wave", () => {
    const assignment = nextWave({
      running,
      openWave: running,
      maxConcurrent: 3,
      newTasks: [task(".phronia/tasks/c", ["src/c/**"])],
    });
    expect(assignment.join).toEqual([".phronia/tasks/c"]);
    expect(assignment.next).toEqual([]);
    expect(assignment.reasons[".phronia/tasks/c"]).toBe("independent");
  });

  it("makes an overlapping task wait for a later wave", () => {
    const assignment = nextWave({
      running,
      openWave: running,
      maxConcurrent: 3,
      newTasks: [task(".phronia/tasks/overlap", ["src/a/shared.ts"])],
    });
    expect(assignment.join).toEqual([]);
    expect(assignment.next).toEqual([".phronia/tasks/overlap"]);
    expect(assignment.reasons[".phronia/tasks/overlap"]).toContain("overlap:");
    expect(assignment.reasons[".phronia/tasks/overlap"]).toContain(
      ".phronia/tasks/a",
    );
  });

  it("treats an unknown footprint as overlapping", () => {
    const assignment = nextWave({
      running,
      openWave: running,
      maxConcurrent: 3,
      newTasks: [task(".phronia/tasks/unknown", [])],
    });
    expect(assignment.next).toEqual([".phronia/tasks/unknown"]);
    expect(assignment.reasons[".phronia/tasks/unknown"]).toContain(
      "unknown_footprint",
    );
  });

  it("never exceeds maxConcurrent", () => {
    const assignment = nextWave({
      running,
      openWave: running,
      maxConcurrent: 1,
      newTasks: [task(".phronia/tasks/c", ["src/c/**"])],
    });
    expect(assignment.join).toEqual([]);
    expect(assignment.next).toEqual([".phronia/tasks/c"]);
    expect(assignment.reasons[".phronia/tasks/c"]).toBe("max_concurrent: 1");
  });
});

describe("batch state aggregation (R24, COORD-04)", () => {
  it("a blocked task does not stop the others", () => {
    const summary = classifyBatchState([
      { taskRef: "a", status: "in_progress" },
      { taskRef: "b", status: "blocked" },
      { taskRef: "c", status: "in_progress" },
    ]);
    expect(summary.blocked).toEqual(["b"]);
    expect(summary.running).toEqual(["a", "c"]);
    expect(summary.done).toBe(false);
  });

  it("uses integration outcomes and reports done once nothing is queued/running", () => {
    const summary = classifyBatchState([
      { taskRef: "a", status: "completed", outcome: "landed" },
      { taskRef: "b", status: "blocked", outcome: "needs_human" },
    ]);
    expect(summary.landed).toEqual(["a"]);
    expect(summary.needsHuman).toEqual(["b"]);
    expect(summary.done).toBe(true);

    const state = coordinatorState(batch, [
      { taskRef: "a", status: "completed", outcome: "landed" },
    ]);
    expect(state.mode).toBe("coordinator");
    expect(state.next).toBe("phronia task integrate --drain");
  });
});

function task(taskRef: string, footprint: readonly string[]): BatchTask {
  return {
    taskRef,
    footprint,
    dependsOn: [],
    status: "in_progress",
    priority: "P2",
  };
}

function lease(taskRef: string, ownerId: string): TaskLease {
  return {
    taskRef,
    ownerType: "subagent",
    ownerId,
    workspace: `/repo/.phronia/worktrees/${ownerId}`,
    acquiredAt: "2026-10-28T00:00:00.000Z",
    heartbeatAt: "2026-10-28T00:00:00.000Z",
    ttlSeconds: 3600,
  };
}
