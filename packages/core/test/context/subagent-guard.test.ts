import { describe, expect, it } from "vitest";
import {
  applyEnforcement,
  renderDenyReason,
  renderGuard,
} from "../../src/context/subagent/guard.js";
import type { DispatchVerdict } from "../../src/task/dispatch/types.js";

function blockVerdict(
  overrides: Partial<DispatchVerdict> = {},
): DispatchVerdict {
  return {
    decision: "block",
    code: "DISPATCH_PARENT_TASK",
    severity: "error",
    reason: "parent task has children",
    next: [
      "python3 ./.phronia/scripts/task.py start .phronia/tasks/10-28-child",
      "re-dispatch implement with Active task: .phronia/tasks/10-28-child",
    ],
    details: {
      effectiveTask: ".phronia/tasks/10-28-parent",
      status: "in_progress",
      activeTask: ".phronia/tasks/10-28-parent",
      checkout: { root: "/repo", isLinkedWorktree: false },
      claim: null,
      lease: null,
      siblings: { total: 2, inProgress: 0, planning: 2 },
    },
    guard: null,
    ...overrides,
  };
}

function allowVerdict(
  code: DispatchVerdict["code"],
  withGuard: boolean,
): DispatchVerdict {
  return {
    decision: "allow",
    code,
    severity: "warn",
    reason: "main is unclaimed",
    next: ["phronia task workspace ensure .phronia/tasks/x"],
    details: {},
    guard: withGuard
      ? {
          code,
          severity: "warn",
          lines: ["task: .phronia/tasks/x (in_progress)", "risk: main is unclaimed"],
        }
      : null,
  };
}

describe("dispatch enforcement", () => {
  it("denies a blocked dispatch on a platform that can block", () => {
    const result = applyEnforcement(blockVerdict(), {
      hookPolicy: "block",
      enforce: "block",
      platformId: "zcode",
    });
    expect(result.guard).toBeUndefined();
    expect(result.deny).toMatchObject({
      op: "deny",
      code: "DISPATCH_PARENT_TASK",
      reason: "parent task has children",
    });
    expect(result.deny?.next).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
  });

  it("downgrades a block to an error guard when enforce=warn", () => {
    const result = applyEnforcement(blockVerdict(), {
      hookPolicy: "block",
      enforce: "warn",
      platformId: "zcode",
    });
    expect(result.deny).toBeUndefined();
    expect(result.guard?.code).toBe("DISPATCH_PARENT_TASK");
    expect(result.guard?.severity).toBe("error");
    expect(result.guard?.lines.join("\n")).toContain(
      "enforcement: parallel.dispatch.enforce=warn",
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "DISPATCH_ENFORCE_WARN",
    ]);
  });

  it("allows silently when enforce=off but records that admission is disabled", () => {
    const result = applyEnforcement(blockVerdict(), {
      hookPolicy: "block",
      enforce: "off",
      platformId: "zcode",
    });
    expect(result.deny).toBeUndefined();
    expect(result.guard).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "DISPATCH_ENFORCE_OFF",
    ]);
    expect(result.diagnostics[0]?.message).toContain("admission disabled");
  });

  it("also suppresses an allow-time guard when enforce=off", () => {
    const result = applyEnforcement(allowVerdict("DISPATCH_NO_CLAIM", true), {
      hookPolicy: "block",
      enforce: "off",
    });
    expect(result.guard).toBeUndefined();
    expect(result.deny).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "DISPATCH_ENFORCE_OFF",
    ]);
  });

  for (const hookPolicy of ["inject", "unknown"] as const) {
    it(`turns a block into a STOP guard when hookPolicy=${hookPolicy}`, () => {
      const result = applyEnforcement(blockVerdict(), {
        hookPolicy,
        enforce: "block",
        platformId: "codex",
        subagentWorkspace: "inherited",
      });
      expect(result.deny).toBeUndefined();
      expect(result.guard?.code).toBe("DISPATCH_PARENT_TASK");
      expect(result.guard?.severity).toBe("error");
      expect(result.guard?.lines[0]).toBe(
        "STOP: do not edit any file until the workspace contract is satisfied.",
      );
      const text = result.guard?.lines.join("\n") ?? "";
      expect(text).toContain("task: .phronia/tasks/10-28-parent (in_progress)");
      expect(text).toContain("claim: none");
      expect(text).toContain(
        "platform: codex (hookPolicy=" + hookPolicy + ", subagentWorkspace=inherited)",
      );
      expect(text).toContain("this harness cannot block the dispatch");
      expect(result.diagnostics.map((item) => item.code)).toEqual([
        "DISPATCH_PLATFORM_CANNOT_BLOCK",
      ]);
    });
  }

  it("passes an allow-time guard through with warn severity", () => {
    const result = applyEnforcement(allowVerdict("DISPATCH_NO_CLAIM", true), {
      hookPolicy: "block",
      enforce: "block",
    });
    expect(result.deny).toBeUndefined();
    expect(result.guard?.code).toBe("DISPATCH_NO_CLAIM");
    expect(result.guard?.severity).toBe("warn");
    expect(result.diagnostics).toEqual([]);
  });

  for (const code of [
    "DISPATCH_NO_ACTIVE_TASK",
    "DISPATCH_OUTSIDE_CONTRACT",
  ] as const) {
    it(`never emits a guard for ${code}`, () => {
      const result = applyEnforcement(allowVerdict(code, true), {
        hookPolicy: "block",
        enforce: "warn",
      });
      expect(result.guard).toBeUndefined();
      expect(result.deny).toBeUndefined();
    });
  }
});

describe("guard rendering", () => {
  it("wraps lines in the workspace-guard envelope", () => {
    expect(
      renderGuard({
        code: "DISPATCH_NO_CLAIM",
        severity: "warn",
        lines: ["claim: none"],
      }),
    ).toBe(
      [
        '<workspace-guard code="DISPATCH_NO_CLAIM" severity="warn">',
        "claim: none",
        "</workspace-guard>",
      ].join("\n"),
    );
  });

  it("renders a self-contained deny reason with next steps", () => {
    const reason = renderDenyReason(blockVerdict());
    expect(reason).toBe(
      [
        "DISPATCH_PARENT_TASK: parent task has children",
        "Next:",
        "1. python3 ./.phronia/scripts/task.py start .phronia/tasks/10-28-child",
        "2. re-dispatch implement with Active task: .phronia/tasks/10-28-child",
        "Do not retry; report this exactly.",
      ].join("\n"),
    );
  });

  it("omits the Next block when there is nothing actionable", () => {
    expect(
      renderDenyReason(blockVerdict({ next: [] })),
    ).toBe(
      "DISPATCH_PARENT_TASK: parent task has children\nDo not retry; report this exactly.",
    );
  });
});
