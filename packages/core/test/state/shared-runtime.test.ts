import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  isSupportedSchemaVersion,
  legacyWorktreeRegistryPath,
  readSchemaVersion,
  resolveCommonDir,
  runtimeLogPath,
  safeSlug,
  SHARED_RUNTIME_DIR_NAME,
  SHARED_RUNTIME_SCHEMA_VERSION,
  sharedRuntimePaths,
  sharedRuntimePathsFromRoot,
  taskLeaseKey,
  taskLeasePath,
} from "../../src/state/shared-runtime.js";

describe("shared runtime paths", () => {
  it("resolves relative git-common-dir output against the cwd", () => {
    expect(resolveCommonDir(".git", "/repo")).toBe("/repo/.git");
    expect(resolveCommonDir(".git", "/repo/.phronia/worktrees/a")).toBe(
      "/repo/.phronia/worktrees/a/.git",
    );
    expect(resolveCommonDir("/repo/.git", "/elsewhere")).toBe("/repo/.git");
    expect(() => resolveCommonDir("  ", "/repo")).toThrow(/empty/);
  });

  it("places every coordination file under <common>/phronia", () => {
    const paths = sharedRuntimePaths("/repo/.git");
    expect(SHARED_RUNTIME_DIR_NAME).toBe("phronia");
    expect(paths.root).toBe(path.join("/repo/.git", "phronia"));
    expect(paths.integrationLock).toBe(
      path.join("/repo/.git/phronia", "integration.lock"),
    );
    expect(paths.integration).toBe(
      path.join("/repo/.git/phronia", "integration.json"),
    );
    expect(paths.worktrees).toBe(
      path.join("/repo/.git/phronia", "worktrees.json"),
    );
    expect(paths.workspaceClaim).toBe(
      path.join("/repo/.git/phronia", "workspace.claim.json"),
    );
    expect(paths.tasksIndex).toBe(
      path.join("/repo/.git/phronia", "tasks.index.json"),
    );
    expect(paths.leases).toBe(path.join("/repo/.git/phronia", "leases"));
    expect(paths.logs).toBe(path.join("/repo/.git/phronia", "logs"));
  });

  it("supports an arbitrary root for the legacy fallback", () => {
    const paths = sharedRuntimePathsFromRoot("/repo/.phronia/.runtime");
    expect(paths.root).toBe("/repo/.phronia/.runtime");
    expect(paths.integrationLock).toBe(
      path.join("/repo/.phronia/.runtime", "integration.lock"),
    );
  });

  it("keeps the legacy registry path for migration reads", () => {
    expect(legacyWorktreeRegistryPath("/repo")).toBe(
      path.join("/repo", ".phronia", ".runtime", "worktrees.json"),
    );
  });
});

describe("lease and log filenames", () => {
  it("hashes task refs into stable, path-safe keys", () => {
    const key = taskLeaseKey(".phronia/tasks/10-28-a");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(taskLeaseKey(".phronia/tasks/10-28-a")).toBe(key);
    expect(taskLeaseKey(".phronia/tasks/10-28-b")).not.toBe(key);
    expect(taskLeaseKey("../../evil")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("puts leases under leases/<hash>.json", () => {
    const paths = sharedRuntimePaths("/repo/.git");
    expect(taskLeasePath(paths, ".phronia/tasks/a")).toBe(
      path.join(paths.leases, `${taskLeaseKey(".phronia/tasks/a")}.json`),
    );
  });

  it("builds log paths with path-safe slugs", () => {
    const paths = sharedRuntimePaths("/repo/.git");
    expect(runtimeLogPath(paths, ".phronia/tasks/A B", "2026-10-28T10:00:00Z")).toBe(
      path.join(paths.logs, "phronia-tasks-a-b-2026-10-28t10-00-00z.log"),
    );
    expect(safeSlug("")).toBe("runtime");
    expect(safeSlug("../../etc/passwd")).toBe("etc-passwd");
  });
});

describe("schema envelope", () => {
  it("accepts only supported versions", () => {
    expect(SHARED_RUNTIME_SCHEMA_VERSION).toBe(1);
    expect(isSupportedSchemaVersion(1)).toBe(true);
    expect(isSupportedSchemaVersion(2)).toBe(false);
    expect(isSupportedSchemaVersion("1")).toBe(false);
    expect(isSupportedSchemaVersion(undefined)).toBe(false);
  });

  it("reads a numeric schemaVersion from an object", () => {
    expect(readSchemaVersion({ schemaVersion: 1 })).toBe(1);
    expect(readSchemaVersion({ schemaVersion: "1" })).toBeNull();
    expect(readSchemaVersion([])).toBeNull();
    expect(readSchemaVersion(null)).toBeNull();
  });
});
