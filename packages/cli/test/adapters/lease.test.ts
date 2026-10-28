import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLeaseStore,
  isLeaseBusy,
  LeaseError,
  type LeaseRecord,
} from "../../src/adapters/lease.js";

interface TestLease extends LeaseRecord {
  taskRef: string;
  ownerId: string;
  workspace: string;
}

let directory: string;
let leasePath: string;
let current: Date;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-lease-"));
  leasePath = path.join(directory, "phronia", "integration.lock");
  current = new Date("2026-10-28T10:00:00.000Z");
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("LeaseStore", () => {
  it("acquires exclusively, exposes the record, and releases", () => {
    const store = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "test-host",
      pid: 111,
      isProcessAlive: () => true,
    });
    const acquired = store.acquire(lease("a"));
    expect(isLeaseBusy(acquired)).toBe(false);
    if (isLeaseBusy(acquired)) {
      throw new Error("expected the lease to be free");
    }

    const onDisk = JSON.parse(fs.readFileSync(leasePath, "utf8")) as TestLease;
    expect(onDisk).toMatchObject({
      schemaVersion: 1,
      taskRef: ".phronia/tasks/a",
      ownerId: "a",
      workspace: "/repo",
      host: "test-host",
      pid: 111,
      acquiredAt: current.toISOString(),
      heartbeatAt: current.toISOString(),
    });
    expect(store.read()).toEqual(acquired.record);

    const other = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "test-host",
      pid: 222,
      isProcessAlive: () => true,
    });
    const busy = other.acquire(lease("b"));
    expect(isLeaseBusy(busy)).toBe(true);
    if (isLeaseBusy(busy)) {
      expect(busy.busy.ownerId).toBe("a");
    }

    store.release(acquired);
    expect(fs.existsSync(leasePath)).toBe(false);
    expect(store.read()).toBeNull();
  });

  it("updates heartbeatAt and patch fields with temp+rename", () => {
    const store = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "test-host",
      pid: 111,
      isProcessAlive: () => true,
    });
    const acquired = store.acquire(lease("a"));
    if (isLeaseBusy(acquired)) throw new Error("unexpected busy");

    current = new Date(current.getTime() + 30_000);
    store.heartbeat(acquired, { ownerId: "a2" });

    expect(acquired.record.ownerId).toBe("a2");
    expect(acquired.record.heartbeatAt).toBe(current.toISOString());
    expect(store.read()).toMatchObject({
      ownerId: "a2",
      heartbeatAt: current.toISOString(),
    });
    expect(fs.readdirSync(path.dirname(leasePath))).toEqual(["integration.lock"]);
  });

  it("reclaims a record whose TTL expired", () => {
    const store = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host-a",
      pid: 111,
      isProcessAlive: () => true,
    });
    const expired = store.acquire(lease("a", 10));
    if (isLeaseBusy(expired)) throw new Error("unexpected busy");
    expect(store.isStale(expired.record)).toBe(false);

    current = new Date(current.getTime() + 11_000);
    expect(store.isStale(expired.record)).toBe(true);

    const second = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host-b",
      pid: 222,
      isProcessAlive: () => true,
    });
    const acquired = second.acquire(lease("b"));
    expect(isLeaseBusy(acquired)).toBe(false);
    expect(second.read()).toMatchObject({ ownerId: "b", host: "host-b", pid: 222 });
  });

  it("treats a dead pid as stale only with liveness ttl-or-pid", () => {
    const store = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "shared-host",
      pid: 111,
      isProcessAlive: () => false,
    });
    const acquired = store.acquire(lease("a"));
    if (isLeaseBusy(acquired)) throw new Error("unexpected busy");

    // Default liveness is TTL-only: the command process has exited but the
    // session is still working, so the claim must not be considered stale.
    expect(store.isStale(acquired.record)).toBe(false);
    const ttlOnly = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "shared-host",
      pid: 222,
      isProcessAlive: () => false,
    });
    expect(ttlOnly.isStale(acquired.record)).toBe(false);
    expect(isLeaseBusy(ttlOnly.acquire(lease("b")))).toBe(true);

    // Opting into pid liveness makes the same record stale.
    const pidAware = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "shared-host",
      pid: 333,
      liveness: "ttl-or-pid",
      isProcessAlive: () => false,
    });
    expect(pidAware.isStale(acquired.record)).toBe(true);
  });

  it("reclaims a same-host record whose pid is gone when ttl-or-pid is enabled", () => {
    const first = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "shared-host",
      pid: 111,
      liveness: "ttl-or-pid",
      isProcessAlive: () => true,
    });
    if (isLeaseBusy(first.acquire(lease("a")))) {
      throw new Error("unexpected busy");
    }

    const second = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "shared-host",
      pid: 222,
      liveness: "ttl-or-pid",
      isProcessAlive: () => false,
    });
    const acquired = second.acquire(lease("b"));
    expect(isLeaseBusy(acquired)).toBe(false);
    expect(second.read()).toMatchObject({ ownerId: "b", pid: 222 });
  });

  it("does not reclaim a dead pid from another host", () => {
    const first = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host-a",
      pid: 111,
      liveness: "ttl-or-pid",
      isProcessAlive: () => true,
    });
    if (isLeaseBusy(first.acquire(lease("a")))) {
      throw new Error("unexpected busy");
    }

    const second = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host-b",
      pid: 222,
      liveness: "ttl-or-pid",
      isProcessAlive: () => false,
    });
    const busy = second.acquire(lease("b"));
    expect(isLeaseBusy(busy)).toBe(true);
    expect(second.read()).toMatchObject({ ownerId: "a", host: "host-a" });
  });

  it("honors a stricter reclaim policy", () => {
    const store = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host-a",
      pid: 111,
      reclaimWhen: () => false,
    });
    if (isLeaseBusy(store.acquire(lease("a", 1)))) {
      throw new Error("unexpected busy");
    }

    current = new Date(current.getTime() + 60_000);
    const second = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host-b",
      pid: 222,
      reclaimWhen: () => false,
    });
    expect(isLeaseBusy(second.acquire(lease("b")))).toBe(true);
  });

  it("recovers from a corrupt record file", () => {
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, "{not json", "utf8");

    const store = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host",
      pid: 1,
    });
    const acquired = store.acquire(lease("a"));
    expect(isLeaseBusy(acquired)).toBe(false);
    expect(store.read()).toMatchObject({ ownerId: "a" });
    expect(
      fs
        .readdirSync(path.dirname(leasePath))
        .filter((name) => name.includes(".stale.")),
    ).toEqual([]);
  });

  it("refuses to clobber a record owned by another handle", () => {
    const store = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host-a",
      pid: 111,
    });
    const acquired = store.acquire(lease("a"));
    if (isLeaseBusy(acquired)) throw new Error("unexpected busy");

    fs.writeFileSync(
      leasePath,
      `${JSON.stringify({
        schemaVersion: 1,
        taskRef: ".phronia/tasks/a",
        ownerId: "intruder",
        workspace: "/other",
        host: "host-b",
        pid: 999,
        acquiredAt: "2026-10-28T09:00:00.000Z",
        heartbeatAt: "2026-10-28T09:00:00.000Z",
        ttlSeconds: 3600,
      })}\n`,
      "utf8",
    );

    expect(() => store.heartbeat(acquired)).toThrowError(LeaseError);
    try {
      store.heartbeat(acquired);
    } catch (error) {
      expect((error as LeaseError).code).toBe("LEASE_LOST");
    }
    expect(() => store.release(acquired)).toThrowError(LeaseError);
    expect(store.read()).toMatchObject({ ownerId: "intruder" });
  });

  it("applies the default TTL and treats a missing file as released", () => {
    const store = createLeaseStore<TestLease>({
      path: leasePath,
      now: () => current,
      host: "host-a",
      pid: 111,
      defaultTtlSeconds: 60,
    });
    const acquired = store.acquire({
      taskRef: ".phronia/tasks/a",
      ownerId: "a",
      workspace: "/repo",
    });
    if (isLeaseBusy(acquired)) throw new Error("unexpected busy");
    expect(acquired.record.ttlSeconds).toBe(60);

    fs.unlinkSync(leasePath);
    // Releasing an already-removed lease is a no-op.
    expect(() => store.release(acquired)).not.toThrow();
    expect(store.read()).toBeNull();
  });
});

function lease(ownerId: string, ttlSeconds = 3600): TestLease {
  return {
    taskRef: ".phronia/tasks/a",
    ownerId,
    workspace: "/repo",
    ttlSeconds,
  };
}
