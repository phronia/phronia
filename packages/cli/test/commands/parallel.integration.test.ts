import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parallelStatus,
  planTasks,
} from "../../src/services/parallel.js";

describe("parallel plan/status integration (PLAN-01..04, WS-06)", () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("PLAN-01: three disjoint footprints share one wave", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });
    writeTask(root, "10-28-beta", { touches: ["src/b/**"] });
    writeTask(root, "10-28-gamma", { touches: ["src/c/**"] });

    const result = planTasks({ cwd: root });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]?.tasks).toHaveLength(3);
    for (const ref of result.waves[0]?.tasks ?? []) {
      expect(result.waves[0]?.reasons[ref]).toBe("independent");
    }
  });

  it("PLAN-02: overlapping footprints split into two waves with an explain reason", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/shared/**"] });
    writeTask(root, "10-28-beta", { touches: ["src/shared/**"] });

    const result = planTasks({ cwd: root, includePlanning: false });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toHaveLength(2);
    const reasons = Object.values(result.waves[1]?.reasons ?? {}).join(" ");
    expect(reasons).toContain("overlap: src/shared/**");
    expect(reasons).toMatch(/10-28-alpha|10-28-beta/);
  });

  it("PLAN-03: unknown footprint is a singleton wave and explains the fix", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });
    writeTask(root, "10-28-unknown", {});

    const result = planTasks({ cwd: root });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toHaveLength(2);
    const unknownWave = result.waves.find((wave) =>
      wave.tasks.includes(".phronia/tasks/10-28-unknown"),
    );
    expect(unknownWave?.tasks).toHaveLength(1);
    expect(unknownWave?.reasons[".phronia/tasks/10-28-unknown"]).toBe(
      "unknown_footprint",
    );
    expect(result.diagnostics.some((item) => item.code === "FOOTPRINT_UNKNOWN")).toBe(
      true,
    );
    expect(
      result.diagnostics.find((item) => item.code === "FOOTPRINT_UNKNOWN")?.message,
    ).toContain("phronia task footprint set");
  });

  it("PLAN-04: dependency cycle is rejected without a partial plan", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"], dependsOn: ["10-28-beta"] });
    writeTask(root, "10-28-beta", { touches: ["src/b/**"], dependsOn: ["10-28-alpha"] });

    const result = planTasks({ cwd: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DEPENDENCY_CYCLE");
    expect(result.message).toContain("10-28-alpha");
    expect(result.message).toContain("10-28-beta");
    expect(result.message).toContain("->");
  });

  it("reports PARALLEL_DISABLED instead of an empty plan", () => {
    fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      ["parallel:", "  enabled: false"].join("\n"),
    );
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });

    const result = planTasks({ cwd: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PARALLEL_DISABLED");
    expect(result.next).toContain("parallel.enabled");
  });

  it("excludes planning tasks by default and includes them with --include-planning", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"], status: "planning" });

    expect(planTasks({ cwd: root }).ok).toBe(true);
    const without = planTasks({ cwd: root });
    if (without.ok) expect(without.tasks).toHaveLength(0);

    const withPlanning = planTasks({ cwd: root, includePlanning: true });
    expect(withPlanning.ok).toBe(true);
    if (withPlanning.ok) {
      expect(withPlanning.tasks.map((task) => task.ref)).toEqual([
        ".phronia/tasks/10-28-alpha",
      ]);
    }
  });

  it("WS-06: status shows control-plane and branch-local tasks together", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan alpha"]);

    const worktree = path.join(root, ".phronia/worktrees/beta");
    git(root, ["worktree", "add", "-b", "phronia/10-28-beta", worktree, "main"]);
    const localTask = path.join(worktree, ".phronia/tasks/10-28-beta");
    fs.mkdirSync(localTask, { recursive: true });
    fs.writeFileSync(
      path.join(localTask, "task.json"),
      JSON.stringify({
        id: "10-28-beta",
        title: "Beta local",
        status: "in_progress",
        meta: { parallel: { touches: ["src/b/**"] } },
      }),
    );

    const shared = path.join(root, ".git/phronia");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(
      path.join(shared, "worktrees.json"),
      JSON.stringify({
        schemaVersion: 1,
        worktrees: [
          {
            taskRef: ".phronia/tasks/10-28-beta",
            path: worktree,
            branch: "phronia/10-28-beta",
            kind: "phronia",
            createdAt: "2026-10-28T00:00:00Z",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(shared, "tasks.index.json"),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            taskRef: ".phronia/tasks/10-28-beta",
            title: "Beta local",
            status: "in_progress",
            priority: "P2",
            footprint: ["src/b/**"],
            dependsOn: [],
            owner: { type: "subagent", id: "agent-1" },
            workspace: worktree,
            updatedAt: "2026-10-28T00:00:00Z",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(shared, "integration.json"),
      JSON.stringify({
        schemaVersion: 1,
        queue: [
          {
            taskRef: ".phronia/tasks/10-28-beta",
            enqueuedAt: "2026-10-28T00:00:00Z",
            mode: "local",
          },
        ],
      }),
    );

    const result = parallelStatus({ cwd: root });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const alpha = result.tasks.find(
      (task) => task.ref === ".phronia/tasks/10-28-alpha",
    );
    const beta = result.tasks.find(
      (task) => task.ref === ".phronia/tasks/10-28-beta",
    );
    expect(alpha?.scope).toBe("control-plane");
    expect(beta?.scope).toBe("branch-local");
    expect(beta?.workspace).toBe(worktree);
    expect(beta?.owner).toContain("agent-1");
    expect(beta?.queuePosition).toBe(0);
    expect(result.runtime.sharedRoot).toBe(fs.realpathSync(shared));
    expect(result.runtime.fallback).toBe(false);
  });
});

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-parallel-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".phronia/.gitignore"),
    ["worktrees/", ".runtime/"].join("\n"),
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function writeTask(
  root: string,
  id: string,
  options: {
    touches?: readonly string[];
    dependsOn?: readonly string[];
    status?: string;
    exclusive?: boolean;
  },
): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id,
      title: `Task ${id}`,
      status: options.status ?? "in_progress",
      priority: "P2",
      meta: {
        parallel: {
          ...(options.touches === undefined ? {} : { touches: options.touches }),
          ...(options.dependsOn === undefined
            ? {}
            : { depends_on: options.dependsOn }),
          ...(options.exclusive === true ? { exclusive: true } : {}),
        },
      },
    }),
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
