import { describe, expect, it } from "vitest";

import {
  classifyConflict,
  outcomeForConflict,
  resolveIntegrationMode,
} from "../../src/task/integration/policy.js";
import {
  dequeueTask,
  enqueueTask,
  isQueued,
  normalizeQueue,
  peekQueue,
  queuePosition,
  sortQueue,
} from "../../src/task/integration/queue.js";
import type {
  ConflictInput,
  IntegrationModeContext,
  QueueEntry,
} from "../../src/task/integration/types.js";
import type { Footprint } from "../../src/task/parallel/types.js";

function modeContext(
  overrides: Partial<IntegrationModeContext> = {},
): IntegrationModeContext {
  return {
    hasOrigin: true,
    forgeCliAvailable: true,
    confirm: "auto",
    ...overrides,
  };
}

function declared(...raw: string[]): Footprint {
  return { raw, kind: "declared" };
}

function conflict(overrides: ConflictInput = {}): ConflictInput {
  return { ...overrides };
}

function entry(
  taskRef: string,
  enqueuedAt: string,
  mode: QueueEntry["mode"] = "local",
): QueueEntry {
  return { taskRef, enqueuedAt, mode };
}

describe("resolveIntegrationMode", () => {
  it("lets a task override win over --mode and project config", () => {
    const result = resolveIntegrationMode(
      modeContext({
        taskMode: "remote",
        cliMode: "local",
        projectMode: "local",
      }),
    );
    expect(result.mode).toBe("remote");
    expect(result.source).toBe("task");
    expect(result.shouldAsk).toBe(false);
    expect(result.invalid).toBe(false);
    expect(result.reason).toContain("recorded on the task");
  });

  it("lets --mode win over project config", () => {
    const result = resolveIntegrationMode(
      modeContext({ cliMode: "remote", projectMode: "local" }),
    );
    expect(result.mode).toBe("remote");
    expect(result.source).toBe("cli");
  });

  it("lets project config win over auto detection", () => {
    const result = resolveIntegrationMode(
      modeContext({ projectMode: "local" }),
    );
    expect(result.mode).toBe("local");
    expect(result.source).toBe("project");
  });

  it("detects remote when origin and a forge CLI are available", () => {
    const result = resolveIntegrationMode(modeContext());
    expect(result.mode).toBe("remote");
    expect(result.source).toBe("auto");
    expect(result.reason).toContain("forge CLI available");
  });

  it("still chooses remote with origin but no forge CLI (push only)", () => {
    const result = resolveIntegrationMode(
      modeContext({ forgeCliAvailable: false }),
    );
    expect(result.mode).toBe("remote");
    expect(result.reason).toContain("push only");
  });

  it("chooses local when there is no origin", () => {
    const result = resolveIntegrationMode(
      modeContext({ hasOrigin: false, forgeCliAvailable: false }),
    );
    expect(result.mode).toBe("local");
    expect(result.reason).toContain("no origin");
    expect(result.shouldAsk).toBe(false);
  });

  it("asks once under confirm=auto when both modes are viable", () => {
    const result = resolveIntegrationMode(modeContext({ confirm: "auto" }));
    expect(result.alternatives).toEqual(["local", "remote"]);
    expect(result.shouldAsk).toBe(true);
  });

  it("never asks once a mode is recorded on the task", () => {
    const result = resolveIntegrationMode(
      modeContext({ taskMode: "remote", confirm: "auto" }),
    );
    expect(result.shouldAsk).toBe(false);
  });

  it("asks under confirm=always for an unrecorded auto decision", () => {
    const result = resolveIntegrationMode(modeContext({ confirm: "always" }));
    expect(result.shouldAsk).toBe(true);
  });

  it("never asks under confirm=never", () => {
    const result = resolveIntegrationMode(modeContext({ confirm: "never" }));
    expect(result.shouldAsk).toBe(false);
  });

  it("rejects remote integration for a task using the main checkout", () => {
    const result = resolveIntegrationMode(
      modeContext({ taskUsesMain: true, cliMode: "remote" }),
    );
    expect(result.mode).toBe("local");
    expect(result.invalid).toBe(true);
    expect(result.diagnostics[0]?.code).toBe("INTEGRATE_MODE_INVALID");
  });

  it("rejects --mode remote when there is no origin", () => {
    const result = resolveIntegrationMode(
      modeContext({
        hasOrigin: false,
        forgeCliAvailable: false,
        cliMode: "remote",
      }),
    );
    expect(result.mode).toBe("local");
    expect(result.invalid).toBe(true);
    expect(result.diagnostics[0]?.code).toBe(
      "INTEGRATE_REMOTE_UNAVAILABLE",
    );
  });

  it("does not ask when only local is viable", () => {
    const result = resolveIntegrationMode(
      modeContext({ hasOrigin: false, confirm: "auto" }),
    );
    expect(result.alternatives).toEqual(["local"]);
    expect(result.shouldAsk).toBe(false);
  });
});

describe("classifyConflict", () => {
  it("classifies an all-generated conflict set as generated", () => {
    const result = classifyConflict(
      conflict({ conflictFiles: ["pnpm-lock.yaml"] }),
    );
    expect(result.kind).toBe("generated");
    expect(result.files).toEqual(["pnpm-lock.yaml"]);
    expect(result.next).toContain("regenerate");
  });

  it("classifies add/add as duplicate and keeps both paths", () => {
    const result = classifyConflict(
      conflict({
        conflictFiles: ["src/a.ts"],
        addAddFiles: ["src/a.ts"],
      }),
    );
    expect(result.kind).toBe("duplicate");
    expect(result.files).toEqual(["src/a.ts"]);
    expect(result.next).toContain("choose one implementation");
  });

  it("classifies a clean rebase with failed verification as semantic", () => {
    const result = classifyConflict(
      conflict({ verificationFailed: true }),
    );
    expect(result.kind).toBe("semantic");
    expect(result.files).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("INTEGRATE_VERIFY_FAILED");
  });

  it("classifies a moved integration branch as race", () => {
    const result = classifyConflict(conflict({ baseMoved: true }));
    expect(result.kind).toBe("race");
    expect(result.diagnostics[0]?.code).toBe("INTEGRATE_BASE_MOVED");
  });

  it("classifies small conflicts inside the footprint as mechanical", () => {
    const result = classifyConflict(
      conflict({
        conflictFiles: ["src/a.ts", "src/b.ts"],
        footprint: declared("src/**"),
      }),
    );
    expect(result.kind).toBe("mechanical");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.next).toContain("task worktree");
  });

  it("routes always-serial shared files to a human even when inside the footprint", () => {
    const result = classifyConflict(
      conflict({
        conflictFiles: ["docs/requirements.md"],
        alwaysSerialPatterns: ["docs/requirements.md"],
        footprint: declared("docs/requirements.md"),
      }),
    );
    expect(result.kind).toBe("needs_human");
    expect(result.reason).toContain("docs/requirements.md");
  });

  it("routes conflicts outside the footprint to a human", () => {
    const result = classifyConflict(
      conflict({
        conflictFiles: ["src/other.ts"],
        footprint: declared("src/a/**"),
      }),
    );
    expect(result.kind).toBe("needs_human");
    expect(result.reason).toContain("outside the task footprint");
  });

  it("routes too many conflicting files to a human", () => {
    const files = ["a", "b", "c", "d"].map((name) => `src/${name}.ts`);
    const result = classifyConflict(
      conflict({
        conflictFiles: files,
        footprint: declared("src/**"),
        mechanicalMaxFiles: 3,
      }),
    );
    expect(result.kind).toBe("needs_human");
    expect(result.reason).toContain("too many");
  });

  it("prefers generated over duplicate when every conflict is generated", () => {
    const result = classifyConflict(
      conflict({
        conflictFiles: ["dist/bundle.js"],
        addAddFiles: ["dist/bundle.js"],
      }),
    );
    expect(result.kind).toBe("generated");
  });

  it("does not call a mixed generated/literal conflict set generated", () => {
    const result = classifyConflict(
      conflict({
        conflictFiles: ["dist/bundle.js", "src/a.ts"],
        footprint: declared("**"),
        generatedPatterns: ["**/dist/**"],
      }),
    );
    expect(result.kind).not.toBe("generated");
  });

  it("falls back to needs_human when no conflict signal is provided", () => {
    const result = classifyConflict(conflict());
    expect(result.kind).toBe("needs_human");
  });

  it("normalizes duplicate file paths", () => {
    const result = classifyConflict(
      conflict({
        conflictFiles: ["src/a.ts", "src/a.ts", " src/b.ts "],
        footprint: declared("src/**"),
      }),
    );
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("outcomeForConflict", () => {
  it("INT-02: a verification failure is blocked, not landed", () => {
    const classification = classifyConflict(
      conflict({ verificationFailed: true }),
    );
    expect(classification.kind).toBe("semantic");
    expect(outcomeForConflict(classification.kind)).toBe("blocked");
  });

  it("INT-03: a verification failure with --handoff needs a human", () => {
    const classification = classifyConflict(
      conflict({ verificationFailed: true }),
    );
    expect(outcomeForConflict(classification.kind, { handoff: true })).toBe(
      "needs_human",
    );
  });

  it("maps duplicate and shared-contract conflicts to needs_human", () => {
    expect(outcomeForConflict("duplicate")).toBe("needs_human");
    expect(outcomeForConflict("needs_human")).toBe("needs_human");
  });

  it("maps generated, mechanical, and race conflicts to blocked", () => {
    expect(outcomeForConflict("generated")).toBe("blocked");
    expect(outcomeForConflict("mechanical")).toBe("blocked");
    expect(outcomeForConflict("race")).toBe("blocked");
  });
});

describe("integration queue", () => {
  it("sorts FIFO by enqueuedAt and breaks ties by taskRef", () => {
    const queue = [
      entry("c", "2026-10-28T10:03:00Z"),
      entry("a", "2026-10-28T10:01:00Z"),
      entry("b", "2026-10-28T10:01:00Z"),
    ];
    expect(sortQueue(queue).map((item) => item.taskRef)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // Input is not mutated.
    expect(queue[0]?.taskRef).toBe("c");
  });

  it("treats invalid timestamps as newest", () => {
    const queue = [
      entry("bad", "not-a-date"),
      entry("old", "2026-10-28T10:00:00Z"),
    ];
    expect(sortQueue(queue).map((item) => item.taskRef)).toEqual([
      "old",
      "bad",
    ]);
  });

  it("is idempotent when a task is already queued", () => {
    const first = enqueueTask(
      [],
      entry("a", "2026-10-28T10:05:00Z"),
    );
    expect(first.added).toBe(true);
    const second = enqueueTask(
      first.queue,
      entry("a", "2026-10-28T10:09:00Z", "remote"),
    );
    expect(second.added).toBe(false);
    expect(second.entry.enqueuedAt).toBe("2026-10-28T10:05:00Z");
    expect(second.entry.mode).toBe("local");
    expect(second.queue).toHaveLength(1);
  });

  it("dequeues by taskRef", () => {
    const queue = [
      entry("a", "2026-10-28T10:00:00Z"),
      entry("b", "2026-10-28T10:01:00Z"),
    ];
    const result = dequeueTask(queue, "a");
    expect(result.entry?.taskRef).toBe("a");
    expect(result.queue.map((item) => item.taskRef)).toEqual(["b"]);
  });

  it("returns null when dequeuing a task that is not queued", () => {
    const result = dequeueTask(
      [entry("a", "2026-10-28T10:00:00Z")],
      "missing",
    );
    expect(result.entry).toBeNull();
    expect(result.queue.map((item) => item.taskRef)).toEqual(["a"]);
  });

  it("reports zero-based queue positions", () => {
    const queue = [
      entry("b", "2026-10-28T10:02:00Z"),
      entry("a", "2026-10-28T10:01:00Z"),
    ];
    expect(queuePosition(queue, "a")).toBe(0);
    expect(queuePosition(queue, "b")).toBe(1);
    expect(queuePosition(queue, "missing")).toBeNull();
    expect(isQueued(queue, "a")).toBe(true);
    expect(isQueued(queue, "missing")).toBe(false);
  });

  it("peeks at the oldest entry", () => {
    const queue = [
      entry("b", "2026-10-28T10:02:00Z"),
      entry("a", "2026-10-28T10:01:00Z"),
    ];
    expect(peekQueue(queue)?.taskRef).toBe("a");
    expect(peekQueue([])).toBeNull();
  });

  it("normalizes a queue by keeping the earliest entry per task", () => {
    const queue = [
      entry("a", "2026-10-28T10:05:00Z"),
      entry("a", "2026-10-28T10:01:00Z"),
      entry("b", "2026-10-28T10:02:00Z"),
    ];
    expect(normalizeQueue(queue).map((item) => item.enqueuedAt)).toEqual([
      "2026-10-28T10:01:00Z",
      "2026-10-28T10:02:00Z",
    ]);
  });
});
