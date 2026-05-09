/**
 * mem.ts — search sessions across Claude Code / Codex / OpenCode.
 *
 * Commands:
 *   list                          list sessions (default if no command)
 *   search <keyword>              find sessions whose contents match keyword
 *   context <session-id>          drill-down: top-N hit turns + surrounding context
 *   extract <session-id>          dump cleaned dialogue (use --grep KW to filter turns)
 *   projects                      list active project cwds (AI-routing entry point)
 *
 * Run `trellis mem help` for the full flag reference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";

// ---------- schemas: domain types ----------

const PlatformSchema = z.enum(["claude", "codex", "opencode"]);
type Platform = z.infer<typeof PlatformSchema>;

const SessionInfoSchema = z.object({
  platform: PlatformSchema,
  id: z.string(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  filePath: z.string(),
  parent_id: z.string().optional(), // OpenCode only: parent session id (sub-agent chain)
});
type SessionInfo = z.infer<typeof SessionInfoSchema>;

const DialogueRoleSchema = z.enum(["user", "assistant"]);
type DialogueRole = z.infer<typeof DialogueRoleSchema>;

interface DialogueTurn {
  role: DialogueRole;
  text: string;
}

const SearchExcerptSchema = z.object({
  role: DialogueRoleSchema,
  snippet: z.string(),
});
const SearchHitSchema = z.object({
  count: z.number(), // total token occurrences across all matching turns
  user_count: z.number(), // breakdown: user-turn occurrences
  asst_count: z.number(), // breakdown: assistant-turn occurrences
  total_turns: z.number(), // size of cleaned dialogue (denominator for density)
  excerpts: z.array(SearchExcerptSchema),
});
type SearchHit = z.infer<typeof SearchHitSchema>;

/** Weighted-density relevance score:
 *   (3 * user_hits + asst_hits) / total_turns
 * Higher = the session is more topically concentrated on the query AND the
 * user themselves brought it up (user hits weighted ×3 because the user's own
 * words anchor "what they actually cared about", while assistant elaboration
 * is downstream noise). */
export function relevanceScore(h: SearchHit): number {
  if (h.total_turns === 0) return 0;
  return (3 * h.user_count + h.asst_count) / h.total_turns;
}

const FilterSchema = z.object({
  platform: z.union([PlatformSchema, z.literal("all")]),
  since: z.date().optional(),
  until: z.date().optional(),
  cwd: z.string().optional(),
  limit: z.number(),
});
type Filter = z.infer<typeof FilterSchema>;

const ArgvSchema = z.object({
  cmd: z.string(),
  positional: z.array(z.string()),
  flags: z.record(z.string(), z.union([z.string(), z.boolean()])),
});
type Argv = z.infer<typeof ArgvSchema>;

// ---------- schemas: external file formats ----------

// Claude Code JSONL events. We only declare the fields we read; everything
// else passes through. Content of an assistant `message` is an array of
// blocks (text / thinking / tool_use); content of a user `message` is a
// string for real human input or an array of tool_result blocks (skipped).

const ClaudeBlockSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
  })
  .loose();

const ClaudeMessageSchema = z
  .object({
    role: z.string().optional(),
    content: z.union([z.string(), z.array(ClaudeBlockSchema)]).optional(),
  })
  .loose();

const ClaudeEventSchema = z
  .object({
    type: z.string().optional(),
    cwd: z.string().optional(),
    timestamp: z.string().optional(),
    message: ClaudeMessageSchema.optional(),
    isCompactSummary: z.boolean().optional(),
  })
  .loose();

const ClaudeIndexEntrySchema = z
  .object({
    id: z.string(),
    cwd: z.string().optional(),
    created: z.string().optional(),
    title: z.string().optional(),
  })
  .loose();
const ClaudeIndexSchema = z
  .object({ entries: z.array(ClaudeIndexEntrySchema).optional() })
  .loose();

// Codex rollout JSONL events.

const CodexContentPartSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
  })
  .loose();

const CodexCompactedItemSchema = z
  .object({
    type: z.string().optional(),
    role: z.string().optional(),
    content: z.array(CodexContentPartSchema).optional(),
  })
  .loose();

const CodexPayloadSchema = z
  .object({
    type: z.string().optional(),
    role: z.string().optional(),
    cwd: z.string().optional(),
    id: z.string().optional(),
    content: z.array(CodexContentPartSchema).optional(),
    replacement_history: z.array(CodexCompactedItemSchema).optional(),
  })
  .loose();

const CodexEventSchema = z
  .object({
    timestamp: z.string().optional(),
    type: z.string().optional(),
    payload: CodexPayloadSchema.optional(),
  })
  .loose();

// ---------- argv ----------

export function parseArgv(argv: readonly string[]): Argv {
  const cmd = argv[0] ?? "list";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return ArgvSchema.parse({ cmd, positional, flags });
}

export function buildFilter(flags: Argv["flags"]): Filter {
  const platformRaw =
    typeof flags.platform === "string" ? flags.platform : "all";
  const platformParsed = z
    .union([PlatformSchema, z.literal("all")])
    .safeParse(platformRaw);
  if (!platformParsed.success) die(`unknown platform: ${platformRaw}`);

  const sinceRaw = flags.since;
  const since = typeof sinceRaw === "string" ? new Date(sinceRaw) : undefined;
  if (since && Number.isNaN(+since)) die(`bad --since: ${sinceRaw}`);

  const untilRaw = flags.until;
  const until =
    typeof untilRaw === "string"
      ? new Date(`${untilRaw}T23:59:59.999Z`)
      : undefined;
  if (until && Number.isNaN(+until)) die(`bad --until: ${untilRaw}`);

  const cwd = flags.global
    ? undefined
    : path.resolve(typeof flags.cwd === "string" ? flags.cwd : process.cwd());

  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 50;

  return FilterSchema.parse({
    platform: platformParsed.data,
    since,
    until,
    cwd,
    limit,
  });
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

// ---------- common helpers ----------

const HOME = os.homedir();

export function inRange(iso: string | undefined, f: Filter): boolean {
  if (!iso) return true;
  const t = new Date(iso);
  if (Number.isNaN(+t)) return true;
  if (f.since && t < f.since) return false;
  if (f.until && t > f.until) return false;
  return true;
}

/**
 * Interval-overlap version of `inRange` for sessions with both start and end
 * timestamps. A session is kept iff its lifetime `[start, end]` overlaps the
 * query window `[f.since, f.until]`.
 *
 * Why this exists: long / cross-day sessions (created on day N, still updated
 * on day N+M) were being dropped by `inRange(created, f)` when `--since` fell
 * after `created`. Switching to interval overlap keeps sessions that were
 * active inside the window even when they started before it.
 *
 * Degenerate inputs:
 *   - both undefined → pass through (no timestamp = don't filter)
 *   - one undefined → fall back to single-point semantics on the other end
 *   - unparseable iso → defer to the parsable end (or pass through if both bad)
 */
export function inRangeOverlap(
  start: string | undefined,
  end: string | undefined,
  f: Filter,
): boolean {
  const s = start ?? end;
  const e = end ?? start;
  if (!s && !e) return true;
  if (f.since && e) {
    const eT = new Date(e);
    if (!Number.isNaN(+eT) && eT < f.since) return false;
  }
  if (f.until && s) {
    const sT = new Date(s);
    if (!Number.isNaN(+sT) && sT > f.until) return false;
  }
  return true;
}

export function sameProject(
  sessionCwd: string | undefined,
  target: string | undefined,
): boolean {
  if (!target) return true;
  if (!sessionCwd) return false;
  const a = path.resolve(sessionCwd);
  const b = path.resolve(target);
  return a === b || a.startsWith(b + path.sep);
}

/** Walk JSONL line-by-line, calling `onLine` with each parsed object that
 * matches the supplied schema. Bad JSON or schema-mismatched lines are skipped.
 * Returning the literal "stop" from `onLine` halts iteration.
 *
 * Chunked sync streaming: 256 KB read window, leftover preserved across
 * chunks for split-line reassembly. Two practical wins over the original
 * `fs.readFileSync` + `data.split("\n")`:
 *
 * 1. **Bounded peek** — `readJsonlFirst` / `findInJsonl(maxLines<100)` only
 *    pull the first chunk (256 KB) and stop, instead of loading multi-MB
 *    rollout files in full just to read the head. 30-100× speedup on the
 *    listing fan-out path.
 * 2. **Heap floor** — full-scan paths (`extract` / `search`) keep ~256 KB +
 *    one leftover line resident instead of 36 MB sessions held as one big
 *    UTF-8 string. Roughly 30× peak-heap drop on long sessions.
 *
 * Byte-prefix fast-reject: a JSONL event line virtually always begins with
 * `{` (object). Lines starting with any other byte are blanks, log
 * preambles, or trailing whitespace — `JSON.parse` would throw and
 * `safeParse` would fail. Checking the first byte before allocating the
 * parse exception path saves measurable wall time on heavy sessions. */
function readJsonl<T>(
  file: string,
  schema: z.ZodType<T>,
  onLine: (obj: T) => unknown,
): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  const CHUNK = 256 * 1024;
  const OPEN_BRACE = 0x7b; // '{'
  const buf = Buffer.alloc(CHUNK);
  let leftover = "";
  try {
    let stop = false;
    while (!stop) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const chunk = leftover + buf.toString("utf8", 0, n);
      let from = 0;
      while (true) {
        const nl = chunk.indexOf("\n", from);
        if (nl === -1) {
          leftover = chunk.slice(from);
          break;
        }
        const line = chunk.slice(from, nl);
        from = nl + 1;
        if (!line) continue;
        // Byte-prefix fast-reject before JSON.parse / zod.
        if (line.charCodeAt(0) !== OPEN_BRACE) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) continue;
        if (onLine(parsed.data) === "stop") {
          stop = true;
          break;
        }
      }
    }
    if (!stop && leftover) {
      // File ended without trailing newline — process the last partial line.
      const line = leftover;
      if (line?.charCodeAt(0) === OPEN_BRACE) {
        try {
          const raw: unknown = JSON.parse(line);
          const parsed = schema.safeParse(raw);
          if (parsed.success) onLine(parsed.data);
        } catch {
          /* skip */
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonlFirst<T>(file: string, schema: z.ZodType<T>): T | undefined {
  let result: T | undefined;
  readJsonl(file, schema, (obj) => {
    result = obj;
    return "stop";
  });
  return result;
}

function findInJsonl<T>(
  file: string,
  schema: z.ZodType<T>,
  predicate: (obj: T) => boolean,
  maxLines = 200,
): T | undefined {
  let count = 0;
  let hit: T | undefined;
  readJsonl(file, schema, (obj) => {
    count++;
    if (predicate(obj)) {
      hit = obj;
      return "stop";
    }
    if (count >= maxLines) return "stop";
  });
  return hit;
}

function readJsonFile<T>(file: string, schema: z.ZodType<T>): T | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// ---------- dialogue cleaning ----------

const INJECTION_TAGS: readonly string[] = [
  "system-reminder",
  "task-status",
  "ready",
  "current-state",
  "workflow",
  "workflow-state",
  "guidelines",
  "instructions",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "permissions instructions",
  "collaboration_mode",
  "environment_context",
  "auto_compact_summary",
  "user_instructions",
];

/** True if this turn is a platform bootstrap injection (AGENTS.md, pure
 * INSTRUCTIONS preamble, etc.) and should be dropped wholesale rather than
 * partially cleaned. Detected after stripInjectionTags, so we look at what's
 * left after tag-stripping. */
export function isBootstrapTurn(
  cleaned: string,
  originalLength: number,
): boolean {
  if (cleaned.startsWith("# AGENTS.md instructions for")) return true;
  // A turn that's mostly an INSTRUCTIONS block (Codex injects this as user role).
  if (originalLength > 4000 && /^<INSTRUCTIONS>/i.test(cleaned)) return true;
  return false;
}

export function stripInjectionTags(text: string): string {
  let out = text;
  for (const tag of INJECTION_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Case-insensitive: Codex/Trellis injection tags appear as both <INSTRUCTIONS>
    // and <instructions> across platforms.
    out = out.replace(
      new RegExp(`<${escaped}[^>]*>[\\s\\S]*?</${escaped}>`, "gi"),
      "",
    );
  }
  out = out.replace(
    /^# AGENTS\.md instructions for[\s\S]*?(?=\n\n[A-Z一-龥]|$)/m,
    "",
  );
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Find the paragraph-aligned chunk surrounding a hit position. A "chunk" is
 * the contiguous text bounded by the nearest blank-line breaks (`\n\n`) on
 * either side. If the natural paragraph exceeds `maxChars`, fall back to a
 * centered char window — and report the truncation so callers can mark it. */
export function chunkAround(
  text: string,
  hitIdx: number,
  maxChars: number,
): { start: number; end: number; truncated: boolean } {
  const startPara = text.lastIndexOf("\n\n", hitIdx);
  let start = startPara === -1 ? 0 : startPara + 2;
  const endPara = text.indexOf("\n\n", hitIdx);
  let end = endPara === -1 ? text.length : endPara;
  let truncated = false;
  if (end - start > maxChars) {
    start = Math.max(0, hitIdx - Math.floor(maxChars / 2));
    end = Math.min(text.length, hitIdx + Math.ceil(maxChars / 2));
    truncated = true;
  }
  return { start, end, truncated };
}

/** Multi-token AND grep over cleaned dialogue. Whitespace-split tokens; a
 * turn matches if every token (case-insensitive) appears anywhere in it.
 * `count` is the total occurrence count across all tokens within matching
 * turns. Excerpts are paragraph-aligned chunks (drawer-style): for each
 * matching turn we collect chunks around every hit position, dedupe by
 * chunk start so adjacent hits inside the same paragraph collapse to one
 * chunk. User-role chunks are listed first (the user's own words anchor
 * topic intent more reliably than AI elaboration). */
export function searchInDialogue(
  turns: readonly DialogueTurn[],
  kw: string,
  maxExcerpts = 3,
  chunkChars = 400,
): SearchHit {
  const tokens = kw.toLowerCase().split(/\s+/).filter(Boolean);
  const empty: SearchHit = SearchHitSchema.parse({
    count: 0,
    user_count: 0,
    asst_count: 0,
    total_turns: turns.length,
    excerpts: [],
  });
  if (tokens.length === 0) return empty;

  let userCount = 0;
  let asstCount = 0;
  const userExcerpts: SearchHit["excerpts"] = [];
  const asstExcerpts: SearchHit["excerpts"] = [];

  for (const t of turns) {
    const hay = t.text.toLowerCase();
    if (!tokens.every((tok) => hay.includes(tok))) continue;

    // Collect every hit position with the token that produced it (for both
    // counting and rarity-aware chunk anchor selection).
    const hitPositions: { idx: number; tok: string }[] = [];
    const tokenFreq = new Map<string, number>();
    let turnHits = 0;
    for (const tok of tokens) {
      let from = 0;
      let n = 0;
      while (true) {
        const idx = hay.indexOf(tok, from);
        if (idx === -1) break;
        n++;
        turnHits++;
        hitPositions.push({ idx, tok });
        from = idx + tok.length;
      }
      tokenFreq.set(tok, n);
    }
    if (t.role === "user") userCount += turnHits;
    else asstCount += turnHits;
    hitPositions.sort((a, b) => a.idx - b.idx);

    // For each candidate anchor, score the chunk by:
    //   (1) coverage — how many distinct query tokens are visible inside
    //   (2) anchor rarity — when coverage is partial, prefer chunks anchored
    //       on the rarest token (its position best signals user intent in
    //       a corpus where common tokens like the project name are noise)
    //   (3) earliest start — final tie-break for stable ordering
    interface Candidate {
      start: number;
      end: number;
      truncated: boolean;
      coverage: number;
      rarity: number;
    }
    const candidates: Candidate[] = [];
    const seenStarts = new Set<number>();
    for (const { idx, tok } of hitPositions) {
      const { start, end, truncated } = chunkAround(t.text, idx, chunkChars);
      if (seenStarts.has(start)) continue;
      seenStarts.add(start);
      const slice = hay.slice(start, end);
      const coverage = tokens.filter((tk) => slice.includes(tk)).length;
      const rarity = 1 / (tokenFreq.get(tok) ?? 1);
      candidates.push({ start, end, truncated, coverage, rarity });
    }
    candidates.sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      if (b.rarity !== a.rarity) return b.rarity - a.rarity;
      return a.start - b.start;
    });
    for (const c of candidates) {
      let snippet = t.text.slice(c.start, c.end).trim();
      if (c.truncated) {
        if (c.start > 0) snippet = "…" + snippet;
        if (c.end < t.text.length) snippet += "…";
      }
      (t.role === "user" ? userExcerpts : asstExcerpts).push({
        role: t.role,
        snippet,
      });
    }
  }

  const excerpts = [...userExcerpts, ...asstExcerpts].slice(0, maxExcerpts);
  return SearchHitSchema.parse({
    count: userCount + asstCount,
    user_count: userCount,
    asst_count: asstCount,
    total_turns: turns.length,
    excerpts,
  });
}

// ---------- claude adapter ----------

const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");

function claudeProjectDirFromCwd(cwd: string): string {
  // Claude sanitizes path: every '/' and '_' becomes '-'.
  return path.join(CLAUDE_PROJECTS, cwd.replace(/[/_]/g, "-"));
}

export function claudeListSessions(f: Filter): SessionInfo[] {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const out: SessionInfo[] = [];
  const projectDirs: string[] = f.cwd
    ? [claudeProjectDirFromCwd(f.cwd)].filter((d) => fs.existsSync(d))
    : fs.readdirSync(CLAUDE_PROJECTS).map((d) => path.join(CLAUDE_PROJECTS, d));

  for (const dir of projectDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const indexFile = path.join(dir, "sessions-index.json");
    const index = readJsonFile(indexFile, ClaudeIndexSchema);
    const indexById = new Map<string, z.infer<typeof ClaudeIndexEntrySchema>>();
    for (const e of index?.entries ?? []) indexById.set(e.id, e);

    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, e.name);
      const id = e.name.replace(/\.jsonl$/, "");
      const idx = indexById.get(id);
      let cwd: string | undefined = idx?.cwd;
      let created: string | undefined = idx?.created;
      const title: string | undefined = idx?.title;

      if (!cwd || !created) {
        const evt = findInJsonl(
          filePath,
          ClaudeEventSchema,
          (o) => typeof o.cwd === "string",
          100,
        );
        cwd = cwd ?? evt?.cwd;
        created =
          created ??
          evt?.timestamp ??
          readJsonlFirst(filePath, ClaudeEventSchema)?.timestamp;
      }

      const stat = fs.statSync(filePath);
      const updated = stat.mtime.toISOString();
      // Interval overlap: keep sessions whose lifetime [created, updated]
      // intersects the query window. Cross-day sessions (created before
      // --since but still active inside it) must survive — see PRD
      // 05-08-mem-since-cross-day-filter.
      if (!inRangeOverlap(created, updated, f)) continue;
      if (f.cwd && cwd && !sameProject(cwd, f.cwd)) continue;

      out.push(
        SessionInfoSchema.parse({
          platform: "claude",
          id,
          title,
          cwd,
          created,
          updated,
          filePath,
        }),
      );
    }
  }
  return out;
}

export function claudeExtractDialogue(s: SessionInfo): DialogueTurn[] {
  // Mirrors session-insight/extract-session.py:
  //   - user: type=="user" + role=="user" + content is string (list = tool_result)
  //   - assistant: type=="assistant" + role=="assistant", keep only `text` blocks
  //   - thinking and tool_use blocks dropped entirely
  //   - injection tags stripped
  // Compaction: when we hit a `user` event with isCompactSummary=true, drop all
  // pre-compact turns and replace them with a synthetic [compact summary] turn —
  // the pre-compact content is now redundant with the summary.
  let turns: DialogueTurn[] = [];
  readJsonl(s.filePath, ClaudeEventSchema, (obj) => {
    const t = obj.type;
    const msg = obj.message;
    if (!msg) return;
    const content = msg.content;
    if (t === "user" && obj.isCompactSummary === true) {
      let summary = "";
      if (typeof content === "string") {
        summary = stripInjectionTags(content);
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            const cleaned = stripInjectionTags(block.text);
            if (cleaned) parts.push(cleaned);
          }
        }
        summary = parts.join("\n\n");
      }
      turns = summary
        ? [{ role: "user", text: `[compact summary]\n${summary}` }]
        : [];
      return;
    }
    if (t === "user" && msg.role === "user") {
      if (typeof content === "string") {
        const text = stripInjectionTags(content);
        if (text && !isBootstrapTurn(text, content.length)) {
          turns.push({ role: "user", text });
        }
      }
    } else if (
      t === "assistant" &&
      msg.role === "assistant" &&
      Array.isArray(content)
    ) {
      const parts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          const cleaned = stripInjectionTags(block.text);
          if (cleaned) parts.push(cleaned);
        }
      }
      if (parts.length)
        turns.push({ role: "assistant", text: parts.join("\n\n") });
    }
  });
  return turns;
}

export function claudeSearch(s: SessionInfo, kw: string): SearchHit {
  return searchInDialogue(claudeExtractDialogue(s), kw);
}

// ---------- phase slicing (brainstorm windows) ----------

/**
 * Parse a Bash command string and extract `task.py create|start` invocations.
 *
 * Returns null if the command does not invoke `task.py`. The detection is
 * intentionally lenient on invoker prefix — covers `python` / `python3` /
 * `py -3` / no-prefix (PATH + chmod +x) — and on path separator (`/`, `\`,
 * `\\` from JSONL re-escape). False-positive guard: `task.py` MUST be at the
 * start of the command, after a path separator, or preceded by whitespace —
 * never embedded inside a flag value like `--slug task.py-create-foo`.
 *
 * For `create`, the slug / title arg is captured as the first positional
 * argument after the verb (best-effort; not used to gate the match).
 *
 * For `start`, the task-dir path is captured as the first positional argument.
 */
export type ParsedTaskPyCommand =
  | { action: "create"; slug?: string; titleArg?: string }
  | { action: "start"; taskDir?: string };

/** Find ALL `task.py create|start` invocations in a single Bash command
 * string. A real Bash invocation can contain several (e.g.
 * `SMOKE=$(task.py create …); task.py start "$SMOKE"; …`); the original
 * single-match `parseTaskPyCommand` only saw the first one and silently
 * dropped the rest, breaking pairing in any session that used such patterns.
 *
 * Returned in source order. Each entry's `restRaw` is bounded to the next
 * `task.py` invocation or end-of-line, whichever comes first, so multi-action
 * one-liners are split safely without leaking later args into earlier ones. */
export function parseTaskPyCommandsAll(cmd: string): ParsedTaskPyCommand[] {
  if (typeof cmd !== "string" || cmd.length === 0) return [];
  // Find every `task.py (create|start)` occurrence with a left boundary of
  // start-of-string, whitespace, or path separator (forward or backward
  // slash). This rejects flag-value embedding like `--slug=task.py-create-foo`.
  const all: ParsedTaskPyCommand[] = [];
  const findRe = /(^|[\s/\\])task\.py\s+(create|start)(?:\s+|$)/g;
  const matches: { action: "create" | "start"; bodyStart: number }[] = [];
  for (const m of cmd.matchAll(findRe)) {
    const action = m[2] as "create" | "start";
    // bodyStart = right after the matched whitespace following the action verb
    const bodyStart = m.index + m[0].length;
    matches.push({ action, bodyStart });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    if (!cur) continue;
    const next = matches[i + 1];
    // restRaw stops at the next `task.py` invocation (so we don't claim args
    // from later commands), or end-of-string otherwise. Take only up to the
    // first newline — multi-line scripts have one task.py per line as the
    // dominant pattern.
    const slice = cmd.slice(cur.bodyStart, next?.bodyStart ?? cmd.length);
    const restRaw = (slice.split("\n")[0] ?? "").trim();
    // Reject prose-embedded matches. The pattern is: a bare alphanumeric word
    // followed by another all-letters word with a single space gap — that's
    // English prose like "task.py start exits with hint", not a real
    // invocation (CLI args after the action are typically quoted titles,
    // dashed flags, paths starting with `.` `/` `~` `$`, or followed by shell
    // metacharacters like `2>&1` / `|` / `;`). A real `create my-task`
    // (single bare positional with no trailing English) is kept.
    if (/^[A-Za-z][A-Za-z0-9_-]*\s+[A-Za-z]{2,}\b/.test(restRaw)) continue;
    const parsed = parseRestOfTaskPyCommand(cur.action, restRaw);
    // Drop entries with no extractable info — likely prose with quote-like
    // punctuation but no real arg.
    if (
      cur.action === "create" &&
      parsed.action === "create" &&
      !parsed.slug &&
      !parsed.titleArg
    )
      continue;
    if (cur.action === "start" && parsed.action === "start" && !parsed.taskDir)
      continue;
    all.push(parsed);
  }
  return all;
}

/** Single-result wrapper for backwards compatibility (returns the first
 * occurrence, or null if none). Existing tests that assume single-match
 * semantics still pass via this helper; new code should call
 * `parseTaskPyCommandsAll`. */
export function parseTaskPyCommand(cmd: string): ParsedTaskPyCommand | null {
  const all = parseTaskPyCommandsAll(cmd);
  return all[0] ?? null;
}

function parseRestOfTaskPyCommand(
  action: "create" | "start",
  restRaw: string,
): ParsedTaskPyCommand {
  if (action === "create") {
    const args = splitShellArgs(restRaw);
    // First positional arg (skip any flags). For `task.py create`, the title
    // is typically the first quoted positional; --slug FOO appears as a flag.
    let slug: string | undefined;
    let titleArg: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === undefined) continue;
      if (a === "--slug" || a === "-s") {
        slug = args[i + 1];
        i++;
        continue;
      }
      if (a.startsWith("--slug=")) {
        slug = a.slice("--slug=".length);
        continue;
      }
      if (a.startsWith("-")) continue;
      titleArg ??= a;
    }
    return { action: "create", slug, titleArg };
  }
  // start
  const args = splitShellArgs(restRaw);
  let taskDir: string | undefined;
  for (const a of args) {
    if (a.startsWith("-")) continue;
    taskDir = a;
    break;
  }
  return { action: "start", taskDir };
}

/** Best-effort shell-arg splitter: respects `"…"` and `'…'` quoting, splits on
 * whitespace, treats shell metacharacters `;`, `|`, `&`, `(`, `)`, `>` as
 * **token boundaries** (so `$(...)` substitution boundaries, command chains,
 * and redirects don't leak into the next positional arg). Also strips any
 * trailing shell-meta cruft from individual tokens — e.g. a `--slug` value
 * captured inside `$(... --slug FOO)` gets the closing `)` lopped off.
 * Sufficient for parsing slugs/paths out of `task.py create|start`
 * invocations; not a full POSIX parser. */
function splitShellArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  const flush = (): void => {
    if (!cur) return;
    // Strip trailing shell metas that snuck in from $(...) substitution edges,
    // command chains, redirects, etc. Keep leading chars (paths may start with
    // `.` or `/`).
    const cleaned = cur.replace(/[)};&|>]+$/, "");
    if (cleaned) out.push(cleaned);
    cur = "";
  };
  for (const ch of s) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    // Hard token boundaries — these never belong inside a slug or path arg.
    // Drop them (don't keep as standalone token; the caller never wants them).
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

/** Derive a slug from a `start` task-dir path like
 * `.trellis/tasks/05-08-mem-phase-slice/` → `mem-phase-slice` (the
 * `MM-DD-` date prefix is stripped so this matches the slug supplied via
 * `--slug` on the corresponding `task.py create` invocation). */
function slugFromTaskDir(p: string | undefined): string | undefined {
  if (!p) return undefined;
  // Normalize separators and trim trailing slash + shell metas leaked from
  // `$(...)` substitution / heredoc edges.
  const norm = p.replace(/\\+/g, "/").replace(/\/+$/g, "");
  const parts = norm.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === undefined) return undefined;
  // Strip leading `MM-DD-` (e.g. `05-08-`) added by task.py.
  return last.replace(/^\d{2}-\d{2}-/, "");
}

export interface TaskPyEvent {
  action: "create" | "start";
  timestamp: string;
  /** Index into the cleaned DialogueTurn[] array — points to the next turn
   * that would be appended after this Bash tool_use event was emitted. */
  turnIndex: number;
  slug?: string;
  taskDir?: string;
}

/**
 * Single-pass scan of a Claude JSONL file that produces both:
 *   1. the cleaned dialogue turns (semantically identical to
 *      `claudeExtractDialogue`)
 *   2. the list of `task.py create|start` Bash tool_use events with their
 *      `turnIndex` (= turns.length AT THE TIME the tool_use was seen).
 *
 * Why one pass: we need the turnIndex to align with `claudeExtractDialogue`'s
 * output exactly, including compaction-reset behavior. A second pass would
 * have to re-derive turn indices from timestamps, which is fragile when
 * timestamps repeat or are missing.
 *
 * For non-Claude platforms this returns turns + an empty event list; callers
 * are expected to handle Codex/OpenCode boundary detection separately (or
 * gracefully degrade — see PRD MVP scope).
 */
export function collectClaudeTurnsAndEvents(s: SessionInfo): {
  turns: DialogueTurn[];
  events: TaskPyEvent[];
} {
  let turns: DialogueTurn[] = [];
  let events: TaskPyEvent[] = [];

  readJsonl(s.filePath, ClaudeEventSchema, (obj) => {
    const t = obj.type;
    const msg = obj.message;
    if (!msg) return;
    const content = msg.content;

    if (t === "user" && obj.isCompactSummary === true) {
      let summary = "";
      if (typeof content === "string") {
        summary = stripInjectionTags(content);
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            const cleaned = stripInjectionTags(block.text);
            if (cleaned) parts.push(cleaned);
          }
        }
        summary = parts.join("\n\n");
      }
      turns = summary
        ? [{ role: "user", text: `[compact summary]\n${summary}` }]
        : [];
      // Reset events too: pre-compact task.py events anchor to turnIndex
      // values that no longer correspond to real turns (the underlying
      // dialogue is collapsed into a single synthetic [compact summary]).
      // Pairing pre-compact events to post-compact turns would produce
      // incoherent windows.
      events = [];
      return;
    }

    if (t === "user" && msg.role === "user") {
      if (typeof content === "string") {
        const text = stripInjectionTags(content);
        if (text && !isBootstrapTurn(text, content.length)) {
          turns.push({ role: "user", text });
        }
      }
      return;
    }

    if (
      t === "assistant" &&
      msg.role === "assistant" &&
      Array.isArray(content)
    ) {
      // Walk blocks: text blocks contribute to the eventual cleaned turn;
      // tool_use blocks with name="Bash" are scanned for task.py invocations.
      const parts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          const cleaned = stripInjectionTags(block.text);
          if (cleaned) parts.push(cleaned);
        } else if (block.type === "tool_use") {
          // Schema is loose so we read fields off the block directly.
          const b = block as { name?: unknown; input?: unknown };
          if (b.name !== "Bash") continue;
          const inp = b.input;
          if (!inp || typeof inp !== "object") continue;
          const command = (inp as { command?: unknown }).command;
          if (typeof command !== "string") continue;
          // A Bash command may invoke task.py multiple times (e.g.
          // `SMOKE=$(task.py create …); task.py start "$SMOKE"`). Capture
          // every occurrence — the original single-match version dropped
          // the second invocation and produced unpaired windows.
          const parsedAll = parseTaskPyCommandsAll(command);
          for (const parsed of parsedAll) {
            // turnIndex = current turns.length (the index this assistant turn
            // WILL occupy if its text parts are non-empty; either way, it's
            // the cut point for "everything before this Bash event"). For
            // assistant messages where text comes BEFORE tool_use blocks, the
            // assistant turn is appended AFTER this loop completes, so using
            // turns.length here means the boundary lies just before that turn.
            // We accept this small drift: brainstorm slicing is at granularity
            // of full turns, not intra-turn substrings.
            const ev: TaskPyEvent = {
              action: parsed.action,
              timestamp: obj.timestamp ?? "",
              turnIndex: turns.length,
              ...(parsed.action === "create"
                ? { slug: parsed.slug }
                : { taskDir: parsed.taskDir }),
            };
            events.push(ev);
          }
        }
      }
      if (parts.length)
        turns.push({ role: "assistant", text: parts.join("\n\n") });
    }
  });

  return { turns, events };
}

export interface BrainstormWindow {
  label: string;
  /** inclusive */
  startTurn: number;
  /** exclusive */
  endTurn: number;
}

/**
 * Pair `create` → `start` events into brainstorm windows.
 *
 * Pairing strategy:
 *   1. Walk events in order.
 *   2. For each `create`, find the next unmatched `start` whose slug matches
 *      (slug derived from `start` taskDir's last path segment) — slug match
 *      wins regardless of position.
 *   3. If no slug match: pair with the next unmatched `start` by position
 *      (FIFO).
 *   4. Unmatched `create` (no following `start`): window = [create, totalTurns).
 *   5. Unmatched `start` (no preceding `create`): window = [0, start).
 *
 * Window labels: `<slug>` if known, else `window-N`.
 */
export function buildBrainstormWindows(
  events: readonly TaskPyEvent[],
  totalTurns: number,
): BrainstormWindow[] {
  const creates = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.action === "create");
  const starts = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.action === "start");

  const usedStartIdx = new Set<number>();
  const windows: BrainstormWindow[] = [];
  let windowCounter = 0;

  const usedCreateIdx = new Set<number>();

  // Pass 1: pair by slug match (slug present on the `create`, matches the
  // last segment of the `start` taskDir). Slug match wins over position.
  for (const { e: createEv, i: ci } of creates) {
    if (!createEv.slug) continue;
    const matchIdx = starts.findIndex(
      ({ e, i }) =>
        !usedStartIdx.has(i) && slugFromTaskDir(e.taskDir) === createEv.slug,
    );
    if (matchIdx === -1) continue;
    const startEntry = starts[matchIdx];
    if (!startEntry) continue;
    usedStartIdx.add(startEntry.i);
    usedCreateIdx.add(ci);
    pushWindow(
      windows,
      createEv.turnIndex,
      startEntry.e.turnIndex,
      createEv.slug,
      ++windowCounter,
    );
  }

  // Pass 2: FIFO pair remaining creates with remaining starts that appear
  // AFTER the create (by event order).
  for (const { e: createEv, i: ci } of creates) {
    if (usedCreateIdx.has(ci)) continue;
    const pairedStart = starts.find(({ i }) => !usedStartIdx.has(i) && i > ci);
    if (pairedStart) {
      usedStartIdx.add(pairedStart.i);
      usedCreateIdx.add(ci);
      const slug = createEv.slug ?? slugFromTaskDir(pairedStart.e.taskDir);
      pushWindow(
        windows,
        createEv.turnIndex,
        pairedStart.e.turnIndex,
        slug,
        ++windowCounter,
      );
    } else {
      // Fallback A: create with no start → [create, end).
      usedCreateIdx.add(ci);
      pushWindow(
        windows,
        createEv.turnIndex,
        totalTurns,
        createEv.slug,
        ++windowCounter,
      );
    }
  }

  // Pass 3: unmatched starts (start with no preceding create) → [0, start).
  // Fallback B: task was created in an earlier session.
  for (const { e: startEv, i } of starts) {
    if (usedStartIdx.has(i)) continue;
    pushWindow(
      windows,
      0,
      startEv.turnIndex,
      slugFromTaskDir(startEv.taskDir),
      ++windowCounter,
    );
  }

  // Sort windows by startTurn for stable output ordering.
  windows.sort((a, b) => a.startTurn - b.startTurn);
  return windows;
}

function pushWindow(
  windows: BrainstormWindow[],
  startTurn: number,
  endTurn: number,
  slug: string | undefined,
  counter: number,
): void {
  // Guard: if start > end (e.g., start before create due to event interleave),
  // skip the malformed window rather than emit an empty / negative slice.
  if (endTurn < startTurn) return;
  windows.push({
    label: slug ?? `window-${counter}`,
    startTurn,
    endTurn,
  });
}

// ---------- codex adapter ----------

const CODEX_SESSIONS = path.join(HOME, ".codex", "sessions");

function* walkDir(root: string): Generator<string> {
  if (!fs.existsSync(root)) return;
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) yield p;
    }
  }
}

export function codexListSessions(f: Filter): SessionInfo[] {
  if (!fs.existsSync(CODEX_SESSIONS)) return [];
  const out: SessionInfo[] = [];
  for (const file of walkDir(CODEX_SESSIONS)) {
    if (!file.endsWith(".jsonl")) continue;
    const base = path.basename(file, ".jsonl");
    const m = base.match(
      /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)$/,
    );
    const tsFromName = m?.[1]
      ? new Date(
          m[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3") + "Z",
        ).toISOString()
      : undefined;
    // Note: we previously short-circuited on `!inRange(tsFromName, f)` here,
    // but the filename ts is the session's creation time — a cross-day session
    // that started before --since but was active inside it would be dropped.
    // Filter at the same place as claude/opencode using interval overlap.

    const first = readJsonlFirst(file, CodexEventSchema);
    const meta = first?.payload;
    const id = meta?.id ?? m?.[2] ?? base;
    const cwd = meta?.cwd;
    const created = first?.timestamp ?? tsFromName ?? "";

    if (f.cwd && !sameProject(cwd, f.cwd)) continue;
    const updated = fs.statSync(file).mtime.toISOString();
    if (!inRangeOverlap(created, updated, f)) continue;

    out.push(
      SessionInfoSchema.parse({
        platform: "codex",
        id,
        cwd,
        created,
        updated,
        filePath: file,
      }),
    );
  }
  return out;
}

export function codexExtractDialogue(s: SessionInfo): DialogueTurn[] {
  // Codex events: payload.type=="message" with role in {user, assistant, developer, system}.
  // Keep user/assistant only. Each content part is {type: "input_text"|"output_text", text}.
  // Codex inlines a lot of system prompt as the first user message (AGENTS.md, permission
  // blocks, etc.) — stripInjectionTags removes the bulk; turns that are pure boilerplate
  // collapse to empty after strip and get dropped here.
  // Compaction: a top-level event with type=="compacted" carries a payload.replacement_history
  // array — the new authoritative history replacing everything before. We reset turns and
  // re-seed from replacement_history.
  let turns: DialogueTurn[] = [];

  const buildTurnFromMessage = (
    role: DialogueRole,
    parts: { type?: string; text?: string }[] | undefined,
  ): DialogueTurn | null => {
    const collected: string[] = [];
    let totalRaw = 0;
    for (const c of parts ?? []) {
      const txt = c.text;
      if (typeof txt !== "string") continue;
      if (c.type !== "input_text" && c.type !== "output_text") continue;
      totalRaw += txt.length;
      const cleaned = stripInjectionTags(txt);
      if (cleaned) collected.push(cleaned);
    }
    if (!collected.length) return null;
    const merged = collected.join("\n\n");
    if (isBootstrapTurn(merged, totalRaw)) return null;
    return { role, text: merged };
  };

  readJsonl(s.filePath, CodexEventSchema, (obj) => {
    if (obj.type === "compacted") {
      const rh = obj.payload?.replacement_history;
      turns = [];
      if (!Array.isArray(rh)) return;
      for (const item of rh) {
        if (item.type !== "message") continue;
        const r = DialogueRoleSchema.safeParse(item.role);
        if (!r.success) continue;
        const turn = buildTurnFromMessage(r.data, item.content);
        if (turn)
          turns.push({ role: turn.role, text: `[compact]\n${turn.text}` });
      }
      return;
    }

    const p = obj.payload;
    if (p?.type !== "message") return;
    const roleParsed = DialogueRoleSchema.safeParse(p.role);
    if (!roleParsed.success) return;
    const turn = buildTurnFromMessage(roleParsed.data, p.content);
    if (turn) turns.push(turn);
  });
  return turns;
}

export function codexSearch(s: SessionInfo, kw: string): SearchHit {
  return searchInDialogue(codexExtractDialogue(s), kw);
}

/** Codex twin of `collectClaudeTurnsAndEvents`. Single pass over the rollout
 * file; emits both the cleaned dialogue turns (semantically identical to
 * `codexExtractDialogue`) AND the list of `task.py create|start` invocations
 * found inside `function_call` events whose `name === "exec_command"` (Codex's
 * stable shell tool). Compaction resets both turns AND events for the same
 * reason as the Claude collector — pre-compact event indices stop pointing at
 * real turns once history is replaced. */
export function collectCodexTurnsAndEvents(s: SessionInfo): {
  turns: DialogueTurn[];
  events: TaskPyEvent[];
} {
  let turns: DialogueTurn[] = [];
  let events: TaskPyEvent[] = [];

  const buildTurnFromMessage = (
    role: DialogueRole,
    parts: { type?: string; text?: string }[] | undefined,
  ): DialogueTurn | null => {
    const collected: string[] = [];
    let totalRaw = 0;
    for (const c of parts ?? []) {
      const txt = c.text;
      if (typeof txt !== "string") continue;
      if (c.type !== "input_text" && c.type !== "output_text") continue;
      totalRaw += txt.length;
      const cleaned = stripInjectionTags(txt);
      if (cleaned) collected.push(cleaned);
    }
    if (!collected.length) return null;
    const merged = collected.join("\n\n");
    if (isBootstrapTurn(merged, totalRaw)) return null;
    return { role, text: merged };
  };

  readJsonl(s.filePath, CodexEventSchema, (obj) => {
    if (obj.type === "compacted") {
      const rh = obj.payload?.replacement_history;
      turns = [];
      events = [];
      if (!Array.isArray(rh)) return;
      for (const item of rh) {
        if (item.type !== "message") continue;
        const r = DialogueRoleSchema.safeParse(item.role);
        if (!r.success) continue;
        const turn = buildTurnFromMessage(r.data, item.content);
        if (turn)
          turns.push({ role: turn.role, text: `[compact]\n${turn.text}` });
      }
      return;
    }

    const p = obj.payload;
    if (!p) return;

    // Function-call events (Codex's shell tool dispatch). The schema is loose
    // so we read fields off the raw payload.
    if ((p as { type?: unknown }).type === "function_call") {
      const fnName = (p as { name?: unknown }).name;
      if (fnName !== "exec_command" && fnName !== "shell") return;
      const argsRaw = (p as { arguments?: unknown }).arguments;
      let cmd: string | undefined;
      if (typeof argsRaw === "string") {
        try {
          const parsed: unknown = JSON.parse(argsRaw);
          if (parsed && typeof parsed === "object") {
            const c = (parsed as { cmd?: unknown; command?: unknown }).cmd;
            if (typeof c === "string") cmd = c;
            else {
              const c2 = (parsed as { command?: unknown }).command;
              if (typeof c2 === "string") cmd = c2;
            }
          }
        } catch {
          // arguments not JSON (some Codex versions inline a string) — try as
          // raw shell.
          cmd = argsRaw;
        }
      }
      if (!cmd) return;
      const parsedAll = parseTaskPyCommandsAll(cmd);
      for (const parsed of parsedAll) {
        const ev: TaskPyEvent = {
          action: parsed.action,
          timestamp: obj.timestamp ?? "",
          turnIndex: turns.length,
          ...(parsed.action === "create"
            ? { slug: parsed.slug }
            : { taskDir: parsed.taskDir }),
        };
        events.push(ev);
      }
      return;
    }

    // Real conversational turn.
    if ((p as { type?: unknown }).type !== "message") return;
    const roleParsed = DialogueRoleSchema.safeParse(
      (p as { role?: unknown }).role,
    );
    if (!roleParsed.success) return;
    const turn = buildTurnFromMessage(
      roleParsed.data,
      (p as { content?: { type?: string; text?: string }[] }).content,
    );
    if (turn) turns.push(turn);
  });

  return { turns, events };
}

// ---------- opencode adapter (temporarily unavailable) ----------
//
// OpenCode 1.2+ migrated to a SQLite database at
// ~/.local/share/opencode/opencode.db. The previous SQLite reader required
// `better-sqlite3` (a native dep). In 0.6.0-beta.4 we reverted that dep
// because its prebuilt-tarball download from GitHub Releases was unreliable
// in some networks (notably Windows + China), and the source-build fallback
// requires a C compiler that most users don't have — `npm install` was
// failing for the entire CLI, not just the OpenCode reader.
//
// The three exported adapter functions are kept (callers in dispatch /
// slicePhase rely on them) but degraded to no-ops with a one-shot stderr
// warning. Re-enabled in a future release once a non-native fallback ships.

let opencodeWarned = false;
function warnOpencodeUnavailable(): void {
  if (opencodeWarned) return;
  opencodeWarned = true;
  process.stderr.write(
    "⚠️  tl mem: OpenCode platform reader is temporarily unavailable in this build.\n" +
      "    OpenCode 1.2+ moved to SQLite; the native dependency was reverted in\n" +
      "    0.6.0-beta.4 due to install failures. Re-enabled in a future release.\n",
  );
}

export function opencodeListSessions(_f: Filter): SessionInfo[] {
  warnOpencodeUnavailable();
  return [];
}

export function opencodeExtractDialogue(_s: SessionInfo): DialogueTurn[] {
  warnOpencodeUnavailable();
  return [];
}

function opencodeSearch(_s: SessionInfo, kw: string): SearchHit {
  warnOpencodeUnavailable();
  return searchInDialogue([], kw);
}

// ---------- dispatch ----------

function listAll(f: Filter): SessionInfo[] {
  const all: SessionInfo[] = [];
  if (f.platform === "all" || f.platform === "claude")
    all.push(...claudeListSessions(f));
  if (f.platform === "all" || f.platform === "codex")
    all.push(...codexListSessions(f));
  if (f.platform === "all" || f.platform === "opencode")
    all.push(...opencodeListSessions(f));
  all.sort((a, b) =>
    (b.updated ?? b.created ?? "").localeCompare(a.updated ?? a.created ?? ""),
  );
  return all.slice(0, f.limit);
}

function extractDialogue(s: SessionInfo): DialogueTurn[] {
  switch (s.platform) {
    case "claude":
      return claudeExtractDialogue(s);
    case "codex":
      return codexExtractDialogue(s);
    case "opencode":
      return opencodeExtractDialogue(s);
  }
}

function searchSession(s: SessionInfo, kw: string): SearchHit {
  switch (s.platform) {
    case "claude":
      return claudeSearch(s, kw);
    case "codex":
      return codexSearch(s, kw);
    case "opencode":
      return opencodeSearch(s, kw);
  }
}

/** Build parent → descendants index for OpenCode (transitively flattened).
 * Other platforms have no native parent_id so they pass through unchanged. */
function buildChildIndex(
  sessions: readonly SessionInfo[],
): Map<string, SessionInfo[]> {
  const directChildren = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!s.parent_id) continue;
    const list = directChildren.get(s.parent_id) ?? [];
    list.push(s);
    directChildren.set(s.parent_id, list);
  }
  // Transitive flatten: each parent maps to *all* descendants.
  const out = new Map<string, SessionInfo[]>();
  for (const [pid] of directChildren) {
    const stack = [...(directChildren.get(pid) ?? [])];
    const flat: SessionInfo[] = [];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === undefined) break;
      flat.push(cur);
      for (const c of directChildren.get(cur.id) ?? []) stack.push(c);
    }
    out.set(pid, flat);
  }
  return out;
}

function searchSessionWithChildren(
  s: SessionInfo,
  kw: string,
  childIndex: Map<string, SessionInfo[]>,
): SearchHit {
  const children = childIndex.get(s.id) ?? [];
  if (children.length === 0) return searchSession(s, kw);
  // Concatenate parent + descendants' cleaned dialogue, then run a single
  // search over the merged turn list. This way scores reflect total topic
  // density across the sub-agent tree.
  const merged: DialogueTurn[] = [...extractDialogue(s)];
  for (const c of children) merged.push(...extractDialogue(c));
  return searchInDialogue(merged, kw);
}

function findSessionById(id: string, f: Filter): SessionInfo | undefined {
  const wide: Filter = { ...f, cwd: undefined, limit: 1_000_000 };
  const all = listAll(wide);
  return all.find((s) => s.id === id) ?? all.find((s) => s.id.startsWith(id));
}

// ---------- formatting ----------

export function shortDate(iso?: string): string {
  if (!iso) return "         ";
  return iso.slice(0, 16).replace("T", " ");
}

export function shortPath(p?: string): string {
  if (!p) return "(no cwd)";
  return p.replace(HOME, "~");
}

function printSessions(rows: readonly SessionInfo[]): void {
  if (rows.length === 0) {
    console.log("(no sessions)");
    return;
  }
  for (const s of rows) {
    const id = s.id.length > 12 ? s.id.slice(0, 12) : s.id.padEnd(12);
    const parentTag = s.parent_id
      ? `  ↳ child of ${s.parent_id.slice(0, 12)}`
      : "";
    console.log(
      `[${s.platform.padEnd(8)}] ${shortDate(s.updated ?? s.created)}  ${id}  ${shortPath(s.cwd)}` +
        (s.title ? `  — ${s.title}` : "") +
        parentTag,
    );
  }
}

// ---------- commands ----------

function cmdList(argv: Argv): void {
  const f = buildFilter(argv.flags);
  const rows = listAll(f);
  if (argv.flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(
    `scope: ${f.cwd ? `project=${shortPath(f.cwd)}` : "global"}  platform=${f.platform}` +
      (f.since ? `  since=${f.since.toISOString().slice(0, 10)}` : "") +
      (f.until ? `  until=${f.until.toISOString().slice(0, 10)}` : ""),
  );
  printSessions(rows);
  console.log(`\n${rows.length} session(s)`);
}

function cmdSearch(argv: Argv): void {
  const kw = argv.positional[0];
  if (!kw) die("usage: search <keyword>");
  const f = buildFilter(argv.flags);
  const wide: Filter = { ...f, limit: 1_000_000 };
  const candidates = listAll(wide);
  const includeChildren = argv.flags["include-children"] === true;

  // When --include-children is set: search over the merged dialogue of each
  // session plus its descendants (only OpenCode populates parent_id natively).
  // Children whose parent is also in the candidate set are dropped from the
  // result list — they get absorbed into the parent's hit.
  const childIndex = includeChildren ? buildChildIndex(candidates) : new Map();
  const candidateIds = new Set(candidates.map((s) => s.id));
  const isAbsorbedChild = (s: SessionInfo): boolean =>
    includeChildren &&
    s.parent_id !== undefined &&
    candidateIds.has(s.parent_id);

  interface Match {
    s: SessionInfo;
    hit: SearchHit;
    descendants: number;
  }
  const matches: Match[] = [];
  for (const s of candidates) {
    if (isAbsorbedChild(s)) continue;
    const hit = includeChildren
      ? searchSessionWithChildren(s, kw, childIndex)
      : searchSession(s, kw);
    if (hit.count === 0) continue;
    matches.push({ s, hit, descendants: childIndex.get(s.id)?.length ?? 0 });
  }
  // Rank by weighted-density relevance score: user hits matter ×3, normalized
  // by total dialogue length so a tight 18-hit short session beats a sprawling
  // 58-hit long one. Tie-break on raw count, then recency.
  matches.sort((a, b) => {
    const sa = relevanceScore(a.hit);
    const sb = relevanceScore(b.hit);
    if (sb !== sa) return sb - sa;
    if (b.hit.count !== a.hit.count) return b.hit.count - a.hit.count;
    return (b.s.updated ?? b.s.created ?? "").localeCompare(
      a.s.updated ?? a.s.created ?? "",
    );
  });
  const top = matches.slice(0, f.limit);

  if (argv.flags.json) {
    console.log(
      JSON.stringify(
        top.map(({ s, hit, descendants }) => ({
          session: s,
          score: Number(relevanceScore(hit).toFixed(4)),
          hit_count: hit.count,
          user_count: hit.user_count,
          asst_count: hit.asst_count,
          total_turns: hit.total_turns,
          descendants_merged: includeChildren ? descendants : 0,
          excerpts: hit.excerpts,
        })),
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `scope: ${f.cwd ? `project=${shortPath(f.cwd)}` : "global"}  keyword="${kw}"  platform=${f.platform}` +
      (includeChildren ? `  include-children=on` : ""),
  );
  if (top.length === 0) {
    console.log("(no matches)");
    return;
  }
  for (const { s, hit, descendants } of top) {
    const idShort = s.id.slice(0, 12);
    const score = relevanceScore(hit).toFixed(3);
    const childTag =
      includeChildren && descendants > 0 ? `  +${descendants} child` : "";
    console.log(
      `\n[${s.platform.padEnd(8)}] ${shortDate(s.updated ?? s.created)}  ${idShort}  ${shortPath(s.cwd)}` +
        `  score=${score}  hits=${hit.count} (u=${hit.user_count},a=${hit.asst_count})  turns=${hit.total_turns}${childTag}` +
        (s.title ? `  — ${s.title}` : ""),
    );
    for (const ex of hit.excerpts) {
      console.log(`    [${ex.role}] ${ex.snippet}`);
    }
  }
  console.log(
    `\n${top.length} session(s)${matches.length > top.length ? ` (of ${matches.length})` : ""}`,
  );
}

function cmdProjects(argv: Argv): void {
  // List distinct cwds across all platforms with last-active timestamp + per-platform
  // session counts. Designed for AI consumption: AI calls this first to learn which
  // "门牌号" (project paths) have recent activity, then picks one for `--cwd` in
  // a follow-up `search`.
  const f = buildFilter({ ...argv.flags, global: true });
  const wide: Filter = { ...f, cwd: undefined, limit: 1_000_000 };
  const all = listAll(wide);

  interface Agg {
    cwd: string;
    last_active: string;
    sessions: number;
    by_platform: Record<Platform, number>;
  }
  const byCwd = new Map<string, Agg>();
  for (const s of all) {
    if (!s.cwd) continue;
    const ts = s.updated ?? s.created ?? "";
    let agg = byCwd.get(s.cwd);
    if (!agg) {
      agg = {
        cwd: s.cwd,
        last_active: ts,
        sessions: 0,
        by_platform: { claude: 0, codex: 0, opencode: 0 },
      };
      byCwd.set(s.cwd, agg);
    }
    agg.sessions++;
    agg.by_platform[s.platform]++;
    if (ts > agg.last_active) agg.last_active = ts;
  }
  const rows = [...byCwd.values()].sort((a, b) =>
    b.last_active.localeCompare(a.last_active),
  );
  const limit =
    typeof argv.flags.limit === "string" ? Number(argv.flags.limit) : 30;
  const top = rows.slice(0, limit);

  if (argv.flags.json) {
    console.log(JSON.stringify(top, null, 2));
    return;
  }
  console.log(
    `active projects` +
      (f.since ? `  since=${f.since.toISOString().slice(0, 10)}` : "") +
      (f.until ? `  until=${f.until.toISOString().slice(0, 10)}` : ""),
  );
  if (top.length === 0) {
    console.log("(none)");
    return;
  }
  for (const r of top) {
    const parts = (Object.entries(r.by_platform) as [Platform, number][])
      .filter(([, n]) => n > 0)
      .map(([p, n]) => `${p}:${n}`)
      .join(" ");
    console.log(
      `${shortDate(r.last_active)}  sessions=${r.sessions.toString().padStart(3)} (${parts})  ${shortPath(r.cwd)}`,
    );
  }
  console.log(
    `\n${top.length} project(s)${rows.length > top.length ? ` (of ${rows.length})` : ""}`,
  );
}

function cmdContext(argv: Argv): void {
  // Drill-down step 2 in the search workflow:
  //   1. `search <kw>` → pick a session
  //   2. `context <id> --grep <kw> --turns N --around M` → top-N hit turns with M
  //      turns of context on either side, token-budgeted for AI consumption
  //
  // Without --grep: returns the first N turns (lets AI inspect session opening).
  // With --grep: ranks turns by (user-role first, then hit density), takes top-N,
  // then expands each by --around turns of surrounding context.
  const id = argv.positional[0];
  if (!id)
    die("usage: context <session-id> [--grep KW] [--turns N] [--around M]");
  const f = buildFilter(argv.flags);
  const s = findSessionById(id, f);
  if (!s) die(`session not found: ${id}`);

  const grepRaw = argv.flags.grep;
  const grep = typeof grepRaw === "string" ? grepRaw : undefined;
  const nTurns =
    typeof argv.flags.turns === "string" ? Number(argv.flags.turns) : 3;
  const around =
    typeof argv.flags.around === "string" ? Number(argv.flags.around) : 1;
  const maxChars =
    typeof argv.flags["max-chars"] === "string"
      ? Number(argv.flags["max-chars"])
      : 6000;

  let turns: DialogueTurn[] = extractDialogue(s);
  let mergedChildren = 0;
  if (argv.flags["include-children"] === true) {
    const all = listAll({ ...f, cwd: undefined, limit: 1_000_000 });
    const childIndex = buildChildIndex(all);
    const kids = childIndex.get(s.id) ?? [];
    mergedChildren = kids.length;
    for (const c of kids) turns = [...turns, ...extractDialogue(c)];
  }

  let hitIndices: number[] = [];
  let totalHitTurns = 0;
  if (grep) {
    const tokens = grep.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) die("--grep requires non-empty value");
    const matchCount = (text: string): number => {
      const hay = text.toLowerCase();
      if (!tokens.every((tok) => hay.includes(tok))) return 0;
      let n = 0;
      for (const tok of tokens) {
        let from = 0;
        while (true) {
          const idx = hay.indexOf(tok, from);
          if (idx === -1) break;
          n++;
          from = idx + tok.length;
        }
      }
      return n;
    };
    const ranked: { idx: number; role: DialogueRole; hits: number }[] = [];
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (!turn) continue;
      const h = matchCount(turn.text);
      if (h > 0) ranked.push({ idx: i, role: turn.role, hits: h });
    }
    totalHitTurns = ranked.length;
    ranked.sort((a, b) => {
      if (a.role !== b.role) return a.role === "user" ? -1 : 1;
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.idx - b.idx;
    });
    hitIndices = ranked.slice(0, nTurns).map((r) => r.idx);
  } else {
    hitIndices = [];
    for (let i = 0; i < Math.min(nTurns, turns.length); i++) hitIndices.push(i);
  }

  // Expand each hit by `around` turns on either side; dedupe via Set.
  const display = new Set<number>();
  for (const idx of hitIndices) {
    for (
      let j = Math.max(0, idx - around);
      j <= Math.min(turns.length - 1, idx + around);
      j++
    ) {
      display.add(j);
    }
  }
  const ordered = [...display].sort((a, b) => a - b);
  const hitSet = new Set(hitIndices);

  interface OutputTurn {
    idx: number;
    role: DialogueRole;
    text: string;
    is_hit: boolean;
  }
  const out: OutputTurn[] = [];
  let used = 0;
  for (const i of ordered) {
    const t = turns[i];
    if (!t) continue;
    let text = t.text;
    // Per-turn cap: if a single turn exceeds half the budget, truncate it so we
    // still fit the rest of the requested context.
    const cap = Math.floor(maxChars / 2);
    if (text.length > cap)
      text = text.slice(0, cap) + `\n…[+${t.text.length - cap} chars]`;
    if (used + text.length > maxChars && out.length > 0) break;
    out.push({ idx: i, role: t.role, text, is_hit: hitSet.has(i) });
    used += text.length;
  }

  if (argv.flags.json) {
    console.log(
      JSON.stringify(
        {
          session: s,
          query: grep,
          total_turns: turns.length,
          total_hit_turns: totalHitTurns,
          merged_children: mergedChildren,
          turns: out,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`# context: [${s.platform}] ${s.id}`);
  if (s.title) console.log(`# title: ${s.title}`);
  if (s.cwd) console.log(`# cwd:   ${shortPath(s.cwd)}`);
  if (grep)
    console.log(
      `# query: "${grep}"  hit_turns=${totalHitTurns}  showing top ${hitIndices.length}`,
    );
  else
    console.log(
      `# no grep — showing first ${hitIndices.length} turns of ${turns.length}`,
    );
  if (mergedChildren > 0) console.log(`# merged_children: ${mergedChildren}`);
  console.log(
    `# turns shown: ${out.length}  budget_used: ${used}/${maxChars} chars`,
  );
  console.log("");

  for (const t of out) {
    const marker = t.is_hit ? "  ← hit" : "";
    console.log(`## turn ${t.idx} (${t.role})${marker}\n`);
    console.log(t.text);
    console.log("\n---\n");
  }
}

type Phase = "brainstorm" | "implement" | "all";

function parsePhaseFlag(raw: unknown): Phase {
  if (raw === undefined || raw === false) return "all";
  if (raw === "brainstorm" || raw === "implement" || raw === "all") return raw;
  die(`unknown --phase: ${String(raw)} (expected brainstorm|implement|all)`);
}

interface PhaseSlice {
  /** Output rendered as separated windows (brainstorm) or contiguous turns
   * (implement / all). For brainstorm we emit per-window labeled groups. */
  groups: { label: string | null; turns: DialogueTurn[] }[];
  windows: BrainstormWindow[];
  /** Total turns in the underlying cleaned dialogue (for JSON metadata). */
  totalTurns: number;
  /** Stderr warnings (non-fatal: degraded output for non-Claude / no-boundary). */
  warnings: string[];
}

/** Slice cleaned dialogue by phase. Claude and Codex have native boundary
 * detection (via raw JSONL `task.py create|start` invocations in tool_use /
 * function_call events). OpenCode does not — its session storage doesn't
 * expose Bash tool calls in a comparable shape, so it degrades to "all turns
 * + warning". */
function slicePhase(s: SessionInfo, phase: Phase): PhaseSlice {
  const warnings: string[] = [];

  if (phase === "all" || s.platform === "opencode") {
    if (phase !== "all" && s.platform === "opencode") {
      warnings.push(
        `--phase ${phase} on platform=opencode is not yet supported; ` +
          `returning full dialogue.`,
      );
    }
    const turns = extractDialogue(s);
    return {
      groups: [{ label: null, turns }],
      windows: [],
      totalTurns: turns.length,
      warnings,
    };
  }

  // Claude / Codex path: collect turns + task.py events in one raw-JSONL pass,
  // then build brainstorm windows.
  const { turns, events } =
    s.platform === "claude"
      ? collectClaudeTurnsAndEvents(s)
      : collectCodexTurnsAndEvents(s);
  const windows = buildBrainstormWindows(events, turns.length);

  if (phase === "brainstorm") {
    if (windows.length === 0) {
      warnings.push(
        `no task.py create/start boundary found in session — returning full dialogue.`,
      );
      return {
        groups: [{ label: null, turns }],
        windows: [],
        totalTurns: turns.length,
        warnings,
      };
    }
    const groups = windows.map((w) => ({
      label: w.label,
      turns: turns.slice(w.startTurn, w.endTurn),
    }));
    return { groups, windows, totalTurns: turns.length, warnings };
  }

  // phase === "implement": all turns NOT inside any brainstorm window.
  if (windows.length === 0) {
    warnings.push(
      `no task.py create/start boundary found in session — implement phase is empty.`,
    );
    return {
      groups: [{ label: null, turns: [] }],
      windows: [],
      totalTurns: turns.length,
      warnings,
    };
  }
  // Build set of indices covered by any brainstorm window.
  const covered = new Set<number>();
  for (const w of windows) {
    for (let i = w.startTurn; i < w.endTurn; i++) covered.add(i);
  }
  const implementTurns: DialogueTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (!covered.has(i)) {
      const t = turns[i];
      if (t) implementTurns.push(t);
    }
  }
  return {
    groups: [{ label: null, turns: implementTurns }],
    windows,
    totalTurns: turns.length,
    warnings,
  };
}

function cmdExtract(argv: Argv): void {
  const id = argv.positional[0];
  if (!id) die("usage: extract <session-id>");
  const f = buildFilter(argv.flags);
  const s = findSessionById(id, f);
  if (!s) die(`session not found: ${id}`);

  const phase = parsePhaseFlag(argv.flags.phase);
  const slice = slicePhase(s, phase);
  for (const w of slice.warnings) console.error(`warning: ${w}`);

  const grepRaw = argv.flags.grep;
  const grep = typeof grepRaw === "string" ? grepRaw.toLowerCase() : undefined;

  // Apply --grep AFTER phase slicing.
  const filterTurns = (turns: DialogueTurn[]): DialogueTurn[] =>
    grep ? turns.filter((t) => t.text.toLowerCase().includes(grep)) : turns;

  if (argv.flags.json) {
    const groups = slice.groups.map((g) => ({
      label: g.label,
      turns: filterTurns(g.turns),
    }));
    // For backwards compat when phase=all (single unlabeled group), expose
    // a flat `turns` field too. New `groups` / `windows` fields are added
    // unconditionally so AI consumers can rely on them.
    const flat = groups.flatMap((g) => g.turns);
    console.log(
      JSON.stringify(
        {
          session: s,
          phase,
          windows: slice.windows,
          total_turns: slice.totalTurns,
          groups,
          turns: flat,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`# session: [${s.platform}] ${s.id}`);
  if (s.title) console.log(`# title: ${s.title}`);
  if (s.cwd) console.log(`# cwd:   ${shortPath(s.cwd)}`);
  if (s.created) console.log(`# date:  ${shortDate(s.created)}`);
  const totalShown = slice.groups.reduce(
    (n, g) => n + filterTurns(g.turns).length,
    0,
  );
  console.log(
    `# phase: ${phase}  turns: ${totalShown}/${slice.totalTurns}` +
      (grep ? ` (filtered by /${grep}/)` : "") +
      (slice.windows.length > 0 ? `  windows: ${slice.windows.length}` : ""),
  );
  console.log("");
  for (const g of slice.groups) {
    if (g.label !== null) console.log(`--- task: ${g.label} ---\n`);
    for (const t of filterTurns(g.turns)) {
      console.log(`## ${t.role === "user" ? "Human" : "Assistant"}\n`);
      console.log(t.text);
      console.log("\n---\n");
    }
  }
}

function cmdHelp(): void {
  console.log(`trellis mem — list/search Claude/Codex/OpenCode sessions

commands:
  list                          list sessions (default if no command)
  search <keyword>              find sessions whose contents match keyword
  context <session-id>          drill-down: top-N hit turns + surrounding context
                                (paired with search; use --grep KW to anchor)
  extract <session-id>          dump cleaned dialogue (use --grep KW to filter turns)
  projects                      list active projects (cwds) with session counts —
                                use this to discover which --cwd to pass to search

flags:
  --platform claude|codex|opencode|all   default all
  --since YYYY-MM-DD                     inclusive lower bound
  --until YYYY-MM-DD                     inclusive upper bound
  --global                               include all projects (default: cwd-scoped)
  --cwd <path>                           override the project cwd
  --limit N                              cap output (default 50)
  --grep KW                              extract / context: filter turns by keyword (multi-token AND)
  --phase brainstorm|implement|all       extract: slice by Trellis brainstorm windows
                                         (default all; brainstorm = [task.py create, task.py start);
                                         Claude-only — Codex/OpenCode warn + return all)
  --turns N                              context: number of hit turns to return (default 3)
  --around N                             context: turns of surrounding context per hit (default 1)
  --max-chars N                          context: total char budget (default 6000, ~1500 tokens)
  --include-children                     search / context: merge OpenCode sub-agent sessions into parent
  --json                                 emit JSON
  --help, -h                             show this help

examples:
  trellis mem list
  trellis mem list --global --platform claude --since 2026-04-01
  trellis mem search "session insight" --global
  trellis mem extract 5842592d --grep memory
  trellis mem extract 5842592d --phase brainstorm
`);
}

// ---------- entry ----------

export function runMem(args: readonly string[]): void {
  const argv = parseArgv(args);
  if (
    argv.flags.help ||
    argv.flags.h ||
    argv.cmd === "help" ||
    argv.cmd === "--help"
  ) {
    return cmdHelp();
  }
  switch (argv.cmd) {
    case "list":
      return cmdList(argv);
    case "search":
      return cmdSearch(argv);
    case "extract":
      return cmdExtract(argv);
    case "context":
      return cmdContext(argv);
    case "projects":
      return cmdProjects(argv);
    default:
      die(`unknown command: ${argv.cmd} (try 'help')`);
  }
}
