import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coordinatorStatus,
  dispatchBatch,
} from "../../src/services/coordinator.js";
import {
  acquireTaskLease,
  leaseStatus,
  releaseTaskLease,
} from "../../src/services/lease.js";

// Git-heavy cases run in ~4s alone; the full `pnpm verify` run adds enough
// parallel load to cross the 10s default. Keep headroom for the suite.
describe("coordinator status integration (COORD-04)", { timeout: 60_000 }, () => {
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

  it("reports queued/running/blocked/landed and keeps other tasks running", () => {
    const dispatched = dispatchBatch({
      cwd: root,
      batchId: "b1",
      platform: "claude-code",
    });
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);

    markStatus(root, "10-28-beta", "blocked");

    const status = coordinatorStatus({
      cwd: root,
      batch: "b1",
      platform: "claude-code",
    });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;

    expect(status.batch).toBe("b1");
    expect(status.wave).toBe(1);
    expect(status.tasks).toHaveLength(3);
    expect(status.summary.blocked).toEqual([".phronia/tasks/10-28-beta"]);
    expect(status.summary.running).toEqual([
      ".phronia/tasks/10-28-alpha",
      ".phronia/tasks/10-28-gamma",
    ]);
    expect(status.summary.done).toBe(false);
    expect(status.tasks.find((task) => task.ref === ".phronia/tasks/10-28-beta")?.batchState).toBe(
      "blocked",
    );
    expect(status.capabilities?.coordinator.available).toBe(true);
    expect(status.next).toContain("blocked");
  });

  it("reports stale leases as guidance and never auto-reclaims them", () => {
    const dispatched = dispatchBatch({
      cwd: root,
      batchId: "b1",
      platform: "claude-code",
    });
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);

    // Replace the coordinator lease with a TTL-expired one.
    releaseTaskLease("10-28-alpha", { cwd: root, force: true });
    const old = acquireTaskLease("10-28-alpha", {
      cwd: root,
      ownerType: "subagent",
      ownerId: "old-agent",
      sessionKey: "old-session",
      workspace: root,
      ttlSeconds: 1,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(old.ok, JSON.stringify(old)).toBe(true);

    const later = new Date("2026-01-02T00:00:00.000Z");
    const status = coordinatorStatus({
      cwd: root,
      batch: "b1",
      platform: "claude-code",
      now: () => later,
    });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;

    expect(status.staleLeases.map((lease) => lease.taskRef)).toContain(
      ".phronia/tasks/10-28-alpha",
    );
    expect(status.staleLeases[0]?.next).toContain("phronia task lease status");
    expect(status.next).toContain("stale lease");
    expect(status.next).toContain("no auto-reclaim");

    // The lease is still on disk; status did not reclaim it.
    const lease = leaseStatus("10-28-alpha", { cwd: root, now: () => later });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    expect(lease.lease).not.toBeNull();
    expect(lease.stale).toBe(true);
  });

  it("fails clearly when a batch has never been dispatched", () => {
    const status = coordinatorStatus({ cwd: root, batch: "missing" });
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.code).toBe("COORDINATOR_BATCH_NOT_FOUND");
    expect(status.next).toContain("phronia task parallel dispatch --batch missing");
  });
});

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-coordinator-status-"));
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

function markStatus(root: string, id: string, status: string): void {
  const file = path.join(root, ".phronia/tasks", id, "task.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.status = status;
  fs.writeFileSync(file, JSON.stringify(raw));
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
