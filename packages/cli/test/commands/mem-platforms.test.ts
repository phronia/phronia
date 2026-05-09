/**
 * Tier-2 fixture-based tests for the per-platform parsers in mem.ts.
 *
 * mem.ts derives session-store paths from `os.homedir()` at module-load time
 * (`const HOME = os.homedir()`), so we mock node:os via vi.hoisted to point
 * homedir() at a single per-suite tmpdir. The mock ALSO has to preserve the
 * rest of the os module (tmpdir, EOL, ...) because vitest itself uses them.
 *
 * Each test seeds the relevant platform's session directory with minimal
 * fixture files, asserts the parser returns the expected SessionInfo /
 * DialogueTurn shape, and cleans up its own files in afterEach so suites
 * don't leak across each other.
 */

import {
  describe,
  it,
  expect,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

// Hoisted: runs before mem.ts import resolves so the mocked homedir() value
// is in place when mem.ts captures `const HOME = os.homedir()`.
const { fakeHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const f = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("node:path") as typeof import("node:path");
  const fakeHome = f.mkdtempSync(p.join(o.tmpdir(), "trellis-mem-home-"));
  return { fakeHome };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

// Import AFTER the mock is set up. mem.ts now sees fakeHome as $HOME.
//
// OpenCode adapter is exercised inside its own describe block via dynamic
// re-import (so the module-level `opencodeWarned` flag resets per test) —
// hence not destructured here.
const {
  claudeListSessions,
  claudeExtractDialogue,
  claudeSearch,
  codexListSessions,
  codexExtractDialogue,
  codexSearch,
  buildFilter,
} = await import("../../src/commands/mem.js");

// =============================================================================
// shared fixture helpers
// =============================================================================

const CLAUDE_PROJECTS = nodePath.join(fakeHome, ".claude", "projects");
const CODEX_SESSIONS = nodePath.join(fakeHome, ".codex", "sessions");
// OpenCode SQLite path — kept for the degraded-adapter tests, which still
// surface this in SessionInfo.filePath shape assertions even though the
// adapter no longer touches the DB (see "opencode adapter (degraded)" below).
const OC_DB_PATH = nodePath.join(
  fakeHome,
  ".local",
  "share",
  "opencode",
  "opencode.db",
);

function writeJsonl(file: string, lines: readonly unknown[]): void {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(
    file,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function writeJson(file: string, obj: unknown): void {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, JSON.stringify(obj));
}

function rimraf(p: string): void {
  nodeFs.rmSync(p, { recursive: true, force: true });
}

afterAll(() => {
  rimraf(fakeHome);
});

// =============================================================================
// Claude Code adapter
// =============================================================================

describe("claudeListSessions / claudeExtractDialogue", () => {
  // Claude encodes cwd by replacing '/' and '_' with '-'.
  const projectCwd = "/tmp/test-project";
  const encodedCwd = projectCwd.replace(/[/_]/g, "-");
  const projectDir = nodePath.join(CLAUDE_PROJECTS, encodedCwd);
  const sessionId = "11111111-1111-1111-1111-111111111111";
  const sessionFile = nodePath.join(projectDir, `${sessionId}.jsonl`);

  beforeEach(() => {
    nodeFs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rimraf(CLAUDE_PROJECTS);
  });

  it("returns no sessions when ~/.claude/projects/ doesn't exist", () => {
    rimraf(CLAUDE_PROJECTS);
    const r = claudeListSessions(buildFilter({ global: true }));
    expect(r).toEqual([]);
  });

  it("lists a session and reads cwd/timestamp from the first event when index is missing", () => {
    writeJsonl(sessionFile, [
      {
        type: "user",
        cwd: projectCwd,
        timestamp: "2026-04-15T10:00:00Z",
        message: { role: "user", content: "hello" },
      },
    ]);
    const r = claudeListSessions(buildFilter({ global: true }));
    const found = r.find((s) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found?.platform).toBe("claude");
    expect(found?.cwd).toBe(projectCwd);
    expect(found?.created).toBe("2026-04-15T10:00:00Z");
  });

  it("merges sessions-index.json metadata (title, cwd, created)", () => {
    writeJsonl(sessionFile, [
      {
        type: "user",
        message: { role: "user", content: "hi" },
      },
    ]);
    writeJson(nodePath.join(projectDir, "sessions-index.json"), {
      entries: [
        {
          id: sessionId,
          cwd: projectCwd,
          created: "2026-04-15T08:00:00Z",
          title: "fixed bug in foo",
        },
      ],
    });
    const r = claudeListSessions(buildFilter({ global: true }));
    const found = r.find((s) => s.id === sessionId);
    expect(found?.title).toBe("fixed bug in foo");
    expect(found?.cwd).toBe(projectCwd);
  });

  it("filters by --since (excludes sessions whose entire lifetime predates the window)", () => {
    writeJsonl(sessionFile, [
      {
        type: "user",
        cwd: projectCwd,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "old session" },
      },
    ]);
    // mtime must also be old: list filter is interval-overlap, so a fresh
    // mtime (test-run time) would otherwise keep the session in range.
    const oldT = new Date("2026-01-01T00:00:00Z");
    nodeFs.utimesSync(sessionFile, oldT, oldT);
    const r = claudeListSessions(
      buildFilter({ global: true, since: "2026-04-01" }),
    );
    expect(r.find((s) => s.id === sessionId)).toBeUndefined();
  });

  it("scopes to --cwd by encoding cwd to the on-disk dir name", () => {
    writeJsonl(sessionFile, [
      {
        type: "user",
        cwd: projectCwd,
        timestamp: "2026-04-15T10:00:00Z",
        message: { role: "user", content: "x" },
      },
    ]);
    // Other-project session should NOT be visible when we scope to projectCwd.
    const otherEncoded = "/tmp/other".replace(/[/_]/g, "-");
    const otherFile = nodePath.join(
      CLAUDE_PROJECTS,
      otherEncoded,
      "22222222-2222-2222-2222-222222222222.jsonl",
    );
    writeJsonl(otherFile, [
      {
        type: "user",
        cwd: "/tmp/other",
        timestamp: "2026-04-15T10:00:00Z",
        message: { role: "user", content: "x" },
      },
    ]);
    const r = claudeListSessions(buildFilter({ cwd: projectCwd }));
    const ids = r.map((s) => s.id);
    expect(ids).toContain(sessionId);
    expect(ids).not.toContain("22222222-2222-2222-2222-222222222222");
  });

  it("extractDialogue keeps user/assistant text turns and strips injection tags", () => {
    writeJsonl(sessionFile, [
      {
        type: "user",
        cwd: projectCwd,
        timestamp: "2026-04-15T10:00:00Z",
        message: {
          role: "user",
          content:
            "real question<system-reminder>secret</system-reminder> here",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "thinking aloud" },
            { type: "text", text: "real answer" },
            { type: "tool_use", input: { foo: 1 } },
          ],
        },
      },
      // tool_result: user role but content is array → skipped entirely.
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "out" }],
        },
      },
    ]);
    const sessions = claudeListSessions(buildFilter({ global: true }));
    const s = sessions.find((x) => x.id === sessionId);
    expect(s).toBeDefined();
    if (!s) return;
    const turns = claudeExtractDialogue(s);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ role: "user", text: "real question here" });
    expect(turns[1]).toEqual({ role: "assistant", text: "real answer" });
  });

  it("extractDialogue collapses pre-compact turns into a single [compact summary] turn", () => {
    writeJsonl(sessionFile, [
      {
        type: "user",
        cwd: projectCwd,
        timestamp: "2026-04-15T10:00:00Z",
        message: { role: "user", content: "first turn" },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
        },
      },
      {
        type: "user",
        isCompactSummary: true,
        message: {
          role: "user",
          content: "summary of the previous conversation",
        },
      },
      {
        type: "user",
        message: { role: "user", content: "post-compact question" },
      },
    ]);
    const s = claudeListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const turns = claudeExtractDialogue(s);
    // Pre-compact turns dropped; we keep [compact summary] + post-compact turn.
    expect(turns.map((t) => t.text)).toEqual([
      "[compact summary]\nsummary of the previous conversation",
      "post-compact question",
    ]);
  });

  it("drops AGENTS.md preamble turns from the user side", () => {
    writeJsonl(sessionFile, [
      {
        type: "user",
        cwd: projectCwd,
        timestamp: "2026-04-15T10:00:00Z",
        message: {
          // AGENTS.md preamble with no following human-paragraph break:
          // stripInjectionTags consumes the whole thing → cleaned="" → dropped
          // by the outer `if (text)` guard in claudeExtractDialogue.
          role: "user",
          content: "# AGENTS.md instructions for /repo - rules go here",
        },
      },
      {
        type: "user",
        message: { role: "user", content: "actual user question" },
      },
    ]);
    const s = claudeListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const turns = claudeExtractDialogue(s);
    // AGENTS.md turn dropped; only the real question survives.
    expect(turns.map((t) => t.text)).toEqual(["actual user question"]);
  });

  it("returns empty turns array for a session with no parseable content", () => {
    writeJsonl(sessionFile, [
      { type: "user", cwd: projectCwd, timestamp: "2026-04-15T10:00:00Z" },
    ]);
    const s = claudeListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    expect(claudeExtractDialogue(s)).toEqual([]);
  });

  it("claudeSearch counts keyword occurrences across user + assistant turns", () => {
    writeJsonl(sessionFile, [
      {
        type: "user",
        cwd: projectCwd,
        timestamp: "2026-04-15T10:00:00Z",
        message: { role: "user", content: "memory leak in heap" },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the memory subsystem allocates" }],
        },
      },
    ]);
    const s = claudeListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const hit = claudeSearch(s, "memory");
    expect(hit.user_count).toBe(1);
    expect(hit.asst_count).toBe(1);
    expect(hit.count).toBe(2);
  });
});

// =============================================================================
// Codex adapter
// =============================================================================

describe("codexListSessions / codexExtractDialogue", () => {
  const sessionId = "abc-codex-session";
  const projectCwd = "/tmp/codex-project";
  // Codex stores rollout files as rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl
  const fileName = `rollout-2026-04-15T10-00-00-${sessionId}.jsonl`;
  const sessionFile = nodePath.join(
    CODEX_SESSIONS,
    "2026",
    "04",
    "15",
    fileName,
  );

  beforeEach(() => {
    nodeFs.mkdirSync(nodePath.dirname(sessionFile), { recursive: true });
  });

  afterEach(() => {
    rimraf(CODEX_SESSIONS);
  });

  it("returns no sessions when ~/.codex/sessions/ doesn't exist", () => {
    rimraf(CODEX_SESSIONS);
    expect(codexListSessions(buildFilter({ global: true }))).toEqual([]);
  });

  it("lists sessions, picking up cwd from the first payload", () => {
    writeJsonl(sessionFile, [
      {
        timestamp: "2026-04-15T10:00:00Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: projectCwd },
      },
      {
        timestamp: "2026-04-15T10:00:01Z",
        type: "event_msg",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      },
    ]);
    const sessions = codexListSessions(buildFilter({ global: true }));
    const s = sessions.find((x) => x.id === sessionId);
    expect(s).toBeDefined();
    expect(s?.platform).toBe("codex");
    expect(s?.cwd).toBe(projectCwd);
  });

  it("filters codex sessions by --cwd", () => {
    writeJsonl(sessionFile, [
      {
        timestamp: "2026-04-15T10:00:00Z",
        payload: { id: sessionId, cwd: projectCwd },
      },
    ]);
    const otherFile = nodePath.join(
      CODEX_SESSIONS,
      "2026",
      "04",
      "15",
      `rollout-2026-04-15T11-00-00-other.jsonl`,
    );
    writeJsonl(otherFile, [
      {
        timestamp: "2026-04-15T11:00:00Z",
        payload: { id: "other", cwd: "/elsewhere" },
      },
    ]);
    const r = codexListSessions(buildFilter({ cwd: projectCwd }));
    const ids = r.map((s) => s.id);
    expect(ids).toContain(sessionId);
    expect(ids).not.toContain("other");
  });

  it("extractDialogue keeps user/assistant messages, drops developer/system", () => {
    writeJsonl(sessionFile, [
      {
        timestamp: "2026-04-15T10:00:00Z",
        payload: { id: sessionId, cwd: projectCwd },
      },
      {
        timestamp: "2026-04-15T10:00:01Z",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "system prompt" }],
        },
      },
      {
        timestamp: "2026-04-15T10:00:02Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello world" }],
        },
      },
      {
        timestamp: "2026-04-15T10:00:03Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi back" }],
        },
      },
      {
        timestamp: "2026-04-15T10:00:04Z",
        payload: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "should be dropped" }],
        },
      },
    ]);
    const s = codexListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const turns = codexExtractDialogue(s);
    expect(turns).toEqual([
      { role: "user", text: "hello world" },
      { role: "assistant", text: "hi back" },
    ]);
  });

  it("extractDialogue strips injection tags from inlined preamble content", () => {
    writeJsonl(sessionFile, [
      {
        timestamp: "2026-04-15T10:00:00Z",
        payload: { id: sessionId, cwd: projectCwd },
      },
      {
        timestamp: "2026-04-15T10:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "real question<workflow-state>x</workflow-state> trailing",
            },
          ],
        },
      },
    ]);
    const s = codexListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const turns = codexExtractDialogue(s);
    expect(turns).toEqual([
      { role: "user", text: "real question trailing" },
    ]);
  });

  it("extractDialogue rebuilds turn list from a `compacted` event's replacement_history", () => {
    writeJsonl(sessionFile, [
      {
        timestamp: "2026-04-15T10:00:00Z",
        payload: { id: sessionId, cwd: projectCwd },
      },
      {
        timestamp: "2026-04-15T10:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "pre-compact turn" }],
        },
      },
      {
        timestamp: "2026-04-15T10:00:02Z",
        type: "compacted",
        payload: {
          replacement_history: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "summary of earlier" }],
            },
          ],
        },
      },
      {
        timestamp: "2026-04-15T10:00:03Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "post-compact turn" }],
        },
      },
    ]);
    const s = codexListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const turns = codexExtractDialogue(s);
    expect(turns.map((t) => t.text)).toEqual([
      "[compact]\nsummary of earlier",
      "post-compact turn",
    ]);
  });

  it("extractDialogue drops bootstrap (large INSTRUCTIONS) user turn", () => {
    const huge = "<INSTRUCTIONS>\n" + "x".repeat(5000) + "\n</INSTRUCTIONS>";
    writeJsonl(sessionFile, [
      {
        timestamp: "2026-04-15T10:00:00Z",
        payload: { id: sessionId, cwd: projectCwd },
      },
      {
        timestamp: "2026-04-15T10:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: huge }],
        },
      },
      {
        timestamp: "2026-04-15T10:00:02Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "real question" }],
        },
      },
    ]);
    const s = codexListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const turns = codexExtractDialogue(s);
    expect(turns).toEqual([{ role: "user", text: "real question" }]);
  });

  it("codexSearch returns SearchHit with correct counts", () => {
    writeJsonl(sessionFile, [
      {
        timestamp: "2026-04-15T10:00:00Z",
        payload: { id: sessionId, cwd: projectCwd },
      },
      {
        timestamp: "2026-04-15T10:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "memory leak in heap" }],
        },
      },
    ]);
    const s = codexListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const hit = codexSearch(s, "memory");
    expect(hit.user_count).toBe(1);
    expect(hit.count).toBe(1);
  });
});

// =============================================================================
// OpenCode adapter (degraded — SQLite reader reverted in 0.6.0-beta.4)
// =============================================================================
//
// 0.6.0-beta.3 introduced a `better-sqlite3`-backed reader for OpenCode 1.2+'s
// SQLite session storage. 0.6.0-beta.4 reverted the native dep because the
// prebuild-tarball + node-gyp fallback chain was breaking `npm install` on
// Windows + China network (see PRD 05-09-revert-opencode-sqlite-emergency).
// The three exported adapter functions are kept (callers in dispatch /
// slicePhase rely on them) but degraded to no-ops with a one-shot stderr
// warning. These tests pin that degraded contract.

describe("opencode adapter (degraded — SQLite reader reverted)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    errSpy.mockRestore();
    vi.resetModules();
  });

  it("opencodeListSessions returns []", async () => {
    // Re-import inside the test so the module-level `opencodeWarned` flag
    // is fresh and we can observe the one-shot warning fire.
    vi.resetModules();
    const mod = await import("../../src/commands/mem.js");
    expect(mod.opencodeListSessions(buildFilter({ global: true }))).toEqual([]);
  });

  it("opencodeExtractDialogue returns [] for any session", async () => {
    vi.resetModules();
    const mod = await import("../../src/commands/mem.js");
    const fakeSession = {
      platform: "opencode" as const,
      id: "ses_x",
      filePath: OC_DB_PATH,
    };
    expect(mod.opencodeExtractDialogue(fakeSession)).toEqual([]);
  });

  it("warning fires only once across multiple opencode adapter calls", async () => {
    vi.resetModules();
    const mod = await import("../../src/commands/mem.js");
    mod.opencodeListSessions(buildFilter({ global: true }));
    mod.opencodeListSessions(buildFilter({ global: true }));
    mod.opencodeExtractDialogue({
      platform: "opencode",
      id: "ses_x",
      filePath: OC_DB_PATH,
    });
    // Each warning write call passes a single string arg; we expect exactly one.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const firstCallArg = errSpy.mock.calls[0]?.[0];
    expect(typeof firstCallArg).toBe("string");
    expect(firstCallArg as string).toMatch(/temporarily unavailable/i);
  });

  it("--platform opencode does not break dispatch for other platforms", async () => {
    // Seed a Claude session so `--platform all` produces non-empty output.
    const claudeProjectCwd = "/tmp/oc-degrade-mixed";
    const encodedCwd = claudeProjectCwd.replace(/[/_]/g, "-");
    const claudeProjectDir = nodePath.join(CLAUDE_PROJECTS, encodedCwd);
    const claudeSessionId = "33333333-3333-3333-3333-333333333333";
    const claudeSessionFile = nodePath.join(
      claudeProjectDir,
      `${claudeSessionId}.jsonl`,
    );
    writeJsonl(claudeSessionFile, [
      {
        type: "user",
        cwd: claudeProjectCwd,
        timestamp: "2026-04-15T10:00:00Z",
        message: { role: "user", content: "alive" },
      },
    ]);

    vi.resetModules();
    const mod = await import("../../src/commands/mem.js");

    // OpenCode list returns [] but doesn't throw / doesn't drop other platforms.
    expect(
      mod.opencodeListSessions(buildFilter({ global: true })),
    ).toEqual([]);
    const claudeSessions = mod.claudeListSessions(
      buildFilter({ global: true }),
    );
    expect(claudeSessions.find((s) => s.id === claudeSessionId)).toBeDefined();

    rimraf(claudeProjectDir);
  });
});

