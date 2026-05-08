/**
 * Tier-1 unit tests for `trellis mem` pure helpers.
 *
 * These functions don't touch the filesystem; they take strings/objects in
 * and return strings/objects out. Each helper gets ≥3 cases covering the
 * happy path plus edge cases the PRD calls out (off-by-one on UTC dates,
 * Windows path quirks, regex escaping in injection-tag stripping, etc.).
 */

import { describe, it, expect } from "vitest";

import {
  relevanceScore,
  parseArgv,
  buildFilter,
  inRange,
  sameProject,
  isBootstrapTurn,
  stripInjectionTags,
  chunkAround,
  searchInDialogue,
  shortDate,
  shortPath,
} from "../../src/commands/mem.js";

// =============================================================================
// relevanceScore
// =============================================================================

describe("relevanceScore", () => {
  it("returns 0 when total_turns is 0 (avoids divide-by-zero)", () => {
    expect(
      relevanceScore({
        count: 0,
        user_count: 0,
        asst_count: 0,
        total_turns: 0,
        excerpts: [],
      }),
    ).toBe(0);
  });

  it("weights user hits ×3 vs assistant hits ×1", () => {
    // 1 user hit + 0 asst hits over 10 turns = 3/10 = 0.3
    const userOnly = relevanceScore({
      count: 1,
      user_count: 1,
      asst_count: 0,
      total_turns: 10,
      excerpts: [],
    });
    // 0 user + 3 asst over 10 turns = 3/10 = 0.3 (same numerator, different mix)
    const asstOnly = relevanceScore({
      count: 3,
      user_count: 0,
      asst_count: 3,
      total_turns: 10,
      excerpts: [],
    });
    expect(userOnly).toBeCloseTo(0.3);
    expect(asstOnly).toBeCloseTo(0.3);
    // 1 user must outweigh 1 asst (user gets the ×3 multiplier).
    const oneUser = relevanceScore({
      count: 1,
      user_count: 1,
      asst_count: 0,
      total_turns: 10,
      excerpts: [],
    });
    const oneAsst = relevanceScore({
      count: 1,
      user_count: 0,
      asst_count: 1,
      total_turns: 10,
      excerpts: [],
    });
    expect(oneUser).toBeGreaterThan(oneAsst);
  });

  it("normalizes by total_turns so a tight short session beats a sprawling long one", () => {
    // 18 user hits in 30-turn session
    const tight = relevanceScore({
      count: 18,
      user_count: 18,
      asst_count: 0,
      total_turns: 30,
      excerpts: [],
    });
    // 58 user hits in 200-turn session
    const sprawling = relevanceScore({
      count: 58,
      user_count: 58,
      asst_count: 0,
      total_turns: 200,
      excerpts: [],
    });
    expect(tight).toBeGreaterThan(sprawling);
  });
});

// =============================================================================
// parseArgv
// =============================================================================

describe("parseArgv", () => {
  it("defaults cmd to 'list' when argv is empty", () => {
    const r = parseArgv([]);
    expect(r.cmd).toBe("list");
    expect(r.positional).toEqual([]);
    expect(r.flags).toEqual({});
  });

  it("collects positional args after the command", () => {
    const r = parseArgv(["search", "memory", "leak"]);
    expect(r.cmd).toBe("search");
    expect(r.positional).toEqual(["memory", "leak"]);
  });

  it("parses --flag value pairs and standalone --flag as boolean", () => {
    const r = parseArgv([
      "list",
      "--platform",
      "claude",
      "--global",
      "--limit",
      "10",
    ]);
    expect(r.flags.platform).toBe("claude");
    expect(r.flags.global).toBe(true);
    expect(r.flags.limit).toBe("10");
  });

  it("treats trailing --flag (no value) as boolean true", () => {
    const r = parseArgv(["list", "--json"]);
    expect(r.flags.json).toBe(true);
  });
});

// =============================================================================
// buildFilter
// =============================================================================

describe("buildFilter", () => {
  it("defaults platform to 'all' and limit to 50, scoping to cwd", () => {
    const f = buildFilter({});
    expect(f.platform).toBe("all");
    expect(f.limit).toBe(50);
    expect(f.cwd).toBe(process.cwd());
    expect(f.since).toBeUndefined();
    expect(f.until).toBeUndefined();
  });

  it("--global drops the cwd scope", () => {
    const f = buildFilter({ global: true });
    expect(f.cwd).toBeUndefined();
  });

  it("parses --since as inclusive lower bound and --until as end-of-day UTC", () => {
    const f = buildFilter({ since: "2026-04-01", until: "2026-04-30" });
    expect(f.since?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    // until gets `T23:59:59.999Z` appended so the filter is inclusive of the
    // entire day, not midnight (off-by-one trap the PRD called out).
    expect(f.until?.toISOString()).toBe("2026-04-30T23:59:59.999Z");
  });

  it("--cwd overrides process.cwd() and resolves relative paths", () => {
    const f = buildFilter({ cwd: "/some/abs/path" });
    expect(f.cwd).toBe("/some/abs/path");
  });
});

// =============================================================================
// inRange
// =============================================================================

describe("inRange", () => {
  const f = buildFilter({ since: "2026-04-01", until: "2026-04-30" });

  it("returns true when iso is undefined (no timestamp = don't filter)", () => {
    expect(inRange(undefined, f)).toBe(true);
  });

  it("includes timestamps inside the range", () => {
    expect(inRange("2026-04-15T12:00:00Z", f)).toBe(true);
  });

  it("excludes timestamps before since", () => {
    expect(inRange("2026-03-31T23:59:59Z", f)).toBe(false);
  });

  it("includes the last instant of until-day (end-of-day inclusive)", () => {
    // until = 2026-04-30T23:59:59.999Z, so 23:59:59.500Z is still inside.
    expect(inRange("2026-04-30T23:59:59.500Z", f)).toBe(true);
  });

  it("returns true for unparseable iso strings (don't drop on parse error)", () => {
    expect(inRange("not-a-date", f)).toBe(true);
  });
});

// =============================================================================
// sameProject
// =============================================================================

describe("sameProject", () => {
  it("returns true when target is undefined (no scoping = match all)", () => {
    expect(sameProject("/anything", undefined)).toBe(true);
  });

  it("returns false when sessionCwd is undefined but target is set", () => {
    expect(sameProject(undefined, "/repo")).toBe(false);
  });

  it("returns true for exact path match", () => {
    expect(sameProject("/Users/me/repo", "/Users/me/repo")).toBe(true);
  });

  it("returns true when sessionCwd is a subdirectory of target", () => {
    expect(sameProject("/Users/me/repo/src", "/Users/me/repo")).toBe(true);
  });

  it("returns false for sibling paths sharing a prefix", () => {
    // /Users/me/repo2 starts with /Users/me/repo as a string but not as a
    // path — sameProject must check the trailing separator.
    expect(sameProject("/Users/me/repo2", "/Users/me/repo")).toBe(false);
  });
});

// =============================================================================
// isBootstrapTurn
// =============================================================================

describe("isBootstrapTurn", () => {
  it("flags AGENTS.md preamble turns", () => {
    expect(
      isBootstrapTurn("# AGENTS.md instructions for /repo\n\nblah", 200),
    ).toBe(true);
  });

  it("flags large INSTRUCTIONS-only turns (Codex's first user message)", () => {
    expect(
      isBootstrapTurn("<INSTRUCTIONS>\nblah blah blah\n</INSTRUCTIONS>", 5000),
    ).toBe(true);
  });

  it("does NOT flag short turns even if they start with INSTRUCTIONS", () => {
    // Threshold is originalLength > 4000; a small genuine turn must pass.
    expect(isBootstrapTurn("<INSTRUCTIONS>fine</INSTRUCTIONS>", 100)).toBe(
      false,
    );
  });

  it("does NOT flag a normal user turn", () => {
    expect(isBootstrapTurn("hey can you help me debug this", 30)).toBe(false);
  });
});

// =============================================================================
// stripInjectionTags
// =============================================================================

describe("stripInjectionTags", () => {
  it("removes <system-reminder>...</system-reminder> blocks", () => {
    const out = stripInjectionTags(
      "before<system-reminder>secret</system-reminder>after",
    );
    expect(out).toBe("beforeafter");
  });

  it("strips multiple known injection tags case-insensitively", () => {
    // Codex uses uppercase <INSTRUCTIONS>; Trellis uses lowercase <workflow-state>.
    const out = stripInjectionTags(
      "x<INSTRUCTIONS>foo</INSTRUCTIONS>y<workflow-state>bar</workflow-state>z",
    );
    expect(out).toBe("xyz");
  });

  it("strips AGENTS.md preamble up to the first natural paragraph", () => {
    const out = stripInjectionTags(
      "# AGENTS.md instructions for /repo\nrules rules rules\n\nReal user content here.",
    );
    expect(out).toContain("Real user content here.");
    expect(out).not.toContain("AGENTS.md");
  });

  it("preserves regular text without injection tags", () => {
    const text = "hello, this is a normal user turn about <regular> markdown";
    expect(stripInjectionTags(text)).toBe(text);
  });

  it("collapses runs of 3+ newlines to exactly 2 (paragraph break)", () => {
    const out = stripInjectionTags("a\n\n\n\nb");
    expect(out).toBe("a\n\nb");
  });
});

// =============================================================================
// chunkAround
// =============================================================================

describe("chunkAround", () => {
  it("returns the paragraph containing the hit (paragraph-aligned chunk)", () => {
    // Three paragraphs separated by blank lines. Hit is in the middle one.
    const text = "para A\n\npara B with hit\n\npara C";
    const hitIdx = text.indexOf("hit");
    const r = chunkAround(text, hitIdx, 400);
    expect(text.slice(r.start, r.end)).toBe("para B with hit");
    expect(r.truncated).toBe(false);
  });

  it("returns the full text when there are no paragraph breaks", () => {
    const text = "single paragraph with the hit inside it";
    const hitIdx = text.indexOf("hit");
    const r = chunkAround(text, hitIdx, 400);
    expect(r.start).toBe(0);
    expect(r.end).toBe(text.length);
  });

  it("falls back to a centered window when paragraph exceeds maxChars", () => {
    const huge = "x".repeat(1000) + "HIT" + "x".repeat(1000);
    const hitIdx = huge.indexOf("HIT");
    const r = chunkAround(huge, hitIdx, 100);
    expect(r.truncated).toBe(true);
    expect(r.end - r.start).toBeLessThanOrEqual(100);
    // The hit must still be inside the window.
    expect(hitIdx).toBeGreaterThanOrEqual(r.start);
    expect(hitIdx).toBeLessThan(r.end);
  });
});

// =============================================================================
// searchInDialogue
// =============================================================================

describe("searchInDialogue", () => {
  it("returns zero hits and empty excerpts on empty keyword", () => {
    const turns = [{ role: "user" as const, text: "hello world" }];
    const r = searchInDialogue(turns, "");
    expect(r.count).toBe(0);
    expect(r.excerpts).toEqual([]);
    expect(r.total_turns).toBe(1);
  });

  it("counts case-insensitive substring matches across user and assistant", () => {
    const turns = [
      { role: "user" as const, text: "I want to discuss MEMORY usage" },
      { role: "assistant" as const, text: "Memory is allocated on heap." },
      { role: "user" as const, text: "no relevant content here" },
    ];
    const r = searchInDialogue(turns, "memory");
    expect(r.user_count).toBe(1);
    expect(r.asst_count).toBe(1);
    expect(r.count).toBe(2);
  });

  it("requires AND of all whitespace-split tokens (multi-token AND grep)", () => {
    const turns = [
      { role: "user" as const, text: "memory leak in heap allocator" },
      { role: "user" as const, text: "memory only, no other word" },
      { role: "user" as const, text: "kombucha only, off-topic" },
    ];
    const r = searchInDialogue(turns, "memory leak");
    // Only the first turn has BOTH tokens. count = total occurrences across
    // both tokens within that turn = 1 (memory) + 1 (leak) = 2.
    expect(r.count).toBe(2);
    expect(r.user_count).toBe(2);
  });

  it("places user excerpts before assistant excerpts (user intent ranks higher)", () => {
    const turns = [
      { role: "assistant" as const, text: "FOO appears here" },
      { role: "user" as const, text: "FOO appears here too" },
    ];
    const r = searchInDialogue(turns, "FOO");
    expect(r.excerpts.length).toBeGreaterThan(0);
    expect(r.excerpts[0]?.role).toBe("user");
  });

  it("caps excerpts at maxExcerpts", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      text: `turn ${i} contains FOO`,
    }));
    const r = searchInDialogue(turns, "FOO", 3);
    expect(r.excerpts.length).toBeLessThanOrEqual(3);
  });
});

// =============================================================================
// shortDate / shortPath
// =============================================================================

describe("shortDate", () => {
  it("returns blank padding when iso is undefined", () => {
    expect(shortDate(undefined)).toBe("         ");
  });

  it("trims iso to 'YYYY-MM-DD HH:MM' and replaces T with space", () => {
    expect(shortDate("2026-04-15T13:30:45.123Z")).toBe("2026-04-15 13:30");
  });

  it("preserves a too-short iso without crashing", () => {
    // Passes through whatever slice(0,16) gives us.
    expect(shortDate("2026")).toBe("2026");
  });
});

describe("shortPath", () => {
  it("returns '(no cwd)' for undefined", () => {
    expect(shortPath(undefined)).toBe("(no cwd)");
  });

  it("replaces $HOME with ~", async () => {
    const os = await import("node:os");
    const home = os.homedir();
    expect(shortPath(`${home}/projects/foo`)).toBe("~/projects/foo");
  });

  it("leaves paths outside HOME untouched", () => {
    expect(shortPath("/etc/hosts")).toBe("/etc/hosts");
  });
});
