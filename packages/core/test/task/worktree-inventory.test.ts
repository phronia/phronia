import { describe, expect, it } from "vitest";

import {
  reconcileWorktrees,
  type GitWorktreeFact,
  type WorktreeRegistryEntryLike,
} from "../../src/task/worktree/inventory.js";

const root = { absolute: "/repo/.phronia-workspace" };

function registry(
  entries: readonly WorktreeRegistryEntryLike[],
): WorktreeRegistryEntryLike[] {
  return [...entries];
}

function git(
  entries: readonly GitWorktreeFact[],
): GitWorktreeFact[] {
  return [...entries];
}

describe("reconcileWorktrees", () => {
  it("classifies managed, provisional, unmanaged, and missing entries", () => {
    const inventory = reconcileWorktrees({
      mainRoot: "/repo",
      root,
      registry: registry([
        {
          taskRef: ".phronia/tasks/A",
          path: "/repo/.phronia-workspace/A",
          branch: "phronia/A",
          kind: "phronia",
        },
        {
          taskRef: "",
          path: "/repo/.phronia-workspace/provisional-1",
          branch: "phronia/wip/1",
          kind: "phronia",
          provisional: true,
        },
        {
          taskRef: ".phronia/tasks/gone",
          path: "/repo/.phronia-workspace/gone",
          branch: "phronia/gone",
          kind: "phronia",
        },
      ]),
      git: git([
        { path: "/repo", branch: "main", head: "c-main" },
        { path: "/repo/.phronia-workspace/A", branch: "phronia/A", head: "c-a" },
        {
          path: "/repo/.phronia-workspace/provisional-1",
          branch: "phronia/wip/1",
          head: "c-p1",
        },
        {
          path: "/parent/manual-fix",
          branch: "fix/manual",
          head: "c-manual",
        },
      ]),
    });

    expect(inventory.managed.map((entry) => entry.path)).toEqual([
      "/repo/.phronia-workspace/A",
    ]);
    expect(inventory.provisional.map((entry) => entry.path)).toEqual([
      "/repo/.phronia-workspace/provisional-1",
    ]);
    expect(inventory.unmanaged.map((entry) => entry.path)).toEqual([
      "/parent/manual-fix",
    ]);
    expect(inventory.missing.map((entry) => entry.path)).toEqual([
      "/repo/.phronia-workspace/gone",
    ]);

    const manual = inventory.unmanaged[0];
    expect(manual).toMatchObject({
      managed: false,
      insideRoot: false,
      outsideRepo: true,
      exists: true,
    });
  });

  it("keeps every provisional entry even though taskRef is empty", () => {
    const inventory = reconcileWorktrees({
      mainRoot: "/repo",
      root,
      registry: registry([
        {
          taskRef: "",
          path: "/repo/.phronia-workspace/wip-a",
          branch: "fix/a",
          kind: "phronia",
          provisional: true,
        },
        {
          taskRef: "",
          path: "/repo/.phronia-workspace/wip-b",
          branch: "fix/b",
          kind: "phronia",
          provisional: true,
        },
      ]),
      git: git([
        { path: "/repo/.phronia-workspace/wip-a", branch: "fix/a", head: "c-a" },
        { path: "/repo/.phronia-workspace/wip-b", branch: "fix/b", head: "c-b" },
      ]),
    });

    expect(inventory.provisional).toHaveLength(2);
    expect(inventory.persisted).toHaveLength(2);
    expect(inventory.persisted.map((entry) => entry.taskRef)).toEqual(["", ""]);
  });

  it("never persists unmanaged worktrees", () => {
    const inventory = reconcileWorktrees({
      mainRoot: "/repo",
      root,
      registry: registry([
        {
          taskRef: ".phronia/tasks/A",
          path: "/repo/.phronia-workspace/A",
          branch: "phronia/A",
        },
      ]),
      git: git([
        { path: "/repo/.phronia-workspace/A", branch: "phronia/A", head: "c-a" },
        { path: "/parent/manual", branch: "fix/manual", head: "c-m" },
      ]),
    });

    expect(inventory.unmanaged).toHaveLength(1);
    expect(inventory.persisted.map((entry) => entry.path)).toEqual([
      "/repo/.phronia-workspace/A",
    ]);
  });

  it("drops registry paths that no longer exist in git", () => {
    const inventory = reconcileWorktrees({
      mainRoot: "/repo",
      root,
      registry: registry([
        {
          taskRef: ".phronia/tasks/A",
          path: "/repo/.phronia-workspace/A",
          branch: "phronia/A",
        },
      ]),
      git: git([]),
    });

    expect(inventory.missing).toHaveLength(1);
    expect(inventory.persisted).toEqual([]);
  });

  it("reports root and registry diagnostics", () => {
    const inventory = reconcileWorktrees({
      mainRoot: "/repo",
      root,
      registry: registry([]),
      git: git([{ path: "/parent/manual", branch: "fix/manual", head: "c-m" }]),
    });

    const codes = inventory.diagnostics.map((entry) => entry.code);
    expect(codes).toContain("RUNTIME_WORKTREES_UNMANAGED");
    expect(codes).toContain("RUNTIME_WORKTREES_OUTSIDE_ROOT");
  });

  it("ignores the main checkout and bare worktrees", () => {
    const inventory = reconcileWorktrees({
      mainRoot: "/repo",
      root,
      registry: registry([]),
      git: git([
        { path: "/repo", branch: "main", head: "c-main" },
        { path: "/repo/bare", branch: "", head: null, bare: true },
      ]),
    });

    expect(inventory.entries).toEqual([]);
  });
});
