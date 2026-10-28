import { describe, expect, it } from "vitest";
import {
  evaluateDispatch,
  requiresIsolation,
  type DispatchCode,
  type DispatchFacts,
  type TaskFacts,
} from "../../src/task/index.js";

const LEAF: TaskFacts = {
  ref: ".phronia/tasks/10-28-leaf",
  id: "10-28-leaf",
  status: "in_progress",
  parent: null,
  children: [],
  branch: "phronia/10-28-leaf",
  parallel: { worktree: "auto", exclusive: false, dependsOn: [] },
};

const CHILD: TaskFacts = {
  ...LEAF,
  ref: ".phronia/tasks/10-28-child",
  id: "10-28-child",
  parent: ".phronia/tasks/10-28-parent",
};

const PARENT: TaskFacts = {
  ...LEAF,
  ref: ".phronia/tasks/10-28-parent",
  id: "10-28-parent",
  children: [CHILD.ref, ".phronia/tasks/10-28-sibling"],
};

const OTHER: TaskFacts = {
  ...LEAF,
  ref: ".phronia/tasks/10-28-other",
  id: "10-28-other",
  parent: ".phronia/tasks/10-28-other-parent",
};

function facts(overrides: Partial<DispatchFacts> = {}): DispatchFacts {
  const claim = {
    taskRef: LEAF.ref,
    ownerRef: "task:leaf",
    sessionKey: "session-1",
    stale: false,
    heartbeatAt: "2026-10-28T00:00:00.000Z",
  } as const;
  return {
    platform: {
      id: "claude-code",
      hookPolicy: "block",
      subagentWorkspace: "per-task",
    },
    agent: "mutating",
    enforce: "block",
    activeTaskRef: LEAF.ref,
    requestedTaskRef: null,
    effectiveTask: LEAF,
    checkout: {
      root: "/repo",
      mainRoot: "/repo",
      isLinkedWorktree: false,
      branch: "main",
      registeredTaskRef: null,
      mainDirty: false,
    },
    workspace: { taskWorktree: null, taskBranch: null },
    claim,
    lease: null,
    siblings: null,
    factsReliable: true,
    sessionKey: "session-1",
    ...overrides,
  };
}

function linkedFacts(overrides: Partial<DispatchFacts> = {}): DispatchFacts {
  const root = "/repo/.phronia/worktrees/10-28-leaf";
  return facts({
    checkout: {
      root,
      mainRoot: "/repo",
      isLinkedWorktree: true,
      branch: "phronia/10-28-leaf",
      registeredTaskRef: LEAF.ref,
      mainDirty: true,
    },
    workspace: { taskWorktree: root, taskBranch: "phronia/10-28-leaf" },
    claim: null,
    ...overrides,
  });
}

interface Case {
  readonly name: string;
  readonly facts: DispatchFacts;
  readonly code: DispatchCode;
  readonly decision: "allow" | "block";
  readonly guard: boolean;
}

const CASES: readonly Case[] = [
  {
    name: "read-only agent is outside the contract",
    facts: facts({ agent: "read-only" }),
    code: "DISPATCH_OUTSIDE_CONTRACT",
    decision: "allow",
    guard: false,
  },
  {
    name: "no effective task degrades to no-active-task",
    facts: facts({ activeTaskRef: null, effectiveTask: null }),
    code: "DISPATCH_NO_ACTIVE_TASK",
    decision: "allow",
    guard: false,
  },
  {
    name: "explicit task outside the active task's subtree",
    facts: facts({
      activeTaskRef: PARENT.ref,
      requestedTaskRef: OTHER.ref,
      effectiveTask: OTHER,
    }),
    code: "DISPATCH_TASK_NOT_CHILD",
    decision: "block",
    guard: false,
  },
  {
    name: "parent task is a container, never an implementation target",
    facts: facts({
      activeTaskRef: PARENT.ref,
      effectiveTask: PARENT,
    }),
    code: "DISPATCH_PARENT_TASK",
    decision: "block",
    guard: false,
  },
  {
    name: "planning task cannot be implemented",
    facts: facts({
      effectiveTask: { ...LEAF, status: "planning" },
    }),
    code: "DISPATCH_TASK_NOT_IN_PROGRESS",
    decision: "block",
    guard: false,
  },
  {
    name: "linked worktree registered to another task",
    facts: linkedFacts({
      checkout: {
        root: "/repo/.phronia/worktrees/10-28-other",
        mainRoot: "/repo",
        isLinkedWorktree: true,
        branch: "phronia/10-28-other",
        registeredTaskRef: OTHER.ref,
        mainDirty: true,
      },
    }),
    code: "DISPATCH_CHECKOUT_OWNED_BY_OTHER",
    decision: "block",
    guard: false,
  },
  {
    name: "linked worktree with no registry entry",
    facts: linkedFacts({
      checkout: {
        root: "/repo/.phronia/worktrees/10-28-leaf",
        mainRoot: "/repo",
        isLinkedWorktree: true,
        branch: "phronia/10-28-leaf",
        registeredTaskRef: null,
        mainDirty: true,
      },
      workspace: { taskWorktree: null, taskBranch: null },
    }),
    code: "DISPATCH_CHECKOUT_UNREGISTERED",
    decision: "allow",
    guard: true,
  },
  {
    name: "task has a worktree but the session is in main",
    facts: facts({
      workspace: {
        taskWorktree: "/repo/.phronia/worktrees/10-28-leaf",
        taskBranch: "phronia/10-28-leaf",
      },
    }),
    code: "DISPATCH_WRONG_CHECKOUT",
    decision: "block",
    guard: false,
  },
  {
    name: "isolation is required but worktree=never",
    facts: facts({
      siblings: { total: 3, inProgress: 2, planning: 1 },
      effectiveTask: {
        ...LEAF,
        parallel: { worktree: "never", exclusive: false, dependsOn: [] },
      },
    }),
    code: "DISPATCH_ISOLATION_DISABLED",
    decision: "allow",
    guard: true,
  },
  {
    name: "two in-progress siblings cannot share main",
    facts: facts({
      siblings: { total: 3, inProgress: 2, planning: 1 },
    }),
    code: "DISPATCH_ISOLATION_REQUIRED",
    decision: "block",
    guard: false,
  },
  {
    name: "main checkout claimed by another task",
    facts: facts({
      claim: {
        taskRef: OTHER.ref,
        ownerRef: "task:other",
        sessionKey: "session-2",
        stale: false,
        heartbeatAt: "2026-10-28T00:00:00.000Z",
      },
    }),
    code: "DISPATCH_MAIN_CLAIMED",
    decision: "block",
    guard: false,
  },
  {
    name: "stale claim with uncommitted main changes",
    facts: facts({
      claim: {
        taskRef: OTHER.ref,
        ownerRef: "task:other",
        sessionKey: "session-2",
        stale: true,
        heartbeatAt: "2026-10-27T00:00:00.000Z",
      },
      checkout: {
        root: "/repo",
        mainRoot: "/repo",
        isLinkedWorktree: false,
        branch: "main",
        registeredTaskRef: null,
        mainDirty: true,
      },
    }),
    code: "DISPATCH_STALE_CLAIM_DIRTY",
    decision: "block",
    guard: false,
  },
  {
    name: "single task with no claim is allowed with a guard",
    facts: facts({ claim: null }),
    code: "DISPATCH_NO_CLAIM",
    decision: "allow",
    guard: true,
  },
  {
    name: "lease held by another live session",
    facts: linkedFacts({
      lease: {
        ownerType: "session",
        ownerId: "session-2",
        sessionKey: "session-2",
        stale: false,
      },
    }),
    code: "DISPATCH_LEASE_OTHER_OWNER",
    decision: "allow",
    guard: true,
  },
  {
    name: "partial facts never block",
    facts: facts({
      checkout: {
        root: "/repo",
        mainRoot: null,
        isLinkedWorktree: false,
        branch: "",
        registeredTaskRef: null,
        mainDirty: null,
      },
      claim: null,
      factsReliable: false,
    }),
    code: "DISPATCH_FACTS_UNRELIABLE",
    decision: "allow",
    guard: true,
  },
  {
    name: "a clean single-task main checkout passes",
    facts: facts(),
    code: "DISPATCH_OK",
    decision: "allow",
    guard: false,
  },
];

const ADJACENT: Readonly<Record<DispatchCode, DispatchFacts>> = {
  DISPATCH_OUTSIDE_CONTRACT: facts({ agent: "mutating" }),
  DISPATCH_NO_ACTIVE_TASK: facts(),
  DISPATCH_TASK_NOT_CHILD: facts({
    activeTaskRef: PARENT.ref,
    requestedTaskRef: CHILD.ref,
    effectiveTask: CHILD,
    claim: {
      taskRef: CHILD.ref,
      ownerRef: "task:child",
      sessionKey: "session-1",
      stale: false,
      heartbeatAt: "2026-10-28T00:00:00.000Z",
    },
  }),
  DISPATCH_PARENT_TASK: facts(),
  DISPATCH_TASK_NOT_IN_PROGRESS: facts(),
  DISPATCH_WRONG_CHECKOUT: facts(),
  DISPATCH_CHECKOUT_OWNED_BY_OTHER: linkedFacts(),
  DISPATCH_ISOLATION_REQUIRED: facts({
    siblings: { total: 2, inProgress: 1, planning: 1 },
  }),
  DISPATCH_MAIN_CLAIMED: facts(),
  DISPATCH_STALE_CLAIM_DIRTY: facts({
    claim: {
      taskRef: OTHER.ref,
      ownerRef: "task:other",
      sessionKey: "session-2",
      stale: true,
      heartbeatAt: "2026-10-27T00:00:00.000Z",
    },
    checkout: {
      root: "/repo",
      mainRoot: "/repo",
      isLinkedWorktree: false,
      branch: "main",
      registeredTaskRef: null,
      mainDirty: false,
    },
  }),
  DISPATCH_NO_CLAIM: facts(),
  DISPATCH_LEASE_OTHER_OWNER: linkedFacts({
    lease: {
      ownerType: "session",
      ownerId: "session-1",
      sessionKey: "session-1",
      stale: false,
    },
  }),
  DISPATCH_ISOLATION_DISABLED: facts({
    siblings: { total: 3, inProgress: 2, planning: 1 },
  }),
  DISPATCH_CHECKOUT_UNREGISTERED: linkedFacts(),
  DISPATCH_PLATFORM_CANNOT_BLOCK: facts(),
  DISPATCH_FACTS_UNRELIABLE: facts(),
  DISPATCH_OK: facts({
    activeTaskRef: PARENT.ref,
    effectiveTask: PARENT,
  }),
};

describe("evaluateDispatch", () => {
  it.each(CASES)("$name → $code", ({ facts: input, code, decision, guard }) => {
    const verdict = evaluateDispatch(input);
    expect(verdict.code).toBe(code);
    expect(verdict.decision).toBe(decision);
    expect(verdict.guard !== null).toBe(guard);
    if (verdict.guard !== null) {
      expect(verdict.guard.code).toBe(code);
      expect(verdict.guard.lines.length).toBeGreaterThan(0);
    }
  });

  it.each(CASES)(
    "$name has an adjacent non-triggering case",
    ({ code }) => {
      const adjacent = ADJACENT[code];
      expect(adjacent, `missing adjacent facts for ${code}`).toBeDefined();
      expect(evaluateDispatch(adjacent).code).not.toBe(code);
    },
  );

  it("locks first-match-wins: parent + not-started + wrong checkout returns only PARENT_TASK", () => {
    const verdict = evaluateDispatch(
      facts({
        activeTaskRef: PARENT.ref,
        effectiveTask: { ...PARENT, status: "planning" },
        workspace: {
          taskWorktree: "/repo/.phronia/worktrees/10-28-parent",
          taskBranch: "phronia/10-28-parent",
        },
        checkout: {
          root: "/repo",
          mainRoot: "/repo",
          isLinkedWorktree: false,
          branch: "main",
          registeredTaskRef: null,
          mainDirty: true,
        },
      }),
    );
    expect(verdict.code).toBe("DISPATCH_PARENT_TASK");
    expect(verdict.decision).toBe("block");
    expect(verdict.next.length).toBe(PARENT.children.length + 1);
  });

  it("does not apply enforce: warn/off still report the factual block", () => {
    for (const enforce of ["warn", "off"] as const) {
      const verdict = evaluateDispatch(
        facts({ enforce, activeTaskRef: PARENT.ref, effectiveTask: PARENT }),
      );
      expect(verdict.code).toBe("DISPATCH_PARENT_TASK");
      expect(verdict.decision).toBe("block");
    }
  });

  it("does not branch on platform: hookPolicy=inject keeps the block decision", () => {
    const verdict = evaluateDispatch(
      facts({
        platform: {
          id: "codex",
          hookPolicy: "inject",
          subagentWorkspace: "inherited",
        },
        activeTaskRef: PARENT.ref,
        effectiveTask: PARENT,
      }),
    );
    expect(verdict.code).toBe("DISPATCH_PARENT_TASK");
    expect(verdict.decision).toBe("block");
  });

  it("never emits PLATFORM_CANNOT_BLOCK; S2 maps it", () => {
    for (const input of CASES.map((item) => item.facts)) {
      expect(evaluateDispatch(input).code).not.toBe(
        "DISPATCH_PLATFORM_CANNOT_BLOCK",
      );
    }
  });

  it("research and unknown agents never block", () => {
    for (const agent of ["read-only", "unknown"] as const) {
      const verdict = evaluateDispatch(
        facts({ agent, activeTaskRef: PARENT.ref, effectiveTask: PARENT }),
      );
      expect(verdict.decision).toBe("allow");
      expect(verdict.code).toBe("DISPATCH_OUTSIDE_CONTRACT");
      expect(verdict.guard).toBeNull();
    }
  });

  it("NO_CLAIM guard contains an executable next command", () => {
    const verdict = evaluateDispatch(facts({ claim: null }));
    expect(verdict.guard?.lines.join("\n")).toContain(
      `phronia task workspace ensure ${LEAF.ref}`,
    );
    expect(verdict.next[0]).toContain("phronia task workspace ensure");
  });

  it("PARENT_TASK next lists every child start command", () => {
    const verdict = evaluateDispatch(
      facts({ activeTaskRef: PARENT.ref, effectiveTask: PARENT }),
    );
    for (const child of PARENT.children) {
      expect(verdict.next.join("\n")).toContain(
        `python3 ./.phronia/scripts/task.py start ${child}`,
      );
    }
  });

  it("prefers WRONG_CHECKOUT over CHECKOUT_UNREGISTERED when the task has a worktree", () => {
    const verdict = evaluateDispatch(
      linkedFacts({
        checkout: {
          root: "/repo/.phronia/worktrees/unregistered",
          mainRoot: "/repo",
          isLinkedWorktree: true,
          branch: "phronia/unregistered",
          registeredTaskRef: null,
          mainDirty: true,
        },
        workspace: {
          taskWorktree: "/repo/.phronia/worktrees/10-28-leaf",
          taskBranch: "phronia/10-28-leaf",
        },
      }),
    );
    expect(verdict.code).toBe("DISPATCH_WRONG_CHECKOUT");
    expect(verdict.decision).toBe("block");
    expect(verdict.guard).toBeNull();
  });

  it("normalizes .phronia and .trellis task refs identically", () => {
    const verdict = evaluateDispatch(
      facts({
        activeTaskRef: ".trellis/tasks/10-28-parent",
        requestedTaskRef: ".trellis/tasks/10-28-child",
        effectiveTask: CHILD,
        claim: {
          taskRef: ".phronia/tasks/10-28-child",
          ownerRef: "task:child",
          sessionKey: "session-1",
          stale: false,
          heartbeatAt: "2026-10-28T00:00:00.000Z",
        },
      }),
    );
    // The legacy `.trellis` prefix must resolve to the same task keys as
    // `.phronia`, so the parent link is recognized across the rename.
    expect(verdict.code).toBe("DISPATCH_OK");
  });

  it("renders a session ownerRef without a duplicated prefix", () => {
    const verdict = evaluateDispatch(
      linkedFacts({
        checkout: {
          root: "/repo/.phronia/worktrees/unregistered",
          mainRoot: "/repo",
          isLinkedWorktree: true,
          branch: "phronia/unregistered",
          registeredTaskRef: null,
          mainDirty: true,
        },
        workspace: { taskWorktree: null, taskBranch: null },
        claim: {
          taskRef: null,
          ownerRef: "session:abc",
          sessionKey: "other",
          stale: false,
          heartbeatAt: "2026-10-28T00:00:00.000Z",
        },
      }),
    );
    const guard = verdict.guard?.lines.join("\n") ?? "";
    expect(verdict.code).toBe("DISPATCH_CHECKOUT_UNREGISTERED");
    expect(guard).toContain("claim: session:abc");
    expect(guard).not.toContain("session session:abc");
  });
});

describe("requiresIsolation", () => {
  it("honors always, exclusive, and two in-progress siblings", () => {
    expect(
      requiresIsolation(
        { ...LEAF, parallel: { ...LEAF.parallel, worktree: "always" } },
        null,
      ),
    ).toBe(true);
    expect(
      requiresIsolation(
        { ...LEAF, parallel: { ...LEAF.parallel, exclusive: true } },
        null,
      ),
    ).toBe(true);
    expect(
      requiresIsolation(LEAF, { total: 3, inProgress: 2, planning: 1 }),
    ).toBe(true);
  });

  it("does not treat a declared footprint as parallel intent", () => {
    expect(requiresIsolation(LEAF, null)).toBe(false);
    expect(requiresIsolation(LEAF, { total: 3, inProgress: 1, planning: 2 })).toBe(
      false,
    );
  });
});
