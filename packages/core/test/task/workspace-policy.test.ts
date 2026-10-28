import { describe, expect, it } from "vitest";

import {
  decideWorkspace,
  isDedicatedFeatureBranch,
  worktreeSlug,
} from "../../src/task/workspace/policy.js";
import type {
  WorkspaceClaim,
  WorkspacePolicyContext,
} from "../../src/task/workspace/types.js";

function context(
  overrides: Partial<WorkspacePolicyContext> = {},
): WorkspacePolicyContext {
  return {
    currentCheckout: "/repo",
    integrationBranch: "main",
    task: { ref: ".phronia/tasks/A" },
    mainDirty: false,
    ...overrides,
  };
}

function claim(overrides: Partial<WorkspaceClaim> = {}): WorkspaceClaim {
  return {
    ownerType: "task",
    ownerRef: "task:.phronia/tasks/B",
    taskRef: ".phronia/tasks/B",
    workspace: "/repo",
    state: "claimed",
    ...overrides,
  };
}

describe("decideWorkspace", () => {
  it("reuses a clean, unclaimed checkout for a serial task", () => {
    const decision = decideWorkspace(context());
    expect(decision).toEqual({
      kind: "reuse-current",
      reason: "the current checkout is clean and no other task is active",
    });
  });

  it("attaches to an existing task worktree", () => {
    const decision = decideWorkspace(
      context({
        task: {
          ref: ".phronia/tasks/A",
          worktree: {
            path: "/repo/.phronia/worktrees/A",
            branch: "phronia/A",
          },
        },
      }),
    );
    expect(decision).toEqual({
      kind: "attach",
      path: "/repo/.phronia/worktrees/A",
      branch: "phronia/A",
      reason:
        "task already has a worktree; reuse it instead of creating a second one",
    });
  });

  it("WS-03: two sessions on the same task get the same worktree", () => {
    const base = context({
      existingWorktrees: [
        {
          path: "/repo/.phronia/worktrees/A",
          branch: "phronia/A",
          taskRef: ".phronia/tasks/A",
        },
      ],
    });
    const first = decideWorkspace(base);
    const second = decideWorkspace(base);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "attach",
      path: "/repo/.phronia/worktrees/A",
      branch: "phronia/A",
    });
  });

  it("attaches by task branch when the registry has no taskRef", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", branch: "phronia/A" },
        existingWorktrees: [
          { path: "/platform/wt/A", branch: "phronia/A" },
        ],
      }),
    );
    expect(decision).toMatchObject({
      kind: "attach",
      path: "/platform/wt/A",
      branch: "phronia/A",
    });
  });

  it("refuses an existing worktree on the wrong branch", () => {
    const decision = decideWorkspace(
      context({
        task: {
          ref: ".phronia/tasks/A",
          branch: "phronia/A",
          worktree: {
            path: "/repo/.phronia/worktrees/A",
            branch: "phronia/wrong",
          },
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_ATTACH_INVALID",
    });
  });

  it("refuses a registry branch that belongs to another task", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", branch: "phronia/shared" },
        existingWorktrees: [
          {
            path: "/repo/.phronia/worktrees/B",
            branch: "phronia/shared",
            taskRef: ".phronia/tasks/B",
          },
        ],
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_ATTACH_INVALID",
    });
  });

  it("refuses when the target path already exists", () => {
    const decision = decideWorkspace(
      context({
        target: {
          path: "/repo/.phronia/worktrees/A",
          branch: "phronia/A",
          exists: true,
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_TARGET_EXISTS",
    });
  });

  it("refuses when the target branch is checked out elsewhere", () => {
    const decision = decideWorkspace(
      context({
        target: {
          path: "/repo/.phronia/worktrees/A",
          branch: "phronia/A",
          checkedOutAt: "/repo/.phronia/worktrees/other",
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_TARGET_EXISTS",
    });
  });

  it("refuses when the target branch is registered to another task", () => {
    const decision = decideWorkspace(
      context({
        existingWorktrees: [
          {
            path: "/repo/.phronia/worktrees/other",
            branch: "phronia/A",
            taskRef: ".phronia/tasks/B",
          },
        ],
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_TARGET_EXISTS",
    });
  });

  it("WS-01: a checkout claimed by another task produces create", () => {
    const decision = decideWorkspace(context({ claim: claim() }));
    expect(decision).toMatchObject({
      kind: "create",
      path: "/repo/.phronia/worktrees/A",
      branch: "phronia/A",
      base: "main",
      code: "WORKSPACE_CLAIM_BUSY",
    });
    if (decision.kind !== "create") return;
    expect(decision.reason).toContain("owned by .phronia/tasks/B");
  });

  it("WS-02: an occupied checkout with uncommitted artifacts creates an isolated workspace", () => {
    const decision = decideWorkspace(
      context({
        // Only the new task's artifacts are dirty in the occupied checkout.
        mainDirty: true,
        mainDirtyPaths: 1,
        claim: claim(),
      }),
    );
    expect(decision).toMatchObject({
      kind: "create",
      path: "/repo/.phronia/worktrees/A",
      branch: "phronia/A",
      base: "main",
    });
  });

  it("reuses the checkout when the current session claimed it before task creation", () => {
    const decision = decideWorkspace(
      context({
        claim: claim({
          ownerType: "session",
          ownerRef: "session:abc",
          taskRef: null,
          ownedByCurrent: true,
        }),
      }),
    );
    expect(decision).toEqual({
      kind: "reuse-current",
      reason: "the current session holds the checkout; bind the new task to it",
    });
  });

  it("creates a worktree for a session-owned claim when the task needs isolation", () => {
    const decision = decideWorkspace(
      context({
        claim: claim({
          ownerType: "session",
          ownerRef: "session:abc",
          taskRef: null,
          ownedByCurrent: true,
        }),
        parallelBatchSize: 2,
      }),
    );
    expect(decision).toMatchObject({
      kind: "create",
      base: "main",
      path: "/repo/.phronia/worktrees/A",
      branch: "phronia/A",
    });
    if (decision.kind !== "create") return;
    expect(decision.reason).toBe(
      "the current session holds the checkout but the task requires isolation",
    );
  });

  it("WS-05: a stale claim with an active owner creates a worktree", () => {
    const decision = decideWorkspace(
      context({
        claim: claim({ stale: true, ownerActive: true }),
      }),
    );
    expect(decision).toMatchObject({ kind: "create" });
    if (decision.kind !== "create") return;
    expect(decision.code).toBe("WORKSPACE_CLAIM_STALE_OWNED");
    expect(decision.reason).toContain("stale-owned");
    expect(decision.reason).toContain(".phronia/tasks/B");
  });

  it("never reclaims a stale claim when the checkout is dirty", () => {
    const decision = decideWorkspace(
      context({
        mainDirty: true,
        claim: claim({ stale: true, ownerActive: false }),
      }),
    );
    expect(decision).toMatchObject({ kind: "create" });
    if (decision.kind !== "create") return;
    expect(decision.code).toBe("WORKSPACE_CLAIM_STALE_DIRTY");
    expect(decision.reason).toContain("stale-dirty");
  });

  it("reclaims a stale claim when the owner finished and the checkout is clean", () => {
    const decision = decideWorkspace(
      context({
        claim: claim({ stale: true, ownerActive: false }),
      }),
    );
    expect(decision).toMatchObject({ kind: "reuse-current" });
    if (decision.kind !== "reuse-current") return;
    expect(decision.reason).toContain("stale-reclaimed");
  });

  it("creates a worktree for a dirty unclaimed checkout", () => {
    const decision = decideWorkspace(
      context({ mainDirty: true, mainDirtyPaths: 3 }),
    );
    expect(decision).toMatchObject({ kind: "create" });
    if (decision.kind !== "create") return;
    expect(decision.reason).toContain("dirty-unclaimed");
    expect(decision.reason).toContain("3 uncommitted path(s)");
  });

  it("reuses a dirty checkout only when --reuse-dirty is explicit", () => {
    const decision = decideWorkspace(
      context({ mainDirty: true, reuseDirty: true }),
    );
    expect(decision).toMatchObject({ kind: "reuse-current" });
    if (decision.kind !== "reuse-current") return;
    expect(decision.reason).toContain("--reuse-dirty");
  });

  it("creates a worktree for a parallel batch", () => {
    const decision = decideWorkspace(context({ parallelBatchSize: 3 }));
    expect(decision).toMatchObject({ kind: "create" });
    if (decision.kind !== "create") return;
    expect(decision.reason).toContain("parallel batch of 3");
  });

  it("creates a worktree for an exclusive task", () => {
    const decision = decideWorkspace(
      context({ task: { ref: ".phronia/tasks/A", exclusive: true } }),
    );
    expect(decision).toMatchObject({ kind: "create" });
  });

  it("creates a worktree when policy is always", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", worktreePolicy: "always" },
      }),
    );
    expect(decision).toMatchObject({ kind: "create" });
  });

  it("reuses the checkout when policy is never and it is clean", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", worktreePolicy: "never" },
      }),
    );
    expect(decision).toMatchObject({ kind: "reuse-current" });
  });

  it("refuses when policy is never and another task owns the checkout", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", worktreePolicy: "never" },
        claim: claim(),
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_CLAIM_BUSY",
    });
  });

  it("refuses when policy is never and a parallel batch needs isolation", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", worktreePolicy: "never" },
        parallelBatchSize: 2,
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_WORKTREE_DISABLED",
    });
  });

  it("refuses a dirty checkout when policy is never", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", worktreePolicy: "never" },
        mainDirty: true,
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_DIRTY_UNCLAIMED",
    });
  });

  it("refuses stale-owned when policy is never", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", worktreePolicy: "never" },
        claim: claim({ stale: true, ownerActive: true }),
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_CLAIM_STALE_OWNED",
    });
  });

  it("refuses stale-dirty when policy is never", () => {
    const decision = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", worktreePolicy: "never" },
        mainDirty: true,
        claim: claim({ stale: true }),
      }),
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      code: "WORKSPACE_CLAIM_STALE_DIRTY",
    });
  });

  it("reuses the checkout when the task already owns it", () => {
    const decision = decideWorkspace(
      context({ claim: claim({ taskRef: ".phronia/tasks/A" }) }),
    );
    expect(decision).toMatchObject({
      kind: "reuse-current",
      reason: "this task already owns the current checkout",
    });
  });

  it("R13: a task branch equal to the integration branch does not become the worktree branch", () => {
    const serial = decideWorkspace(
      context({ task: { ref: ".phronia/tasks/A", branch: "main" } }),
    );
    expect(serial).toMatchObject({ kind: "reuse-current" });

    const isolated = decideWorkspace(
      context({
        task: { ref: ".phronia/tasks/A", branch: "main" },
        parallelBatchSize: 2,
      }),
    );
    expect(isolated).toMatchObject({
      kind: "create",
      branch: "phronia/A",
      base: "main",
    });
  });

  it("R13: origin/main integration still treats a recorded main branch as non-dedicated", () => {
    const serial = decideWorkspace(
      context({
        integrationBranch: "origin/main",
        task: { ref: ".phronia/tasks/A", branch: "main" },
      }),
    );
    expect(serial).toMatchObject({ kind: "reuse-current" });

    const isolated = decideWorkspace(
      context({
        integrationBranch: "origin/main",
        task: { ref: ".phronia/tasks/A", branch: "main" },
        parallelBatchSize: 2,
      }),
    );
    expect(isolated).toMatchObject({
      kind: "create",
      branch: "phronia/A",
      base: "origin/main",
    });
  });

  it("forces a worktree when the task owns main but joins a parallel batch", () => {
    const decision = decideWorkspace(
      context({
        claim: claim({ taskRef: ".phronia/tasks/A" }),
        parallelBatchSize: 2,
      }),
    );
    expect(decision).toMatchObject({ kind: "create" });
  });

  it("always forks a new worktree from the integration branch, not the owner branch", () => {
    const decision = decideWorkspace(
      context({
        integrationBranch: "main",
        claim: claim({
          taskRef: ".phronia/tasks/B",
          ownerRef: "task:.phronia/tasks/B",
        }),
        existingWorktrees: [
          {
            path: "/repo/.phronia/worktrees/B",
            branch: "phronia/B",
            taskRef: ".phronia/tasks/B",
          },
        ],
      }),
    );
    expect(decision).toMatchObject({
      kind: "create",
      base: "main",
      branch: "phronia/A",
    });
  });

  it("honors an explicit target path and branch", () => {
    const decision = decideWorkspace(
      context({
        mainDirty: true,
        target: {
          path: "/custom/wt/A",
          branch: "custom/A",
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "create",
      path: "/custom/wt/A",
      branch: "custom/A",
      base: "main",
    });
  });

  it("uses a relative worktreeDir under the current checkout", () => {
    const decision = decideWorkspace(
      context({ worktreeDir: ".custom/wt", parallelBatchSize: 2 }),
    );
    expect(decision).toMatchObject({
      kind: "create",
      path: "/repo/.custom/wt/A",
    });
  });

  it("uses a POSIX absolute worktreeDir without prefixing the checkout", () => {
    const decision = decideWorkspace(
      context({ worktreeDir: "/mnt/worktrees", parallelBatchSize: 2 }),
    );
    expect(decision).toMatchObject({
      kind: "create",
      path: "/mnt/worktrees/A",
      branch: "phronia/A",
    });
  });

  it("uses a Windows absolute worktreeDir without prefixing the checkout", () => {
    const decision = decideWorkspace(
      context({ worktreeDir: "C:\\worktrees", parallelBatchSize: 2 }),
    );
    expect(decision).toMatchObject({
      kind: "create",
      path: "C:/worktrees/A",
      branch: "phronia/A",
    });
  });
});

describe("worktreeSlug", () => {
  it("uses the task id when present", () => {
    expect(
      worktreeSlug({ ref: ".phronia/tasks/10-28-a", id: "progress-bar" }),
    ).toBe("progress-bar");
  });

  it("falls back to the ref basename", () => {
    expect(worktreeSlug({ ref: ".phronia/tasks/10-28-a" })).toBe("10-28-a");
  });

  it("sanitizes unsafe characters and truncates long ids", () => {
    const slug = worktreeSlug({
      ref: ".phronia/tasks/x",
      id: `a b/${"x".repeat(80)}`,
    });
    expect(slug).toBe(`a-b-${"x".repeat(56)}`);
    expect(slug.length).toBe(60);
  });
});

describe("isDedicatedFeatureBranch", () => {
  it.each([
    ["main", "origin/main", "main", false],
    ["master", "origin/main", "master", false],
    ["origin/main", "main", "main", false],
    ["origin/master", "main", "master", false],
    ["refs/heads/main", "origin/main", "main", false],
    ["release/1.0", "release/1.0", "main", false],
    ["main", "origin/main", "feature/current", false],
    ["feat/x", "main", "main", true],
    ["phronia/10-28-a", "origin/main", "main", true],
    ["", "main", "main", false],
  ])(
    "branch %s with integration %s and main %s -> %s",
    (branch, integration, currentMain, expected) => {
      expect(isDedicatedFeatureBranch(branch, integration, currentMain)).toBe(
        expected,
      );
    },
  );

  it("treats a missing branch as non-dedicated", () => {
    expect(isDedicatedFeatureBranch(null, "main", "main")).toBe(false);
    expect(isDedicatedFeatureBranch(undefined, "main", "main")).toBe(false);
  });
});
