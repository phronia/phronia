import { describe, expect, it } from "vitest";

import {
  acquireLease,
  aggregateBatchStatus,
  classifyBatchState,
  heartbeatLease,
  isLeaseExpired,
  leaseRemainingSeconds,
  mergeIndexEntries,
  normalizeIndexEntry,
  normalizeIndexFile,
  tryNormalizeIndexEntry,
} from "../../src/task/index-policy.js";
import type {
  TaskIndexEntry,
  TaskLease,
} from "../../src/task/index-types.js";

const NOW = "2026-10-28T12:00:00.000Z";
const LIVE_NOW = "2026-10-28T10:30:00.000Z";

function entry(overrides: Partial<TaskIndexEntry> = {}): TaskIndexEntry {
  return {
    taskRef: ".phronia/tasks/a",
    title: "A",
    status: "in_progress",
    priority: "P2",
    footprint: ["src/a/**"],
    dependsOn: [],
    owner: null,
    workspace: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function lease(overrides: Partial<TaskLease> = {}): TaskLease {
  return {
    taskRef: ".phronia/tasks/a",
    ownerType: "subagent",
    ownerId: "agent-1",
    workspace: "/repo/.phronia/worktrees/a",
    acquiredAt: "2026-10-28T10:00:00.000Z",
    heartbeatAt: "2026-10-28T10:00:00.000Z",
    ttlSeconds: 3600,
    ...overrides,
  };
}

describe("normalizeIndexEntry", () => {
  it("fills optional fields with safe defaults", () => {
    const normalized = normalizeIndexEntry({
      taskRef: ".phronia/tasks/a",
      title: "A",
      status: "in_progress",
      priority: "P1",
      updatedAt: NOW,
    });
    expect(normalized).toEqual({
      taskRef: ".phronia/tasks/a",
      title: "A",
      status: "in_progress",
      priority: "P1",
      footprint: [],
      dependsOn: [],
      owner: null,
      workspace: null,
      updatedAt: NOW,
    });
  });

  it("keeps provided owner, workspace, and arrays", () => {
    const normalized = normalizeIndexEntry({
      ...entry(),
      owner: { type: "subagent", id: "agent-3", sessionKey: "zcode:abc" },
      workspace: "/repo/.phronia/worktrees/a",
      footprint: ["src/a/**", "src/shared/**"],
      dependsOn: [".phronia/tasks/b"],
    });
    expect(normalized.owner).toEqual({
      type: "subagent",
      id: "agent-3",
      sessionKey: "zcode:abc",
    });
    expect(normalized.footprint).toEqual(["src/a/**", "src/shared/**"]);
    expect(normalized.dependsOn).toEqual([".phronia/tasks/b"]);
  });

  it("rejects entries without required fields", () => {
    expect(() =>
      normalizeIndexEntry({
        taskRef: ".phronia/tasks/a",
        title: "A",
        status: "in_progress",
      }),
    ).toThrow(/priority is required/);

    const result = tryNormalizeIndexEntry({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("TASK_INDEX_INVALID");
  });

  it("rejects invalid owner types", () => {
    expect(() =>
      normalizeIndexEntry({
        ...entry(),
        owner: { type: "robot", id: "x" },
      }),
    ).toThrow(/owner.type/);
  });

  it("rejects non-array footprint values", () => {
    expect(() =>
      normalizeIndexEntry({ ...entry(), footprint: "src/a/**" }),
    ).toThrow(/footprint must be an array of strings/);
  });
});

describe("normalizeIndexFile / mergeIndexEntries", () => {
  it("deduplicates and sorts entries by task ref", () => {
    const entries = normalizeIndexFile({
      schemaVersion: 1,
      tasks: [
        entry({ taskRef: ".phronia/tasks/c" }),
        entry({ taskRef: ".phronia/tasks/a" }),
        entry({ taskRef: ".phronia/tasks/c", title: "C updated" }),
      ],
    });
    expect(entries.map((item) => item.taskRef)).toEqual([
      ".phronia/tasks/a",
      ".phronia/tasks/c",
    ]);
    expect(entries[1]?.title).toBe("C updated");
  });

  it("lets incoming entries replace existing ones and sorts the result", () => {
    const existing = [
      entry({ taskRef: ".phronia/tasks/b", title: "old b" }),
      entry({ taskRef: ".phronia/tasks/a" }),
    ];
    const incoming = [
      entry({ taskRef: ".phronia/tasks/b", title: "new b" }),
      entry({ taskRef: ".phronia/tasks/c" }),
    ];
    const merged = mergeIndexEntries(existing, incoming);
    expect(merged.map((item) => item.taskRef)).toEqual([
      ".phronia/tasks/a",
      ".phronia/tasks/b",
      ".phronia/tasks/c",
    ]);
    expect(merged[1]?.title).toBe("new b");
  });
});

describe("lease expiry", () => {
  it("treats a lease as live until heartbeat + ttl is strictly in the past", () => {
    const active = lease();
    expect(isLeaseExpired(active, "2026-10-28T10:59:59.000Z")).toBe(false);
    expect(isLeaseExpired(active, "2026-10-28T11:00:00.000Z")).toBe(false);
    expect(isLeaseExpired(active, "2026-10-28T11:00:01.000Z")).toBe(true);
  });

  it("reports remaining seconds and zero once expired", () => {
    const active = lease();
    expect(leaseRemainingSeconds(active, "2026-10-28T10:30:00.000Z")).toBe(
      1800,
    );
    expect(leaseRemainingSeconds(active, "2026-10-28T12:00:00.000Z")).toBe(0);
  });

  it("treats malformed heartbeat timestamps as expired", () => {
    expect(
      isLeaseExpired(lease({ heartbeatAt: "not-a-date" }), NOW),
    ).toBe(true);
  });
});

describe("acquireLease", () => {
  it("acquires a free lease", () => {
    const result = acquireLease(
      null,
      {
        taskRef: ".phronia/tasks/a",
        ownerType: "subagent",
        ownerId: "agent-1",
        workspace: "/repo/.phronia/worktrees/a",
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease).toEqual({
      taskRef: ".phronia/tasks/a",
      ownerType: "subagent",
      ownerId: "agent-1",
      sessionKey: undefined,
      workspace: "/repo/.phronia/worktrees/a",
      acquiredAt: NOW,
      heartbeatAt: NOW,
      ttlSeconds: 3600,
    });
  });

  it("rejects a second owner while the lease is live", () => {
    const result = acquireLease(
      lease(),
      {
        taskRef: ".phronia/tasks/a",
        ownerType: "subagent",
        ownerId: "agent-2",
        workspace: "/repo/.phronia/worktrees/a",
      },
      LIVE_NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LEASE_BUSY");
    expect(result.owner.ownerId).toBe("agent-1");
    expect(result.diagnostics[0]?.code).toBe("LEASE_BUSY");
  });

  it("LEASE-01: exactly one of two simultaneous claims succeeds", () => {
    const first = acquireLease(
      null,
      {
        taskRef: ".phronia/tasks/a",
        ownerType: "subagent",
        ownerId: "agent-1",
        workspace: "/repo/.phronia/worktrees/a",
      },
      LIVE_NOW,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = acquireLease(
      first.lease,
      {
        taskRef: ".phronia/tasks/a",
        ownerType: "subagent",
        ownerId: "agent-2",
        workspace: "/repo/.phronia/worktrees/a",
      },
      LIVE_NOW,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("LEASE_BUSY");
    expect(second.owner.ownerId).toBe("agent-1");
    expect(second.owner.workspace).toBe("/repo/.phronia/worktrees/a");
  });

  it("is idempotent for the same owner and refreshes the heartbeat", () => {
    const result = acquireLease(
      lease(),
      {
        taskRef: ".phronia/tasks/a",
        ownerType: "subagent",
        ownerId: "agent-1",
        workspace: "/repo/.phronia/worktrees/a",
      },
      LIVE_NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.acquiredAt).toBe("2026-10-28T10:00:00.000Z");
    expect(result.lease.heartbeatAt).toBe(LIVE_NOW);
  });

  it("allows an expired lease to be reclaimed by a new owner", () => {
    const expired = lease({ heartbeatAt: "2026-10-28T09:00:00.000Z" });
    const result = acquireLease(
      expired,
      {
        taskRef: ".phronia/tasks/a",
        ownerType: "session",
        ownerId: "session-2",
        workspace: "/repo/.phronia/worktrees/a",
        ttlSeconds: 60,
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.ownerId).toBe("session-2");
    expect(result.lease.acquiredAt).toBe(NOW);
    expect(result.lease.ttlSeconds).toBe(60);
  });

  it("falls back to the default TTL for invalid values", () => {
    const result = acquireLease(
      null,
      {
        taskRef: ".phronia/tasks/a",
        ownerType: "task",
        ownerId: "task-a",
        workspace: "/repo",
        ttlSeconds: 0,
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.ttlSeconds).toBe(3600);
  });

  it("refreshes a lease with heartbeatLease", () => {
    const refreshed = heartbeatLease(lease(), NOW);
    expect(refreshed.heartbeatAt).toBe(NOW);
    expect(refreshed.acquiredAt).toBe("2026-10-28T10:00:00.000Z");
  });
});

describe("batch status aggregation", () => {
  it("classifies outcomes before task status", () => {
    expect(
      classifyBatchState({ taskRef: "a", status: "in_progress", outcome: "landed" }),
    ).toBe("landed");
    expect(
      classifyBatchState({
        taskRef: "a",
        status: "in_progress",
        outcome: "needs_human",
      }),
    ).toBe("needs_human");
    expect(
      classifyBatchState({ taskRef: "a", status: "in_progress", outcome: "blocked" }),
    ).toBe("blocked");
    expect(
      classifyBatchState({ taskRef: "a", status: "in_progress", outcome: "pushed" }),
    ).toBe("queued");
  });

  it("derives a state from task status when no outcome exists", () => {
    expect(classifyBatchState({ taskRef: "a", status: "completed" })).toBe(
      "landed",
    );
    expect(classifyBatchState({ taskRef: "a", status: "in_progress" })).toBe(
      "running",
    );
    expect(classifyBatchState({ taskRef: "a", status: "blocked" })).toBe(
      "blocked",
    );
    expect(classifyBatchState({ taskRef: "a", status: "planning" })).toBe(
      "queued",
    );
    expect(
      classifyBatchState({ taskRef: "a", status: "planning", state: "running" }),
    ).toBe("running");
  });

  it("counts tasks by state and keeps blocked tasks from stopping the batch", () => {
    const summary = aggregateBatchStatus([
      { taskRef: "a", status: "in_progress", outcome: "blocked" },
      { taskRef: "b", status: "in_progress" },
      { taskRef: "c", status: "completed", outcome: "landed" },
      { taskRef: "d", status: "planning" },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.byState).toEqual({
      queued: 1,
      running: 1,
      blocked: 1,
      landed: 1,
      needs_human: 0,
    });
    expect(summary.blocked).toEqual(["a"]);
    expect(summary.running).toEqual(["b"]);
    expect(summary.queued).toEqual(["d"]);
    expect(summary.landed).toEqual(["c"]);
    expect(summary.done).toBe(false);
  });

  it("is done when nothing is queued or running even with blocked tasks", () => {
    const summary = aggregateBatchStatus([
      { taskRef: "a", status: "blocked" },
      { taskRef: "b", status: "completed" },
      { taskRef: "c", status: "completed", outcome: "needs_human" },
    ]);
    expect(summary.byState).toEqual({
      queued: 0,
      running: 0,
      blocked: 1,
      landed: 1,
      needs_human: 1,
    });
    expect(summary.needsHuman).toEqual(["c"]);
    expect(summary.done).toBe(true);
  });

  it("is not done for an empty batch", () => {
    const summary = aggregateBatchStatus([]);
    expect(summary.total).toBe(0);
    expect(summary.done).toBe(false);
  });
});
