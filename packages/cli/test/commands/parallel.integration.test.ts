import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  launchPlan,
  parallelStatus,
  planTasks,
} from "../../src/services/parallel.js";
import { runParallelStatus } from "../../src/commands/parallel.js";

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

  it("S3: a parent container is excluded from waves and lists child start commands", () => {
    writeTask(root, "10-28-parent", {
      touches: ["src/all/**"],
      children: ["10-28-alpha", "10-28-beta"],
    });
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"], status: "planning" });
    writeTask(root, "10-28-beta", { touches: ["src/b/**"], status: "planning" });

    const result = planTasks({ cwd: root, includePlanning: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.waves.flatMap((wave) => wave.tasks)).not.toContain(
      ".phronia/tasks/10-28-parent",
    );
    const container = result.diagnostics.find(
      (item) => item.code === "PARALLEL_CONTAINER_TASK",
    );
    expect(container?.severity).toBe("info");
    expect(container?.details?.next).toEqual([
      "python3 ./.phronia/scripts/task.py start .phronia/tasks/10-28-alpha",
      "python3 ./.phronia/scripts/task.py start .phronia/tasks/10-28-beta",
    ]);
    const planning = result.diagnostics.find(
      (item) => item.code === "PARENT_HAS_PLANNING_CHILDREN",
    );
    expect(planning?.severity).toBe("warn");
    expect(planning?.message).toContain("2 planning children");
    expect(planning?.details?.next).toEqual([
      "python3 ./.phronia/scripts/task.py start .phronia/tasks/10-28-alpha",
      "python3 ./.phronia/scripts/task.py start .phronia/tasks/10-28-beta",
    ]);
  });

  it("S3: explicit --refs on a parent warns instead of scheduling it", () => {
    writeTask(root, "10-28-parent", {
      touches: ["src/all/**"],
      children: ["10-28-alpha"],
    });
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });

    const result = planTasks({ cwd: root, refs: [".phronia/tasks/10-28-parent"] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toEqual([]);
    const container = result.diagnostics.find(
      (item) => item.code === "PARALLEL_CONTAINER_TASK",
    );
    expect(container?.severity).toBe("warn");
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

  it("R10: projects spec sync state per task and in the summary", () => {
    writeTask(root, "10-29-pending", { touches: ["src/p/**"] });
    writeSpecDelta(root, "10-29-pending");
    writeTask(root, "10-29-synced", { touches: ["src/s/**"] });
    writeSpecDelta(root, "10-29-synced");
    setSpecSync(root, "10-29-synced", "synced");
    writeTask(root, "10-29-failed", { touches: ["src/f/**"] });
    writeSpecDelta(root, "10-29-failed");
    setSpecSync(root, "10-29-failed", "failed");
    writeTask(root, "10-29-none", { touches: ["src/n/**"] });

    const result = parallelStatus({ cwd: root });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const byRef = new Map(result.tasks.map((task) => [task.ref, task]));
    expect(byRef.get(".phronia/tasks/10-29-pending")?.specSync).toBe("pending");
    expect(byRef.get(".phronia/tasks/10-29-synced")?.specSync).toBe("synced");
    expect(byRef.get(".phronia/tasks/10-29-failed")?.specSync).toBe("failed");
    expect(byRef.get(".phronia/tasks/10-29-none")?.specSync).toBe("none");
    expect(result.specSync.pending).toContain(".phronia/tasks/10-29-pending");
    expect(result.specSync.pending).toContain(".phronia/tasks/10-29-failed");
    expect(result.specSync.pending).not.toContain(".phronia/tasks/10-29-synced");
    expect(result.specSync.failed).toEqual([".phronia/tasks/10-29-failed"]);

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      expect(runParallelStatus({ cwd: root, json: true })).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const payload = JSON.parse(writes.join("")) as {
      tasks: { ref: string; specSync: string }[];
      specSync: { pending: string[]; failed: string[] };
    };
    expect(payload.specSync.pending).toContain(".phronia/tasks/10-29-pending");
    expect(
      payload.tasks.find((task) => task.ref === ".phronia/tasks/10-29-synced")
        ?.specSync,
    ).toBe("synced");
  });
});

describe("parallel launch (multi-session manifest, design.md §8)", () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is read-only without --prepare and lists prepare/lease commands", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });
    writeTask(root, "10-28-beta", { touches: ["src/b/**"] });
    const before = worktreeListing(root);

    const result = launchPlan({ cwd: root });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.wave).toBe(1);
    expect(result.prepare).toBe(false);
    expect(result.tasks.map((task) => task.taskRef)).toEqual([
      ".phronia/tasks/10-28-alpha",
      ".phronia/tasks/10-28-beta",
    ]);
    for (const task of result.tasks) {
      expect(task.workspace).toBeNull();
      expect(task.branch).toBeNull();
      expect(task.activeTaskLine).toBe(`Active task: ${task.taskRef}`);
      expect(task.prepareCommand).toBe(
        `phronia task workspace ensure ${task.taskRef}`,
      );
      expect(task.leaseCommand).toBe(
        `phronia task lease acquire ${task.taskRef}`,
      );
      expect(task.next).toBe(task.prepareCommand);
      expect(task.openInstructions).toContain(
        "Open a new session/window in the workspace printed by",
      );
    }

    // No process, worktree, or session was created.
    expect(worktreeListing(root)).toBe(before);
    expect(fs.existsSync(path.join(root, ".phronia/worktrees"))).toBe(false);
  });

  it("creates and then attaches workspaces with --prepare", () => {
    writeTask(root, "10-28-alpha", {
      touches: ["src/a/**"],
      exclusive: true,
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan alpha"]);

    const prepared = launchPlan({
      cwd: root,
      prepare: true,
      sessionKey: "main-session",
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    const created = prepared.tasks[0];
    expect(created).toBeDefined();
    if (created === undefined) return;
    expect(created.workspace).toContain(path.join(".phronia", "worktrees"));
    expect(fs.existsSync(created.workspace as string)).toBe(true);
    expect(created.branch).toMatch(/^phronia\//);
    expect(created.next).toBeNull();
    expect(worktreeListing(root)).toContain(created.workspace as string);

    const attached = launchPlan({
      cwd: root,
      prepare: true,
      sessionKey: "main-session",
    });
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    if (!attached.ok) return;
    expect(attached.tasks[0]?.workspace).toBe(created.workspace);
    expect(attached.tasks[0]?.branch).toBe(created.branch);
    // Attach reuses the same worktree; it does not create a second one.
    expect(worktreeListing(root).match(/\.phronia\/worktrees\//g)?.length).toBe(1);
  });

  it("skips containers and spec-only tasks with reasons", () => {
    writeTask(root, "10-28-parent", {
      touches: ["src/all/**"],
      children: [".phronia/tasks/10-28-alpha"],
    });
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });
    writeTask(root, "10-28-spec", { touches: ["docs/**"], kind: "spec" });

    const result = launchPlan({
      cwd: root,
      refs: [
        ".phronia/tasks/10-28-parent",
        ".phronia/tasks/10-28-alpha",
        ".phronia/tasks/10-28-spec",
      ],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.wave).toBeNull();
    expect(result.tasks.map((task) => task.taskRef)).toEqual([
      ".phronia/tasks/10-28-alpha",
    ]);
    const skipped = new Map(result.skipped.map((item) => [item.taskRef, item]));
    expect(skipped.get(".phronia/tasks/10-28-parent")?.code).toBe(
      "PARALLEL_CONTAINER_TASK",
    );
    expect(skipped.get(".phronia/tasks/10-28-parent")?.message).toContain(
      "coordinator only",
    );
    expect(skipped.get(".phronia/tasks/10-28-spec")?.code).toBe(
      "PARALLEL_SPEC_ONLY",
    );
    expect(skipped.get(".phronia/tasks/10-28-spec")?.message).toContain(
      "control plane",
    );
  });

  it("emits platform-specific open instructions", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });
    const refs = [".phronia/tasks/10-28-alpha"];

    const zcode = launchPlan({ cwd: root, refs, platform: "zcode" });
    const claude = launchPlan({ cwd: root, refs, platform: "claude-code" });
    const generic = launchPlan({ cwd: root, refs });
    expect(zcode.ok && claude.ok && generic.ok).toBe(true);
    if (!zcode.ok || !claude.ok || !generic.ok) return;

    expect(zcode.platform).toBe("zcode");
    expect(zcode.tasks[0]?.openInstructions).toContain(
      "Open a new ZCode/Codex window with working directory",
    );
    expect(zcode.tasks[0]?.openInstructions).toContain(
      "Mutating sub-agents inherit this session's cwd",
    );
    expect(claude.platform).toBe("claude-code");
    expect(claude.tasks[0]?.openInstructions).toContain(
      "Open a separate Claude Code session",
    );
    expect(claude.tasks[0]?.openInstructions).toContain(
      "per-task workspace capability exists",
    );
    expect(generic.platform).toBeNull();
    expect(generic.tasks[0]?.openInstructions).toContain(
      "Open a new session/window",
    );
  });

  it("does not present the base branch as a launch branch", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"], branch: "main" });

    const result = launchPlan({ cwd: root, refs: [".phronia/tasks/10-28-alpha"] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const task = result.tasks[0];
    expect(task?.branch).toBeNull();
    expect(task?.prepareCommand).toBe(
      "phronia task workspace ensure .phronia/tasks/10-28-alpha",
    );
  });

  it("reports missing build inputs per launched task", () => {
    writeTask(root, "10-28-alpha", {
      touches: ["src/a/**"],
      exclusive: true,
    });
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(root, "node_modules/dep"), { recursive: true });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "plan alpha"]);

    const result = launchPlan({
      cwd: root,
      prepare: true,
      sessionKey: "main-session",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const task = result.tasks[0];
    expect(task?.inputs.missing).toContain("node_modules");
    expect(task?.inputs.next.join("\n")).toContain("ln -s");
  });

  it("rejects an out-of-range wave without creating anything", () => {
    writeTask(root, "10-28-alpha", { touches: ["src/a/**"] });
    const before = worktreeListing(root);

    const result = launchPlan({ cwd: root, wave: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PARALLEL_WAVE_NOT_FOUND");
    expect(worktreeListing(root)).toBe(before);
  });
});

function worktreeListing(root: string): string {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf-8",
  });
}

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
    children?: readonly string[];
    worktree?: "auto" | "always" | "never";
    kind?: string;
    branch?: string;
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
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.children === undefined ? {} : { children: options.children }),
      meta: {
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        parallel: {
          ...(options.touches === undefined ? {} : { touches: options.touches }),
          ...(options.dependsOn === undefined
            ? {}
            : { depends_on: options.dependsOn }),
          ...(options.exclusive === true ? { exclusive: true } : {}),
          ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
        },
      },
    }),
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function writeSpecDelta(root: string, id: string): void {
  fs.writeFileSync(
    path.join(root, ".phronia/tasks", id, "spec-delta.md"),
    "# Spec Delta\n\n## Target files\n- .phronia/spec/guides/a.md\n",
  );
}

function setSpecSync(
  root: string,
  id: string,
  status: "synced" | "failed",
): void {
  const file = path.join(root, ".phronia/tasks", id, "task.json");
  const task = JSON.parse(fs.readFileSync(file, "utf8")) as {
    meta?: Record<string, unknown>;
  };
  task.meta = { ...(task.meta ?? {}), spec_sync: { status } };
  fs.writeFileSync(file, JSON.stringify(task));
}
