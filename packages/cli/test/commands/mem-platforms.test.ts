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
const {
  claudeListSessions,
  claudeExtractDialogue,
  claudeSearch,
  codexListSessions,
  codexExtractDialogue,
  codexSearch,
  opencodeListSessions,
  opencodeExtractDialogue,
  buildFilter,
} = await import("../../src/commands/mem.js");

// =============================================================================
// shared fixture helpers
// =============================================================================

const CLAUDE_PROJECTS = nodePath.join(fakeHome, ".claude", "projects");
const CODEX_SESSIONS = nodePath.join(fakeHome, ".codex", "sessions");
const OC_DIR = nodePath.join(fakeHome, ".local", "share", "opencode");
const OC_DB_PATH = nodePath.join(OC_DIR, "opencode.db");

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
// OpenCode adapter (SQLite, opencode 1.2+)
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3") as new (
  file: string,
  opts?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
  };
  close(): void;
};

interface OcSeedSession {
  id: string;
  directory?: string | null;
  title?: string;
  parent_id?: string | null;
  time_created: number;
  time_updated: number;
}

interface OcSeedMessage {
  id: string;
  session_id: string;
  time_created: number;
  data: object;
}

interface OcSeedPart {
  id: string;
  message_id: string;
  session_id: string;
  data: object;
}

function seedOcDb(opts: {
  sessions: readonly OcSeedSession[];
  messages?: readonly OcSeedMessage[];
  parts?: readonly OcSeedPart[];
}): void {
  nodeFs.mkdirSync(OC_DIR, { recursive: true });
  // Match real schema as closely as needed for the queries we run.
  const db = new Database(OC_DB_PATH);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const insSession = db.prepare(
    "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const s of opts.sessions) {
    insSession.run(
      s.id,
      s.parent_id ?? null,
      s.directory ?? null,
      s.title ?? "",
      s.time_created,
      s.time_updated,
    );
  }
  const insMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  for (const m of opts.messages ?? []) {
    insMessage.run(
      m.id,
      m.session_id,
      m.time_created,
      m.time_created,
      JSON.stringify(m.data),
    );
  }
  const insPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const p of opts.parts ?? []) {
    insPart.run(
      p.id,
      p.message_id,
      p.session_id,
      0,
      0,
      JSON.stringify(p.data),
    );
  }
  db.close();
}

describe("opencodeListSessions / opencodeExtractDialogue (SQLite)", () => {
  const sessionId = "ses_opencode_1";
  const projectCwd = "/tmp/oc-project";

  beforeEach(() => {
    nodeFs.mkdirSync(OC_DIR, { recursive: true });
  });

  afterEach(() => {
    rimraf(OC_DIR);
  });

  it("returns no sessions when DB doesn't exist", () => {
    rimraf(OC_DIR);
    expect(opencodeListSessions(buildFilter({ global: true }))).toEqual([]);
  });

  it("lists a session and reads title/cwd/parent_id", () => {
    seedOcDb({
      sessions: [
        {
          id: sessionId,
          title: "debug memory leak",
          directory: projectCwd,
          parent_id: "ses_parent_1",
          time_created: 1_700_000_000_000,
          time_updated: 1_700_000_001_000,
        },
      ],
    });
    const r = opencodeListSessions(buildFilter({ global: true }));
    const s = r.find((x) => x.id === sessionId);
    expect(s).toBeDefined();
    expect(s?.title).toBe("debug memory leak");
    expect(s?.cwd).toBe(projectCwd);
    expect(s?.parent_id).toBe("ses_parent_1");
    expect(s?.filePath).toBe(OC_DB_PATH);
  });

  it("filters opencode sessions by --cwd (and excludes other-project sessions)", () => {
    seedOcDb({
      sessions: [
        {
          id: sessionId,
          directory: projectCwd,
          time_created: 1_700_000_000_000,
          time_updated: 1_700_000_001_000,
        },
        {
          id: "ses_opencode_2",
          directory: "/elsewhere",
          time_created: 1_700_000_000_000,
          time_updated: 1_700_000_001_000,
        },
      ],
    });
    const r = opencodeListSessions(buildFilter({ cwd: projectCwd }));
    const ids = r.map((s) => s.id);
    expect(ids).toContain(sessionId);
    expect(ids).not.toContain("ses_opencode_2");
  });

  it("extractDialogue groups parts by message, drops synthetic + non-text parts", () => {
    const msgUser = "msg_user_1";
    const msgAsst = "msg_asst_1";
    seedOcDb({
      sessions: [
        {
          id: sessionId,
          directory: projectCwd,
          time_created: 1_700_000_000_000,
          time_updated: 1_700_000_001_000,
        },
      ],
      messages: [
        {
          id: msgUser,
          session_id: sessionId,
          time_created: 1_700_000_000_001,
          data: { role: "user", time: { created: 1_700_000_000_001 } },
        },
        {
          id: msgAsst,
          session_id: sessionId,
          time_created: 1_700_000_000_002,
          data: { role: "assistant", time: { created: 1_700_000_000_002 } },
        },
      ],
      parts: [
        // user: synthetic preamble + real text
        {
          id: "prt_u1",
          message_id: msgUser,
          session_id: sessionId,
          data: { type: "text", text: "synthetic preamble", synthetic: true },
        },
        {
          id: "prt_u2",
          message_id: msgUser,
          session_id: sessionId,
          data: { type: "text", text: "real question" },
        },
        // assistant: tool_use (skipped) + text
        {
          id: "prt_a1",
          message_id: msgAsst,
          session_id: sessionId,
          data: { type: "tool", text: "should be skipped" },
        },
        {
          id: "prt_a2",
          message_id: msgAsst,
          session_id: sessionId,
          data: { type: "text", text: "real answer" },
        },
      ],
    });

    const s = opencodeListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    const turns = opencodeExtractDialogue(s);
    expect(turns).toEqual([
      { role: "user", text: "real question" },
      { role: "assistant", text: "real answer" },
    ]);
  });

  it("extractDialogue strips injection tags from text parts", () => {
    const msgId = "msg_1";
    seedOcDb({
      sessions: [
        {
          id: sessionId,
          directory: projectCwd,
          time_created: 1_700_000_000_000,
          time_updated: 1_700_000_001_000,
        },
      ],
      messages: [
        {
          id: msgId,
          session_id: sessionId,
          time_created: 1_700_000_000_001,
          data: { role: "user", time: { created: 1_700_000_000_001 } },
        },
      ],
      parts: [
        {
          id: "prt_1",
          message_id: msgId,
          session_id: sessionId,
          data: {
            type: "text",
            text: "before<system-reminder>x</system-reminder>after",
          },
        },
      ],
    });
    const s = opencodeListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    expect(opencodeExtractDialogue(s)).toEqual([
      { role: "user", text: "beforeafter" },
    ]);
  });

  it("returns empty turns for a session with no messages", () => {
    seedOcDb({
      sessions: [
        {
          id: sessionId,
          directory: projectCwd,
          time_created: 1_700_000_000_000,
          time_updated: 1_700_000_001_000,
        },
      ],
    });
    const s = opencodeListSessions(buildFilter({ global: true })).find(
      (x) => x.id === sessionId,
    );
    expect(s).toBeDefined();
    if (!s) return;
    expect(opencodeExtractDialogue(s)).toEqual([]);
  });

  it("degrades to [] when required schema columns are missing", () => {
    nodeFs.mkdirSync(OC_DIR, { recursive: true });
    const db = new Database(OC_DB_PATH);
    // Missing `directory` and `time_*`: schema check fails and adapter degrades.
    db.exec(
      `CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT); CREATE TABLE part (id TEXT);`,
    );
    db.close();
    // Capture stderr without polluting test output.
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(opencodeListSessions(buildFilter({ global: true }))).toEqual([]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("preserves parent_id for sub-agent chains", () => {
    seedOcDb({
      sessions: [
        {
          id: "ses_parent",
          directory: projectCwd,
          time_created: 1_700_000_000_000,
          time_updated: 1_700_000_002_000,
        },
        {
          id: "ses_child",
          directory: projectCwd,
          parent_id: "ses_parent",
          time_created: 1_700_000_001_000,
          time_updated: 1_700_000_001_500,
        },
      ],
    });
    const r = opencodeListSessions(buildFilter({ global: true }));
    const child = r.find((x) => x.id === "ses_child");
    expect(child?.parent_id).toBe("ses_parent");
  });
});

