import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireTaskLease,
  leaseStatus,
  releaseTaskLease,
} from "../../src/services/lease.js";

describe("task lease integration (LEASE-01)", () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when no ownerId or session identity exists", () => {
    const result = acquireTaskLease("10-28-alpha", {
      cwd: root,
      env: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LEASE_OWNER_UNKNOWN");
    expect(result.next).toContain("--owner-id");

    const leasesDir = path.join(root, ".git/phronia/leases");
    const files = fs.existsSync(leasesDir)
      ? fs.readdirSync(leasesDir).filter((file) => file.endsWith(".json"))
      : [];
    expect(files).toHaveLength(0);
  });

  it("accepts an explicit ownerId without a session key", () => {
    const result = acquireTaskLease("10-28-alpha", {
      cwd: root,
      env: {},
      ownerId: "agent-explicit",
      workspace: root,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.lease.ownerId).toBe("agent-explicit");
    expect(result.lease.sessionKey).toBeUndefined();
  });

  it("LEASE-01: exactly one owner acquires the task; the other gets LEASE_BUSY", () => {
    const first = acquireTaskLease("10-28-alpha", {
      cwd: root,
      ownerType: "subagent",
      ownerId: "agent-1",
      sessionKey: "session-one",
      workspace: root,
      ttlSeconds: 600,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);

    const second = acquireTaskLease("10-28-alpha", {
      cwd: root,
      ownerType: "subagent",
      ownerId: "agent-2",
      sessionKey: "session-two",
      workspace: root,
      ttlSeconds: 600,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("LEASE_BUSY");
    expect(second.message).toContain("agent-1");
    expect(second.details?.ownerId).toBe("agent-1");
    expect(second.details?.workspace).toBe(root);
    expect(second.next).toContain("agent-1");

    const leaseFile = path.join(root, ".git/phronia/leases");
    expect(fs.readdirSync(leaseFile).filter((file) => file.endsWith(".json"))).toHaveLength(
      1,
    );
  });

  it("refreshes the heartbeat for the same owner and releases explicitly", () => {
    const first = acquireTaskLease("10-28-alpha", {
      cwd: root,
      ownerType: "session",
      ownerId: "session:one",
      sessionKey: "session-one",
      workspace: root,
    });
    expect(first.ok).toBe(true);

    const again = acquireTaskLease("10-28-alpha", {
      cwd: root,
      ownerType: "session",
      ownerId: "session:one",
      sessionKey: "session-one",
      workspace: root,
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);

    const status = leaseStatus("10-28-alpha", { cwd: root });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.lease?.ownerId).toBe("session:one");
    expect(status.stale).toBe(false);

    const released = releaseTaskLease("10-28-alpha", {
      cwd: root,
      sessionKey: "session-one",
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.released).toBe(true);

    const after = leaseStatus("10-28-alpha", { cwd: root });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.lease).toBeNull();
  });

  it("reports a stale lease and lets another owner reclaim it", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const first = acquireTaskLease("10-28-alpha", {
      cwd: root,
      ownerType: "subagent",
      ownerId: "agent-old",
      sessionKey: "session-old",
      workspace: root,
      ttlSeconds: 1,
      now: () => start,
    });
    expect(first.ok).toBe(true);

    const status = leaseStatus("10-28-alpha", {
      cwd: root,
      now: () => new Date(start.getTime() + 5_000),
    });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.stale).toBe(true);

    const reclaimed = acquireTaskLease("10-28-alpha", {
      cwd: root,
      ownerType: "subagent",
      ownerId: "agent-new",
      sessionKey: "session-new",
      workspace: root,
      ttlSeconds: 600,
      now: () => new Date(start.getTime() + 5_000),
    });
    expect(reclaimed.ok, JSON.stringify(reclaimed)).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.lease.ownerId).toBe("agent-new");
  });

  it("refuses to release another session's lease unless forced", () => {
    acquireTaskLease("10-28-alpha", {
      cwd: root,
      ownerType: "session",
      ownerId: "session:one",
      sessionKey: "session-one",
      workspace: root,
    });

    const refused = releaseTaskLease("10-28-alpha", {
      cwd: root,
      sessionKey: "session-two",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("LEASE_BUSY");

    const forced = releaseTaskLease("10-28-alpha", {
      cwd: root,
      sessionKey: "session-two",
      force: true,
    });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
  });
});

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-lease-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, stdio: "ignore" });
  return root;
}
