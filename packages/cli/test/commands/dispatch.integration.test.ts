import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchBatch } from "../../src/services/coordinator.js";
import { listTaskLeases } from "../../src/services/lease.js";
import { planTasks } from "../../src/services/parallel.js";

// Git-heavy cases take ~8s alone; the full `pnpm verify` run adds enough
// parallel load to cross 30s. Keep headroom so the suite is not flaky.
describe("coordinator dispatch integration (COORD-01..03)", { timeout: 60_000 }, () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
    writeTask(root, "10-28-alpha", ["src/a/**"]);
    writeTask(root, "10-28-beta", ["src/b/**"]);
    writeTask(root, "10-28-gamma", ["src/c/**"]);
    commitAll(root, "plan tasks");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("COORD-03: ZCode/Codex/unknown return COORDINATOR_UNSUPPORTED without leases or worktrees", () => {
    for (const platform of ["zcode", "codex", "cursor"]) {
      const result = dispatchBatch({
        cwd: root,
        batchId: `b-${platform}`,
        platform,
      });
      expect(result.ok, `${platform}: ${JSON.stringify(result)}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("COORDINATOR_UNSUPPORTED");
      expect(result.details?.fallback).toBe("multi-session");
      expect(result.next).toContain("multi-session");
      const commands = result.details?.commands;
      expect(Array.isArray(commands)).toBe(true);
      expect((commands as string[]).some((command) => command.includes("workspace ensure"))).toBe(
        true,
      );
      expect(leaseFiles(root)).toHaveLength(0);
      expect(fs.existsSync(path.join(root, ".phronia/worktrees"))).toBe(false);
    }
  });

  it("COORD-01: Claude Code produces a manifest with workspace/lease/promptPrefix", () => {
    const result = dispatchBatch({
      cwd: root,
      batchId: "b1",
      platform: "claude-code",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.dryRun).toBe(false);
    expect(result.tasks).toHaveLength(3);
    for (const task of result.tasks) {
      expect(task.workspace).not.toBe(root);
      expect(fs.existsSync(task.workspace)).toBe(true);
      expect(task.branch.startsWith("phronia/")).toBe(true);
      expect(task.lease).toBeTruthy();
      expect(task.promptPrefix.split("\n")[0]).toBe(`Active task: ${task.taskRef}`);
      expect(task.promptPrefix).toContain(task.workspace);
      expect(task.promptPrefix).toContain("Commit your changes");
    }

    expect(listTaskLeases({ cwd: root })).toHaveLength(3);
    expect(result.batchPath).not.toBeNull();
    const summary = JSON.parse(fs.readFileSync(result.batchPath ?? "", "utf8")) as {
      batch: string;
      wave: number;
      tasks: string[];
      manifestHash: string;
      createdAt: string;
    };
    expect(summary.batch).toBe("b1");
    expect(summary.wave).toBe(1);
    expect(summary.tasks).toHaveLength(3);
    expect(summary.manifestHash).toBe(result.manifestHash);
    expect(Date.parse(summary.createdAt)).not.toBeNaN();

    // The orchestrator must not keep the main checkout.
    expect(fs.existsSync(path.join(root, ".git/phronia/workspace.claim.json"))).toBe(
      false,
    );
  });

  it("COORD-02: a non-overlapping new task joins the open wave; an overlapping one waits", () => {
    const identity = { sessionKey: "coordinator-test", ownerId: "coordinator-test" };
    const first = dispatchBatch({
      cwd: root,
      batchId: "b1",
      platform: "claude-code",
      ...identity,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);

    // New session creates a disjoint task in the shared index. The coordinator
    // re-plans with an extra slot instead of waiting for the batch to finish.
    writeTask(root, "10-28-delta", ["src/d/**"]);
    commitAll(root, "add delta");
    const rePlan = dispatchBatch({
      cwd: root,
      batchId: "b1",
      platform: "claude-code",
      maxConcurrent: 4,
      ...identity,
    });
    expect(rePlan.ok, JSON.stringify(rePlan)).toBe(true);
    if (!rePlan.ok) return;
    expect(rePlan.tasks.map((task) => task.taskRef)).toContain(
      ".phronia/tasks/10-28-delta",
    );
    expect(rePlan.tasks).toHaveLength(4);

    // A later task that overlaps alpha must not enter the running wave.
    writeTask(root, "10-28-overlap", ["src/a/shared.ts"]);
    commitAll(root, "add overlap");
    const planned = planTasks({ cwd: root, includePlanning: false });
    expect(planned.ok, JSON.stringify(planned)).toBe(true);
    if (!planned.ok) return;
    const waveWithOverlap = planned.waves.find((wave) =>
      wave.tasks.includes(".phronia/tasks/10-28-overlap"),
    );
    expect(waveWithOverlap?.index).toBeGreaterThan(0);

    const waveOne = dispatchBatch({
      cwd: root,
      batchId: "b2",
      wave: 1,
      platform: "claude-code",
      ...identity,
    });
    expect(waveOne.ok, JSON.stringify(waveOne)).toBe(true);
    if (!waveOne.ok) return;
    expect(waveOne.tasks.map((task) => task.taskRef)).not.toContain(
      ".phronia/tasks/10-28-overlap",
    );

    const waveTwo = dispatchBatch({
      cwd: root,
      batchId: "b2",
      wave: 2,
      platform: "claude-code",
      ...identity,
    });
    expect(waveTwo.ok, JSON.stringify(waveTwo)).toBe(true);
    if (!waveTwo.ok) return;
    expect(waveTwo.tasks.map((task) => task.taskRef)).toContain(
      ".phronia/tasks/10-28-overlap",
    );
  });

  it("COORD-01: the dispatch path contains no agent process spawning", () => {
    for (const relative of [
      "../../src/services/coordinator.ts",
      "../../src/commands/dispatch.ts",
    ]) {
      const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
      expect(source, relative).not.toContain("node:child_process");
      expect(source, relative).not.toMatch(/\bspawn(Sync)?\s*\(/);
    }
  });

  it("dry-run plans without creating leases or worktrees", () => {
    const result = dispatchBatch({
      cwd: root,
      batchId: "b-dry",
      platform: "claude-code",
      dryRun: true,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(true);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.every((task) => task.lease === null)).toBe(true);
    expect(leaseFiles(root)).toHaveLength(0);
    expect(fs.existsSync(path.join(root, ".phronia/worktrees"))).toBe(false);
  });
});

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-coordinator-"));
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

function writeTask(root: string, id: string, touches: readonly string[]): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id,
      title: `Task ${id}`,
      status: "in_progress",
      priority: "P2",
      meta: { parallel: { touches } },
    }),
  );
  fs.writeFileSync(path.join(dir, "prd.md"), `# ${id}\n`);
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function leaseFiles(root: string): string[] {
  const dir = path.join(root, ".git/phronia/leases");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
