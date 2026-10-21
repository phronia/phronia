import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAIN_WORKTREE_ID,
  SESSION_SCHEMA_VERSION,
  SessionStore,
} from "../../src/state/session/store.js";

describe("session store v2", () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-session-store-"));
    store = new SessionStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a namespaced v2 record and increments revisions", () => {
    const first = store.update(
      MAIN_WORKTREE_ID,
      "claude_a",
      () => base("claude_a"),
    );
    expect(first.session).toMatchObject({
      schemaVersion: SESSION_SCHEMA_VERSION,
      worktreeId: "main",
      revision: 1,
    });
    expect(
      fs.existsSync(path.join(root, ".phronia/.runtime/sessions/main/claude_a.json")),
    ).toBe(true);

    const second = store.update("main", "claude_a", (previous) => ({
      ...(previous ?? base("claude_a")),
      currentTask: ".phronia/tasks/01-01-one",
    }));
    expect(second.session?.revision).toBe(2);
    expect(second.session?.currentTask).toBe(".phronia/tasks/01-01-one");
  });

  it("reads a legacy flat v1 file and upgrades it on write", () => {
    const legacy = path.join(root, ".phronia/.runtime/sessions/claude_old.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({ platform: "claude", current_task: ".phronia/tasks/01-01-old" }),
    );
    const session = store.read("main", "claude_old");
    expect(session?.currentTask).toBe(".phronia/tasks/01-01-old");
    const updated = store.update("main", "claude_old", (previous) => ({
      ...(previous ?? base("claude_old")),
      currentTask: ".phronia/tasks/01-01-new",
    }));
    expect(updated.session?.currentTask).toBe(".phronia/tasks/01-01-new");
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("keeps worktrees isolated", () => {
    store.update("wt-a", "claude_a", () => base("claude_a"), {
      worktreePath: "/tmp/wt-a",
    });
    store.update("wt-b", "claude_a", () => base("claude_a"), {
      worktreePath: "/tmp/wt-b",
    });
    expect(store.read("wt-a", "claude_a")?.worktreePath).toBe("/tmp/wt-a");
    expect(store.read("wt-b", "claude_a")?.worktreePath).toBe("/tmp/wt-b");
  });

  it("repoints a task across sessions in one worktree", () => {
    store.update("main", "a", () => ({ ...base("a"), currentTask: "old" }));
    store.update("main", "b", () => ({ ...base("b"), currentTask: "old" }));
    store.update("main", "c", () => ({ ...base("c"), currentTask: "other" }));
    expect(store.repointTask("old", "new", "main")).toBe(2);
    expect(store.read("main", "c")?.currentTask).toBe("other");
  });

  it("gc removes stale taskless sessions and keeps active ones", () => {
    const old = new Date("2020-01-01T00:00:00Z");
    store.update("main", "stale", () => base("stale"), { now: old });
    store.update("main", "fresh", () => ({ ...base("fresh"), currentTask: "task" }));
    const report = store.gc({ ttlDays: 30, now: new Date("2026-01-01T00:00:00Z") });
    expect(report.removed).toEqual([".phronia/.runtime/sessions/main/stale.json"]);
    const remaining = store.list("main").map((session) => session.contextKey);
    expect(remaining).toContain("fresh");
    expect(remaining).not.toContain("stale");
  });

  it("gc dry-run reports without deleting", () => {
    store.update("main", "stale", () => base("stale"), {
      now: new Date("2020-01-01T00:00:00Z"),
    });
    const report = store.gc({
      ttlDays: 30,
      dryRun: true,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(report.removed).toHaveLength(1);
    expect(store.read("main", "stale")).not.toBeNull();
  });
});

function base(key: string) {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    contextKey: key,
    worktreeId: "main",
    worktreePath: null,
    repoRoot: "/repo",
    currentTask: null,
    currentRun: null,
    revision: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
  };
}
