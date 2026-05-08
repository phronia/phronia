/**
 * Tier-3 integration smoke tests for `runMem` (the dispatch entry point).
 *
 * Each subcommand (list / search / context / extract / projects) is exercised
 * end-to-end through `runMem(args)` with a small fixture session tree under
 * a mocked $HOME. We capture console.log to assert output shape and verify
 * that `--json` mode returns parseable JSON.
 *
 * Errors from `die()` are routed through process.exit(2); we mock it to throw
 * so we can assert non-zero exit on missing args / bad ids without killing
 * the test runner.
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

const { fakeHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const f = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("node:path") as typeof import("node:path");
  const fakeHome = f.mkdtempSync(p.join(o.tmpdir(), "trellis-mem-int-"));
  return { fakeHome };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

const { runMem } = await import("../../src/commands/mem.js");

// =============================================================================
// fixture setup
// =============================================================================

const CLAUDE_PROJECTS = nodePath.join(fakeHome, ".claude", "projects");
const projectCwd = "/tmp/mem-int-project";
const encodedCwd = projectCwd.replace(/[/_]/g, "-");
const projectDir = nodePath.join(CLAUDE_PROJECTS, encodedCwd);
const sessionId = "deadbeef-1234-5678-9abc-def012345678";
const sessionFile = nodePath.join(projectDir, `${sessionId}.jsonl`);

function writeJsonl(file: string, lines: readonly unknown[]): void {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(
    file,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function seedClaudeSession(): void {
  writeJsonl(sessionFile, [
    {
      type: "user",
      cwd: projectCwd,
      timestamp: "2026-04-15T10:00:00Z",
      message: { role: "user", content: "I want to debug a memory leak" },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Memory leaks usually come from unbounded caches.",
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: "great, can you find the cache in our heap dump?",
      },
    },
  ]);
}

afterAll(() => {
  nodeFs.rmSync(fakeHome, { recursive: true, force: true });
});

// =============================================================================
// runMem dispatch
// =============================================================================

describe("runMem subcommand integration", () => {
  let logs: string[];
  let errs: string[];
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const noop = (): void => {};

  beforeEach(() => {
    nodeFs.mkdirSync(projectDir, { recursive: true });
    seedClaudeSession();
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errs.push(args.map((a) => String(a)).join(" "));
    });
    // die() calls process.exit(2); we throw a marker so tests can assert it
    // was hit without aborting the runner.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    nodeFs.rmSync(CLAUDE_PROJECTS, { recursive: true, force: true });
    noop();
  });

  // ---------- list ----------

  it("list: prints the session in cwd-scoped output", () => {
    runMem(["list", "--cwd", projectCwd]);
    const joined = logs.join("\n");
    expect(joined).toContain(sessionId.slice(0, 12));
    expect(joined).toContain("1 session(s)");
  });

  it("list --json: emits a parseable JSON array", () => {
    runMem(["list", "--cwd", projectCwd, "--json"]);
    expect(logs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(logs[0] ?? "[]") as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sessionId, platform: "claude" }),
      ]),
    );
  });

  // ---------- search ----------

  it("search: surfaces the matching session and its hit count", () => {
    runMem(["search", "memory", "--cwd", projectCwd]);
    const joined = logs.join("\n");
    expect(joined).toContain("memory");
    expect(joined).toContain(sessionId.slice(0, 12));
    // "1 session(s)" footer indicates exactly one match.
    expect(joined).toMatch(/\d+ session\(s\)/);
  });

  it("search --json: returns an array of matches with score + excerpts", () => {
    runMem(["search", "memory", "--cwd", projectCwd, "--json"]);
    const parsed = JSON.parse(logs[0] ?? "[]") as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as {
      session: { id: string };
      score: number;
      hit_count: number;
      excerpts: unknown[];
    }[];
    expect(arr.length).toBeGreaterThan(0);
    expect(arr[0]?.session.id).toBe(sessionId);
    expect(arr[0]?.hit_count).toBeGreaterThan(0);
  });

  it("search: missing keyword exits non-zero via die()", () => {
    expect(() => runMem(["search"])).toThrow(/__exit__:2/);
    expect(errs.join("\n")).toContain("usage: search <keyword>");
  });

  // ---------- context ----------

  it("context: prints turns from the matched session", () => {
    runMem([
      "context",
      sessionId,
      "--grep",
      "memory",
      "--turns",
      "1",
      "--around",
      "0",
      "--cwd",
      projectCwd,
    ]);
    const joined = logs.join("\n");
    expect(joined).toContain(`# context: [claude] ${sessionId}`);
    expect(joined).toContain("memory");
  });

  it("context --json: returns object with session + turns array", () => {
    runMem([
      "context",
      sessionId,
      "--grep",
      "memory",
      "--cwd",
      projectCwd,
      "--json",
    ]);
    const parsed = JSON.parse(logs.join("\n")) as {
      session: { id: string };
      turns: unknown[];
    };
    expect(parsed.session.id).toBe(sessionId);
    expect(Array.isArray(parsed.turns)).toBe(true);
  });

  it("context: missing session id exits non-zero", () => {
    expect(() => runMem(["context"])).toThrow(/__exit__:2/);
  });

  it("context: unknown session id exits non-zero with 'not found' message", () => {
    expect(() => runMem(["context", "no-such-session-id"])).toThrow(
      /__exit__:2/,
    );
    expect(errs.join("\n")).toMatch(/session not found/);
  });

  // ---------- extract ----------

  it("extract: dumps the cleaned dialogue with role headers", () => {
    runMem(["extract", sessionId, "--cwd", projectCwd]);
    const joined = logs.join("\n");
    expect(joined).toContain("## Human");
    expect(joined).toContain("## Assistant");
    expect(joined).toContain("memory leak");
  });

  it("extract --json: returns session + turns as parseable JSON", () => {
    runMem(["extract", sessionId, "--cwd", projectCwd, "--json"]);
    const parsed = JSON.parse(logs.join("\n")) as {
      session: { id: string };
      turns: { role: string; text: string }[];
    };
    expect(parsed.session.id).toBe(sessionId);
    expect(parsed.turns.length).toBeGreaterThan(0);
  });

  it("extract --grep filters turns to only those matching the keyword", () => {
    runMem(["extract", sessionId, "--cwd", projectCwd, "--grep", "cache"]);
    const joined = logs.join("\n");
    expect(joined).toContain("cache");
    // The first turn ("debug a memory leak") doesn't match "cache" and should
    // be filtered out.
    expect(joined).not.toContain("debug a memory leak");
  });

  // ---------- projects ----------

  it("projects: lists distinct cwds with session counts", () => {
    runMem(["projects"]);
    const joined = logs.join("\n");
    expect(joined).toContain("active projects");
    // Our seeded session has cwd=projectCwd, which should appear.
    expect(joined).toContain(projectCwd);
  });

  it("projects --json: emits an array of {cwd, sessions, by_platform, ...}", () => {
    runMem(["projects", "--json"]);
    const parsed = JSON.parse(logs[0] ?? "[]") as {
      cwd: string;
      sessions: number;
      by_platform: Record<string, number>;
    }[];
    expect(Array.isArray(parsed)).toBe(true);
    const ours = parsed.find((p) => p.cwd === projectCwd);
    expect(ours).toBeDefined();
    expect(ours?.sessions).toBeGreaterThan(0);
    expect(ours?.by_platform.claude).toBe(1);
  });

  // ---------- help / unknown ----------

  it("help command prints usage", () => {
    runMem(["help"]);
    expect(logs.join("\n")).toContain("trellis mem");
  });

  it("unknown command exits non-zero with 'unknown command' error", () => {
    expect(() => runMem(["bogus"])).toThrow(/__exit__:2/);
    expect(errs.join("\n")).toMatch(/unknown command/);
  });
});
