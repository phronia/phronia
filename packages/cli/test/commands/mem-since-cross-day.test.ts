/**
 * Tests for `tl mem --since` cross-day session filtering.
 *
 * Regression for PRD 05-08-mem-since-cross-day-filter: list filtering used to
 * apply `inRange()` to a single timestamp (claude/codex: created, opencode:
 * updated), which dropped long-running cross-day sessions whose start fell
 * outside the window even when activity inside it was heavy.
 *
 * Each platform is exercised against the five interval relations enumerated
 * in the PRD's Acceptance Criteria:
 *
 *   1. Entirely before window         → must be excluded
 *   2. Entirely after window          → must be excluded
 *   3. Embedded inside window         → must be included
 *   4. Crosses window's left bound    → must be included (the bug case)
 *   5. Crosses window's right bound   → must be included
 *
 * mem.ts captures HOME at module load, so we mock node:os via vi.hoisted to
 * point homedir() at a per-suite tmpdir before the import resolves. mtime is
 * forced via fs.utimesSync because `updated` for claude / codex comes from
 * fs.statSync(file).mtime (writing the file always sets mtime = now).
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
  const fakeHome = f.mkdtempSync(p.join(o.tmpdir(), "trellis-mem-cross-"));
  return { fakeHome };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

const {
  claudeListSessions,
  codexListSessions,
  buildFilter,
  inRangeOverlap,
} = await import("../../src/commands/mem.js");

// =============================================================================
// shared paths + helpers
// =============================================================================

const CLAUDE_PROJECTS = nodePath.join(fakeHome, ".claude", "projects");
const CODEX_SESSIONS = nodePath.join(fakeHome, ".codex", "sessions");

// OpenCode interval-overlap coverage was removed in 0.6.0-beta.4: the SQLite
// reader was reverted (PRD 05-09-revert-opencode-sqlite-emergency) and the
// adapter now always returns []. inRangeOverlap is still exercised against
// Claude / Codex below, which use the same shared helper.

function writeJsonl(file: string, lines: readonly unknown[]): void {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(
    file,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function setMtime(file: string, iso: string): void {
  const t = new Date(iso);
  nodeFs.utimesSync(file, t, t);
}

function rimraf(p: string): void {
  nodeFs.rmSync(p, { recursive: true, force: true });
}

afterAll(() => {
  rimraf(fakeHome);
});

// Five PRD interval-relation cases. Each row is named for legibility.
interface IntervalCase {
  name: string;
  start: string; // session created
  end: string; // session updated (mtime)
  since?: string; // filter window
  until?: string;
  expectIncluded: boolean;
}

const CASES: readonly IntervalCase[] = [
  {
    name: "#1 entirely before window",
    start: "2026-04-01T00:00:00Z",
    end: "2026-04-05T00:00:00Z",
    since: "2026-05-01",
    expectIncluded: false,
  },
  {
    name: "#2 entirely after window",
    start: "2026-06-01T00:00:00Z",
    end: "2026-06-05T00:00:00Z",
    until: "2026-05-31",
    expectIncluded: false,
  },
  {
    name: "#3 embedded inside window",
    start: "2026-05-10T00:00:00Z",
    end: "2026-05-12T00:00:00Z",
    since: "2026-05-01",
    until: "2026-05-20",
    expectIncluded: true,
  },
  {
    name: "#4 crosses window left bound (cross-day bug case)",
    start: "2026-04-25T00:00:00Z",
    end: "2026-05-05T00:00:00Z",
    since: "2026-05-01",
    expectIncluded: true,
  },
  {
    name: "#5 crosses window right bound",
    start: "2026-05-25T00:00:00Z",
    end: "2026-06-05T00:00:00Z",
    until: "2026-05-31",
    expectIncluded: true,
  },
];

// =============================================================================
// inRangeOverlap helper unit tests
// =============================================================================

describe("inRangeOverlap", () => {
  it("returns true when both endpoints are undefined (no filter applied)", () => {
    const f = buildFilter({ global: true, since: "2026-05-01" });
    expect(inRangeOverlap(undefined, undefined, f)).toBe(true);
  });

  it("falls back to single-point semantics when only end is set", () => {
    const f = buildFilter({ global: true, since: "2026-05-01" });
    expect(inRangeOverlap(undefined, "2026-04-01T00:00:00Z", f)).toBe(false);
    expect(inRangeOverlap(undefined, "2026-05-15T00:00:00Z", f)).toBe(true);
  });

  it("falls back to single-point semantics when only start is set", () => {
    const f = buildFilter({ global: true, until: "2026-05-31" });
    expect(inRangeOverlap("2026-06-01T00:00:00Z", undefined, f)).toBe(false);
    expect(inRangeOverlap("2026-05-15T00:00:00Z", undefined, f)).toBe(true);
  });

  it("includes intervals that cross the left bound", () => {
    const f = buildFilter({ global: true, since: "2026-05-01" });
    expect(
      inRangeOverlap("2026-04-25T00:00:00Z", "2026-05-05T00:00:00Z", f),
    ).toBe(true);
  });

  it("includes intervals that cross the right bound", () => {
    const f = buildFilter({ global: true, until: "2026-05-31" });
    expect(
      inRangeOverlap("2026-05-25T00:00:00Z", "2026-06-05T00:00:00Z", f),
    ).toBe(true);
  });

  it("excludes intervals entirely before the window", () => {
    const f = buildFilter({ global: true, since: "2026-05-01" });
    expect(
      inRangeOverlap("2026-04-01T00:00:00Z", "2026-04-05T00:00:00Z", f),
    ).toBe(false);
  });

  it("excludes intervals entirely after the window", () => {
    const f = buildFilter({ global: true, until: "2026-05-31" });
    expect(
      inRangeOverlap("2026-06-01T00:00:00Z", "2026-06-05T00:00:00Z", f),
    ).toBe(false);
  });

  it("includes intervals fully embedded in the window", () => {
    const f = buildFilter({
      global: true,
      since: "2026-05-01",
      until: "2026-05-20",
    });
    expect(
      inRangeOverlap("2026-05-10T00:00:00Z", "2026-05-12T00:00:00Z", f),
    ).toBe(true);
  });
});

// =============================================================================
// Claude
// =============================================================================

describe("claudeListSessions interval-overlap filter", () => {
  const projectCwd = "/tmp/cross-day-claude";
  const encodedCwd = projectCwd.replace(/[/_]/g, "-");
  const projectDir = nodePath.join(CLAUDE_PROJECTS, encodedCwd);

  beforeEach(() => {
    nodeFs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rimraf(CLAUDE_PROJECTS);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const sessionId = `claude-${c.name.split(" ")[0].slice(1)}-id`;
      const sessionFile = nodePath.join(projectDir, `${sessionId}.jsonl`);
      writeJsonl(sessionFile, [
        {
          type: "user",
          cwd: projectCwd,
          timestamp: c.start,
          message: { role: "user", content: "hello" },
        },
      ]);
      setMtime(sessionFile, c.end);

      const r = claudeListSessions(
        buildFilter({ global: true, since: c.since, until: c.until }),
      );
      const found = r.some((s) => s.id === sessionId);
      expect(found).toBe(c.expectIncluded);
    });
  }
});

// =============================================================================
// Codex
// =============================================================================

describe("codexListSessions interval-overlap filter", () => {
  const projectCwd = "/tmp/cross-day-codex";

  afterEach(() => {
    rimraf(CODEX_SESSIONS);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const sessionId = `codex-${c.name.split(" ")[0].slice(1)}-id`;
      // Codex filename ts is the start time, encoded as YYYY-MM-DDTHH-MM-SS.
      const startDate = new Date(c.start);
      const fnameTs = startDate
        .toISOString()
        .slice(0, 19)
        .replace(/T(\d{2}):(\d{2}):(\d{2})/, "T$1-$2-$3");
      const fileName = `rollout-${fnameTs}-${sessionId}.jsonl`;
      const yyyy = String(startDate.getUTCFullYear());
      const mm = String(startDate.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(startDate.getUTCDate()).padStart(2, "0");
      const sessionFile = nodePath.join(
        CODEX_SESSIONS,
        yyyy,
        mm,
        dd,
        fileName,
      );
      writeJsonl(sessionFile, [
        {
          timestamp: c.start,
          type: "session_meta",
          payload: { id: sessionId, cwd: projectCwd },
        },
      ]);
      setMtime(sessionFile, c.end);

      const r = codexListSessions(
        buildFilter({ global: true, since: c.since, until: c.until }),
      );
      const found = r.some((s) => s.id === sessionId);
      expect(found).toBe(c.expectIncluded);
    });
  }
});

// =============================================================================
// OpenCode — coverage dropped in 0.6.0-beta.4 (adapter degraded; see header).
// =============================================================================
