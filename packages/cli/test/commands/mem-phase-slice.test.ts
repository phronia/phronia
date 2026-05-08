/**
 * Tests for `tl mem extract --phase` (brainstorm window slicing).
 *
 * The MVP definition (PRD 05-08-mem-phase-slice):
 *   brainstorm window = [task.py create, task.py start)
 *
 * Boundary signals are recovered from raw Claude JSONL `tool_use` blocks
 * (which `claudeExtractDialogue` discards), so the implementation does its
 * own pass with `collectClaudeTurnsAndEvents` and produces both cleaned
 * turns + task.py event metadata.
 *
 * Test coverage:
 *   - `parseTaskPyCommand`: invoker variants (python/python3/py -3/none),
 *     path separators (/, \, \\), false-positive guard against flag values
 *   - `buildBrainstormWindows`: single window, multi window, slug pairing,
 *     missing create / missing start, malformed (start before create)
 *   - End-to-end via `collectClaudeTurnsAndEvents` against synthetic JSONL
 *     fixtures (mocked $HOME pattern from mem-platforms.test.ts)
 */

import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

const { fakeHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const f = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("node:path") as typeof import("node:path");
  const fakeHome = f.mkdtempSync(p.join(o.tmpdir(), "trellis-mem-phase-"));
  return { fakeHome };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

const {
  parseTaskPyCommand,
  parseTaskPyCommandsAll,
  buildBrainstormWindows,
  collectClaudeTurnsAndEvents,
} = await import("../../src/commands/mem.js");
import type { TaskPyEvent } from "../../src/commands/mem.js";

afterAll(() => {
  nodeFs.rmSync(fakeHome, { recursive: true, force: true });
});

// =============================================================================
// parseTaskPyCommand — invoker / path-separator variants + false-positive guard
// =============================================================================

describe("parseTaskPyCommand", () => {
  it("returns null for empty / non-string input", () => {
    expect(parseTaskPyCommand("")).toBeNull();
    expect(parseTaskPyCommand("ls")).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(parseTaskPyCommand(undefined)).toBeNull();
  });

  it("matches `python ./.trellis/scripts/task.py create \"foo\"`", () => {
    const r = parseTaskPyCommand(
      'python ./.trellis/scripts/task.py create "fix bug"',
    );
    expect(r).toEqual({
      action: "create",
      slug: undefined,
      titleArg: "fix bug",
    });
  });

  it("matches `python3 ./.trellis/scripts/task.py create ...`", () => {
    const r = parseTaskPyCommand(
      "python3 ./.trellis/scripts/task.py create my-task",
    );
    expect(r?.action).toBe("create");
  });

  it("matches `py -3 .trellis/scripts/task.py create ...` (Windows launcher)", () => {
    const r = parseTaskPyCommand("py -3 .trellis/scripts/task.py create foo");
    expect(r?.action).toBe("create");
  });

  it("matches Windows backslash path (single)", () => {
    const r = parseTaskPyCommand(
      "python3 .trellis\\scripts\\task.py start .trellis\\tasks\\05-08-foo",
    );
    expect(r).toEqual({
      action: "start",
      taskDir: ".trellis\\tasks\\05-08-foo",
    });
  });

  it("matches Windows backslash path (double — JSONL re-escape)", () => {
    const r = parseTaskPyCommand(
      "python3 .trellis\\\\scripts\\\\task.py create my-task",
    );
    expect(r?.action).toBe("create");
  });

  it("matches `task.py start` with no invoker prefix", () => {
    const r = parseTaskPyCommand("task.py start .trellis/tasks/05-08-foo/");
    expect(r).toEqual({
      action: "start",
      taskDir: ".trellis/tasks/05-08-foo/",
    });
  });

  it("matches absolute path", () => {
    const r = parseTaskPyCommand(
      "python3 /Users/me/proj/.trellis/scripts/task.py create new-thing",
    );
    expect(r?.action).toBe("create");
  });

  it("captures --slug FOO flag value", () => {
    const r = parseTaskPyCommand(
      'python3 .trellis/scripts/task.py create "Title" --slug my-slug',
    );
    expect(r).toMatchObject({ action: "create", slug: "my-slug" });
  });

  it("captures --slug=FOO equals form", () => {
    const r = parseTaskPyCommand(
      "python3 .trellis/scripts/task.py create --slug=my-slug",
    );
    expect(r).toMatchObject({ action: "create", slug: "my-slug" });
  });

  it("does NOT match `--slug task.py-create-foo` (false-positive guard)", () => {
    // task.py-create is embedded inside a flag value, not a real invocation.
    expect(
      parseTaskPyCommand("ls --slug task.py-create-foo"),
    ).toBeNull();
  });

  it("does NOT match arbitrary text containing task.py without verb", () => {
    expect(parseTaskPyCommand("see task.py for details")).toBeNull();
  });

  it("does NOT match `task.py update` (only create/start are signals)", () => {
    expect(
      parseTaskPyCommand("python3 .trellis/scripts/task.py update foo"),
    ).toBeNull();
  });

  it("rejects `task.py-create` (must have whitespace before verb)", () => {
    // Hyphen-joined: not a valid invocation.
    expect(parseTaskPyCommand("task.py-create foo")).toBeNull();
  });
});

// =============================================================================
// buildBrainstormWindows — pairing strategy + fallbacks
// =============================================================================

function ev(
  action: "create" | "start",
  turnIndex: number,
  extra: { slug?: string; taskDir?: string } = {},
): TaskPyEvent {
  return {
    action,
    timestamp: `2026-05-08T00:00:0${turnIndex}Z`,
    turnIndex,
    ...extra,
  };
}

describe("parseTaskPyCommandsAll (dogfood-driven edge cases)", () => {
  it("strips $(...) closing paren from --slug value", () => {
    // Real pattern in scripted brainstorm: TASK_DIR=$(... --slug NAME)
    const all = parseTaskPyCommandsAll(
      'TASK_DIR=$(python3 ./.trellis/scripts/task.py create "fix: tl mem --since drops cross-day sessions" --slug mem-since-cross-day-filter)',
    );
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      action: "create",
      slug: "mem-since-cross-day-filter",
    });
  });

  it("captures BOTH task.py invocations in one Bash command", () => {
    // SMOKE_TASK pattern: create + start in a single one-liner.
    const cmd =
      'SMOKE_TASK=$(python3 ./.trellis/scripts/task.py create "smoke" 2>&1); python3 ./.trellis/scripts/task.py start ".trellis/tasks/$SMOKE_TASK" 2>&1 | tail -3';
    const all = parseTaskPyCommandsAll(cmd);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ action: "create" });
    expect(all[1]).toMatchObject({ action: "start" });
    if (all[1] && all[1].action === "start") {
      // Quoted arg with $ var inside — should not be dropped.
      expect(all[1].taskDir).toContain("$SMOKE_TASK");
    }
  });

  it("rejects prose-embedded matches (heredoc / commit-message text)", () => {
    // From a real commit message: "task.py start exits with hint to set X"
    const cmd =
      'git commit -m "Previous text said `.current-task` is a CLI fallback. Current code never writes that file — task.py start exits with hint to set TRELLIS_CONTEXT_ID."';
    const all = parseTaskPyCommandsAll(cmd);
    expect(all).toEqual([]);
  });

  it("rejects empty restRaw (no positional, just trailing whitespace)", () => {
    const all = parseTaskPyCommandsAll("python3 ./scripts/task.py start  ");
    expect(all).toEqual([]);
  });

  it("does not match action embedded in flag value (--something=task.py-create-foo)", () => {
    expect(
      parseTaskPyCommandsAll("foo --bar=task.py-create-baz xyz"),
    ).toEqual([]);
  });
});

describe("slugFromTaskDir (dogfood-driven)", () => {
  // slugFromTaskDir is internal; we verify it via buildBrainstormWindows
  // pairing: a `create --slug FOO` should match `start .trellis/tasks/05-08-FOO`
  // (i.e., the MM-DD- prefix on the start side is stripped before comparison).
  it("pairs --slug FOO with start .trellis/tasks/MM-DD-FOO via prefix strip", () => {
    const events: TaskPyEvent[] = [
      {
        action: "create",
        timestamp: "2026-05-08T00:00:05Z",
        turnIndex: 5,
        slug: "mem-fix",
      },
      {
        action: "start",
        timestamp: "2026-05-08T00:00:10Z",
        turnIndex: 10,
        taskDir: ".trellis/tasks/05-08-mem-fix",
      },
    ];
    const ws = buildBrainstormWindows(events, 20);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      label: "mem-fix",
      startTurn: 5,
      endTurn: 10,
    });
  });
});

describe("buildBrainstormWindows", () => {
  it("returns [] when there are no events", () => {
    expect(buildBrainstormWindows([], 10)).toEqual([]);
  });

  it("pairs a single create→start in order", () => {
    const events = [ev("create", 2, { slug: "foo" }), ev("start", 8)];
    expect(buildBrainstormWindows(events, 12)).toEqual([
      { label: "foo", startTurn: 2, endTurn: 8 },
    ]);
  });

  it("pairs multi-task FIFO when slugs are missing", () => {
    const events = [
      ev("create", 1),
      ev("start", 3, { taskDir: ".trellis/tasks/aaa" }),
      ev("create", 5),
      ev("start", 9, { taskDir: ".trellis/tasks/bbb" }),
    ];
    expect(buildBrainstormWindows(events, 12)).toEqual([
      { label: "aaa", startTurn: 1, endTurn: 3 },
      { label: "bbb", startTurn: 5, endTurn: 9 },
    ]);
  });

  it("prefers slug match over FIFO order", () => {
    // Two creates with explicit slugs, two starts — slug pairing should
    // align even when starts are out of order.
    const events = [
      ev("create", 1, { slug: "aaa" }),
      ev("create", 2, { slug: "bbb" }),
      ev("start", 5, { taskDir: ".trellis/tasks/bbb" }),
      ev("start", 6, { taskDir: ".trellis/tasks/aaa" }),
    ];
    const w = buildBrainstormWindows(events, 10);
    // Sorted by startTurn ascending.
    expect(w).toEqual([
      { label: "aaa", startTurn: 1, endTurn: 6 },
      { label: "bbb", startTurn: 2, endTurn: 5 },
    ]);
  });

  it("fallback A: create with no following start → [create, totalTurns)", () => {
    const events = [ev("create", 4, { slug: "interrupted" })];
    expect(buildBrainstormWindows(events, 12)).toEqual([
      { label: "interrupted", startTurn: 4, endTurn: 12 },
    ]);
  });

  it("fallback B: start with no preceding create → [0, start)", () => {
    const events = [ev("start", 7, { taskDir: ".trellis/tasks/earlier" })];
    expect(buildBrainstormWindows(events, 12)).toEqual([
      { label: "earlier", startTurn: 0, endTurn: 7 },
    ]);
  });

  it("skips malformed window where start.turnIndex < create.turnIndex (event order quirk)", () => {
    // Slug match would pair them, but turn indices are reversed → guard skips.
    const events = [
      ev("create", 8, { slug: "weird" }),
      ev("start", 3, { taskDir: ".trellis/tasks/weird" }),
    ];
    expect(buildBrainstormWindows(events, 10)).toEqual([]);
  });

  it("uses window-N label when neither create.slug nor start.taskDir resolve", () => {
    const events = [ev("create", 1), ev("start", 5)];
    expect(buildBrainstormWindows(events, 10)).toEqual([
      { label: "window-1", startTurn: 1, endTurn: 5 },
    ]);
  });
});

// =============================================================================
// collectClaudeTurnsAndEvents — end-to-end raw JSONL → turns + events
// =============================================================================

const CLAUDE_PROJECTS = nodePath.join(fakeHome, ".claude", "projects");

function writeJsonl(file: string, lines: readonly unknown[]): void {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(
    file,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function rimraf(p: string): void {
  nodeFs.rmSync(p, { recursive: true, force: true });
}

describe("collectClaudeTurnsAndEvents", () => {
  const projectCwd = "/tmp/phase-slice";
  const projectDir = nodePath.join(
    CLAUDE_PROJECTS,
    projectCwd.replace(/[/_]/g, "-"),
  );

  afterEach(() => {
    rimraf(CLAUDE_PROJECTS);
  });

  function buildSession(
    sessionId: string,
    events: readonly Record<string, unknown>[],
  ): {
    platform: "claude";
    id: string;
    filePath: string;
  } {
    nodeFs.mkdirSync(projectDir, { recursive: true });
    const file = nodePath.join(projectDir, `${sessionId}.jsonl`);
    writeJsonl(file, events);
    return { platform: "claude", id: sessionId, filePath: file };
  }

  it("captures task.py create + start events with correct turnIndex", () => {
    const s = buildSession("session-a", [
      // turn 0: user
      {
        type: "user",
        timestamp: "2026-05-08T00:00:00Z",
        cwd: projectCwd,
        message: { role: "user", content: "let's brainstorm something" },
      },
      // turn 1: assistant text-only
      {
        type: "assistant",
        timestamp: "2026-05-08T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "OK, what is it?" }],
        },
      },
      // turn 2: user
      {
        type: "user",
        timestamp: "2026-05-08T00:00:02Z",
        message: { role: "user", content: "do task X" },
      },
      // turn 3: assistant with tool_use create — turnIndex captured = 3
      {
        type: "assistant",
        timestamp: "2026-05-08T00:00:03Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "creating the task now" },
            {
              type: "tool_use",
              name: "Bash",
              input: {
                command:
                  'python3 ./.trellis/scripts/task.py create "task X" --slug task-x',
              },
            },
          ],
        },
      },
      // turn 4: user
      {
        type: "user",
        timestamp: "2026-05-08T00:00:04Z",
        message: { role: "user", content: "go" },
      },
      // turn 5: assistant with tool_use start — turnIndex captured = 5
      {
        type: "assistant",
        timestamp: "2026-05-08T00:00:05Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "starting the task" },
            {
              type: "tool_use",
              name: "Bash",
              input: {
                command:
                  "python3 ./.trellis/scripts/task.py start .trellis/tasks/task-x",
              },
            },
          ],
        },
      },
      // turn 6: user
      {
        type: "user",
        timestamp: "2026-05-08T00:00:06Z",
        message: { role: "user", content: "implementing now" },
      },
    ]);

    // SessionInfo only needs filePath/platform/id for collectClaudeTurnsAndEvents.
    const { turns, events } = collectClaudeTurnsAndEvents(
      s as unknown as Parameters<typeof collectClaudeTurnsAndEvents>[0],
    );

    expect(turns.length).toBe(7);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: "create",
      slug: "task-x",
      turnIndex: 3,
    });
    expect(events[1]).toMatchObject({
      action: "start",
      taskDir: ".trellis/tasks/task-x",
      turnIndex: 5,
    });

    const windows = buildBrainstormWindows(events, turns.length);
    expect(windows).toEqual([
      { label: "task-x", startTurn: 3, endTurn: 5 },
    ]);
    // Brainstorm turns at indices 3 and 4: assistant ("creating the task
    // now") + user ("go").
    const brainstorm = turns.slice(3, 5);
    expect(brainstorm.map((t) => t.role)).toEqual(["assistant", "user"]);
    expect(brainstorm[1]?.text).toBe("go");
  });

  it("ignores non-task.py Bash tool_use events", () => {
    const s = buildSession("session-b", [
      {
        type: "user",
        timestamp: "2026-05-08T00:00:00Z",
        cwd: projectCwd,
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant",
        timestamp: "2026-05-08T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running ls" },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
        },
      },
    ]);
    const { events } = collectClaudeTurnsAndEvents(
      s as unknown as Parameters<typeof collectClaudeTurnsAndEvents>[0],
    );
    expect(events).toEqual([]);
  });

  it("survives compaction: turns reset, subsequent task.py events still tracked", () => {
    const s = buildSession("session-c", [
      // pre-compact turns
      {
        type: "user",
        timestamp: "2026-05-08T00:00:00Z",
        cwd: projectCwd,
        message: { role: "user", content: "early talk" },
      },
      {
        type: "assistant",
        timestamp: "2026-05-08T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "early reply" }],
        },
      },
      // compaction event resets turns to a single [compact summary] turn (index 0)
      {
        type: "user",
        timestamp: "2026-05-08T00:00:02Z",
        isCompactSummary: true,
        message: {
          role: "user",
          content: "summarized history",
        },
      },
      // post-compact: turn 1 = user
      {
        type: "user",
        timestamp: "2026-05-08T00:00:03Z",
        message: { role: "user", content: "continuing" },
      },
      // post-compact: turn 2 = assistant with tool_use create — turnIndex = 2
      {
        type: "assistant",
        timestamp: "2026-05-08T00:00:04Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "creating" },
            {
              type: "tool_use",
              name: "Bash",
              input: {
                command:
                  "python3 ./.trellis/scripts/task.py create --slug post-compact",
              },
            },
          ],
        },
      },
    ]);

    const { turns, events } = collectClaudeTurnsAndEvents(
      s as unknown as Parameters<typeof collectClaudeTurnsAndEvents>[0],
    );
    // After compaction: 1 (compact summary) + 2 post-compact = 3 turns.
    expect(turns.length).toBe(3);
    expect(turns[0]?.text.startsWith("[compact summary]")).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "create",
      slug: "post-compact",
      turnIndex: 2,
    });
  });

  it("compaction discards PRE-compact task.py events (turnIndex no longer valid)", () => {
    // A pre-compact `create` would anchor to a turnIndex pointing into the
    // collapsed [compact summary] surface. Pairing it to a post-compact
    // `start` would emit a window referencing dialogue that no longer
    // exists. The collector resets events alongside turns on compaction.
    const s = buildSession("session-d", [
      // turn 0: user
      {
        type: "user",
        timestamp: "2026-05-08T00:00:00Z",
        cwd: projectCwd,
        message: { role: "user", content: "pre-compact talk" },
      },
      // turn 1: assistant with PRE-compact create event (turnIndex=1)
      {
        type: "assistant",
        timestamp: "2026-05-08T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "creating ahead of compact" },
            {
              type: "tool_use",
              name: "Bash",
              input: {
                command:
                  "python3 ./.trellis/scripts/task.py create --slug stale",
              },
            },
          ],
        },
      },
      // compaction wipes the above
      {
        type: "user",
        timestamp: "2026-05-08T00:00:02Z",
        isCompactSummary: true,
        message: { role: "user", content: "summary" },
      },
      // post-compact: turn 1 user
      {
        type: "user",
        timestamp: "2026-05-08T00:00:03Z",
        message: { role: "user", content: "after compact" },
      },
    ]);

    const { events } = collectClaudeTurnsAndEvents(
      s as unknown as Parameters<typeof collectClaudeTurnsAndEvents>[0],
    );
    // The pre-compact create must be gone — pairing it to a post-compact
    // start would silently produce an incorrect window.
    expect(events).toEqual([]);
  });
});
