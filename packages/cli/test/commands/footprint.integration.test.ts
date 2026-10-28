import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { emptyTaskRecord, writeTaskRecord } from "@phronia/core/task";

import { setTaskFootprint } from "../../src/services/footprint.js";

const roots: string[] = [];

function setup(): { root: string; taskDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "phronia-footprint-"));
  roots.push(root);
  const taskDir = path.join(root, ".phronia", "tasks", "10-28-a");
  writeTaskRecord({
    taskDir,
    cwd: root,
    record: emptyTaskRecord({
      id: "a",
      name: "a",
      title: "A",
      description: "test task",
      creator: "tester",
      assignee: "tester",
      createdAt: "2026-10-28",
      meta: { custom: "keep-me" },
    }),
  });
  return { root, taskDir };
}

function readTask(taskDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(taskDir, "task.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("setTaskFootprint", () => {
  it("writes meta.parallel.touches and preserves other fields", () => {
    const { root, taskDir } = setup();
    const result = setTaskFootprint({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-a",
      paths: ["packages/cli/src/commands/**", "packages/core/src/task/parallel/**"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.touches).toEqual([
      "packages/cli/src/commands/**",
      "packages/core/src/task/parallel/**",
    ]);

    const task = readTask(taskDir);
    const meta = task.meta as Record<string, unknown>;
    expect(meta.custom).toBe("keep-me");
    expect(meta.parallel).toMatchObject({
      touches: [
        "packages/cli/src/commands/**",
        "packages/core/src/task/parallel/**",
      ],
    });
    expect(task.title).toBe("A");
  });

  it("deduplicates paths and normalizes separators", () => {
    const { root, taskDir } = setup();
    const result = setTaskFootprint({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-a",
      paths: ["packages\\cli\\src\\**", "packages/cli/src/**"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.touches).toEqual(["packages/cli/src/**"]);
    const meta = readTask(taskDir).meta as Record<string, unknown>;
    expect(meta.parallel).toMatchObject({ touches: ["packages/cli/src/**"] });
  });

  it("clears the declared footprint", () => {
    const { root, taskDir } = setup();
    setTaskFootprint({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-a",
      paths: ["src/**"],
    });
    const result = setTaskFootprint({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-a",
      clear: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.touches).toEqual([]);
    const meta = readTask(taskDir).meta as Record<string, unknown>;
    expect(meta.parallel).toMatchObject({ touches: [] });
  });

  it("refuses an empty footprint without --clear", () => {
    const { root } = setup();
    const result = setTaskFootprint({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-a",
      paths: [],
    });
    expect(result).toMatchObject({ ok: false, code: "FOOTPRINT_EMPTY" });
  });

  it("refuses absolute and escaping paths", () => {
    const { root } = setup();
    const absolute = setTaskFootprint({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-a",
      paths: ["/tmp/outside/**"],
    });
    expect(absolute).toMatchObject({ ok: false, code: "FOOTPRINT_INVALID" });

    const escaping = setTaskFootprint({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-a",
      paths: ["../outside/**"],
    });
    expect(escaping).toMatchObject({ ok: false, code: "FOOTPRINT_INVALID" });
  });

  it("returns TASK_NOT_FOUND for an unknown ref", () => {
    const { root } = setup();
    const result = setTaskFootprint({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-missing",
      paths: ["src/**"],
    });
    expect(result).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
  });
});
