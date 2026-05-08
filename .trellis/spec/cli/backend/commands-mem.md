# `tl mem` — Cross-Platform AI Session Memory

How `packages/cli/src/commands/mem.ts` indexes, searches, and extracts dialogue
from on-disk session files written by Claude Code, Codex, and OpenCode.

---

## Overview

`tl mem` is an offline reader over **local AI session stores**. It does not
attach to running CLIs or talk to any remote service — it parses the files those
CLIs already drop on disk:

| Platform | Session root |
|----------|--------------|
| Claude Code | `~/.claude/projects/<sanitized-cwd>/<id>.jsonl` |
| Codex | `~/.codex/sessions/**/rollout-<ts>-<id>.jsonl` |
| OpenCode | `~/.local/share/opencode/storage/{session,message,part}/**` |

For every session, `mem` can: list metadata (id / cwd / time), grep cleaned
dialogue across all of them, drill into a single session for a token-budgeted
context window around hits, or dump full cleaned dialogue. The cleaned form
strips Trellis / platform injection tags so search hits aren't dominated by
session-start preamble.

The module is one self-contained TypeScript file plus four sibling test files;
it does **not** depend on the rest of the Trellis runtime (no
`configurators/`, no Python scripts). It re-exports a single
`runMem(args)` entry point invoked from the `tl` Commander wire.

> **Audience for this spec**: contributors extending `mem.ts` — adding new
> platforms, new subcommands, or new flags. The goal is to keep the cleaning
> pipeline, filtering semantics, and ranking heuristics consistent across
> platforms when changes are made.

---

## Subcommand surface

Entry point: `commands/mem.ts:runMem` dispatches on `argv.cmd` after
`commands/mem.ts:parseArgv`. All subcommands share `commands/mem.ts:buildFilter`
for the cross-cutting `--platform / --since / --until / --cwd / --global /
--limit` flags.

| Subcommand | Function | Purpose |
|------------|----------|---------|
| `list` | `commands/mem.ts:cmdList` | List session metadata sorted by recency, capped at `--limit` (default 50). Default subcommand when none given. |
| `search <kw>` | `commands/mem.ts:cmdSearch` | Multi-token AND grep over cleaned dialogue across all matching sessions; ranks by weighted relevance score; emits per-session excerpts. |
| `context <id>` | `commands/mem.ts:cmdContext` | Drill-down on a single session: top-N hit turns + N turns of context on either side, char-budgeted. With no `--grep`, returns the first N turns (session opening). |
| `extract <id>` | `commands/mem.ts:cmdExtract` | Dump full cleaned dialogue for one session; `--grep` filters turns by AND-substring. |
| `projects` | `commands/mem.ts:cmdProjects` | Aggregate distinct cwds across platforms with last-active timestamp + per-platform counts. AI uses this as a directory of "门牌号" (project paths) before picking a `--cwd` for `search`. |
| `help` / `--help` / `-h` | `commands/mem.ts:cmdHelp` | Print full flag reference. |

### Flags

Cross-cutting (`buildFilter`):

| Flag | Default | Notes |
|------|---------|-------|
| `--platform claude\|codex\|opencode\|all` | `all` | Validated via `PlatformSchema` Zod union. Unknown value → exit 2. |
| `--since YYYY-MM-DD` | none | Inclusive lower bound. Parsed by `new Date(value)`; invalid → exit 2. |
| `--until YYYY-MM-DD` | none | Inclusive upper bound; parser appends `T23:59:59.999Z` so a date string covers the whole UTC day. |
| `--cwd <path>` | `process.cwd()` | Project scope. Resolved with `path.resolve`. Combined with `--global` → `--global` wins. |
| `--global` | off | Drops cwd scoping (`f.cwd = undefined`). |
| `--limit N` | `50` | Cap on output rows. Internally bumped to `1_000_000` for `search` candidate gathering and `findSessionById` so the limit only controls *display*, not search recall. |

Subcommand-specific:

| Flag | Subcommands | Default | Notes |
|------|-------------|---------|-------|
| `--grep KW` | `extract`, `context` | none | Multi-token AND. `extract` filters turns by substring; `context` ranks turns and shows top hits. Required-non-empty for `context --grep`. |
| `--turns N` | `context` | `3` | Number of hit turns to surface. |
| `--around M` | `context` | `1` | Turns of context on either side of each hit; deduped via `Set`. |
| `--max-chars N` | `context` | `6000` (~1500 tokens) | Total char budget. Per-turn cap is `floor(N/2)`; turns exceeding it are head-truncated with `…[+X chars]`. |
| `--include-children` | `search`, `context` | off | Merge OpenCode sub-agent descendants into parent before search/context (only OpenCode populates `parent_id`). |
| `--json` | all | off | Machine-readable output for AI consumption. |

---

## Platform indexing

Each platform has three exported functions:

| Platform | `*ListSessions(f)` | `*ExtractDialogue(s)` | `*Search(s, kw)` |
|----------|--------------------|-----------------------|------------------|
| Claude | `commands/mem.ts:claudeListSessions` | `commands/mem.ts:claudeExtractDialogue` | `commands/mem.ts:claudeSearch` |
| Codex | `commands/mem.ts:codexListSessions` | `commands/mem.ts:codexExtractDialogue` | `commands/mem.ts:codexSearch` |
| OpenCode | `commands/mem.ts:opencodeListSessions` | `commands/mem.ts:opencodeExtractDialogue` | `opencodeSearch` (file-private) |

`commands/mem.ts:listAll` fans out to the three list functions and merges
results sorted by `updated ?? created` descending. `commands/mem.ts:extractDialogue`
and `commands/mem.ts:searchSession` dispatch on `s.platform`.

### Claude Code

- **Layout**: `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`. The cwd is
  sanitized as `cwd.replace(/[/_]/g, "-")` — see
  `commands/mem.ts:claudeProjectDirFromCwd`. When `--cwd` is set, `mem` resolves
  the single project directory directly; otherwise it walks every project dir.
- **Index**: when present, `<projectDir>/sessions-index.json`
  (`ClaudeIndexSchema`) provides `cwd / created / title` per session id, saving
  a JSONL scan. Missing fields fall back to scanning the first 100 events
  (`commands/mem.ts:findInJsonl`) for a `cwd`, then the very first event
  (`commands/mem.ts:readJsonlFirst`) for a creation timestamp.
- **Updated**: `fs.statSync(filePath).mtime`.
- **Cleaning** (`commands/mem.ts:claudeExtractDialogue`):
  - User turns: `type === "user"` AND `message.role === "user"` AND
    `content` is a string (Array content = tool_result, dropped).
  - Assistant turns: `type === "assistant"` AND `message.role === "assistant"`
    AND `content` is array of blocks; only `block.type === "text"` blocks kept.
    `thinking` and `tool_use` blocks dropped wholesale.
  - **Compaction**: when a `user` event has `isCompactSummary === true`, all
    pre-compact turns are discarded and replaced with a single synthetic
    `[compact summary]\n<text>` user turn.

### Codex

- **Layout**: `~/.codex/sessions/**/rollout-<YYYY-MM-DDTHH-MM-SS>-<id>.jsonl`.
  `commands/mem.ts:walkDir` recurses lazily via a stack-based generator.
- **Filename timestamp**: parsed by regex
  `/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)$/` and converted to ISO
  by replacing `T??-??-??` with `T??:??:??Z`. Used as fallback `created` if the
  first event lacks `timestamp`.
- **Metadata**: read from the first JSONL event's `payload` (id, cwd).
- **Cleaning** (`commands/mem.ts:codexExtractDialogue`):
  - Real turns: top-level event with `payload.type === "message"` and
    `payload.role` parseable to `user` / `assistant` (drops `developer` /
    `system`).
  - Each `payload.content[]` part is kept iff `type` is `input_text` or
    `output_text`. Other types ignored.
  - **Compaction**: a top-level `type: "compacted"` event carries
    `payload.replacement_history[]` — each item with `type === "message"`
    becomes a synthetic `[compact]\n<text>` turn, and prior turns are
    discarded.

### OpenCode

- **Layout** (three-store):
  - Session metadata: `~/.local/share/opencode/storage/session/**/<sid>.json`
  - Message index: `message/<sid>/msg_*.json`
  - Part bodies: `part/<msgId>/prt_*.json`
- **Metadata**: `OpenCodeSessionSchema` exposes `id / title / directory /
  parentID / time.{created,updated}`. Numeric ms timestamps are converted to
  ISO via `new Date(ms).toISOString()`.
- **Sub-agent chain**: `parentID` is the only native parent linkage across the
  three platforms. `commands/mem.ts:buildChildIndex` flattens it transitively
  for `--include-children`.
- **Cleaning** (`commands/mem.ts:opencodeExtractDialogue`):
  - Iterate messages sorted by `time.created` ascending.
  - For each message, read every `prt_*.json` body; keep parts where
    `type === "text"` AND `synthetic !== true`. Synthetic parts are
    platform-injected mode prompts / agent boilerplate.
  - Concatenate kept parts with `\n\n`.

### `SessionInfo` contract

Every list function emits items conforming to `commands/mem.ts:SessionInfoSchema`:

| Field | Required | Source |
|-------|----------|--------|
| `platform` | yes | `claude` / `codex` / `opencode` |
| `id` | yes | platform session id |
| `title` | optional | Claude index `title`, OpenCode `title`; Codex has no title |
| `cwd` | optional | OpenCode `directory`, Claude index/event `cwd`, Codex first-event `payload.cwd` |
| `created` | optional ISO | first-event timestamp; Codex falls back to filename timestamp |
| `updated` | optional ISO | `fs.statSync(file).mtime` for Claude/Codex; OpenCode `time.updated` |
| `filePath` | yes | absolute path to the session's primary file |
| `messageDir` | OpenCode only | `OC_MESSAGE_DIR/<sid>` for downstream extraction |
| `parent_id` | OpenCode only | sub-agent linkage |

---

## Filtering & overlap semantics

The single most important invariant in `mem.ts`:

> **Sessions are filtered by interval overlap, not by single-point `created` comparison.**

### `inRange` vs `inRangeOverlap`

| Helper | Semantics | Use site |
|--------|-----------|----------|
| `commands/mem.ts:inRange` | Single-point: `f.since ≤ t ≤ f.until`. Pass-through if `iso` undefined or unparseable. | Internal-only; **not used for session list filtering** |
| `commands/mem.ts:inRangeOverlap` | Interval: keep iff session lifetime `[start, end]` overlaps query window `[f.since, f.until]`. | Used by **all three** `*ListSessions` functions |

### Why overlap is mandatory

Long-lived sessions cross day boundaries. A Claude session created on 2026-04-01
but still receiving messages on 2026-04-05 must show up under
`--since 2026-04-03`. With single-point `inRange(created, f)` it would be
silently dropped despite being demonstrably active inside the window. Audit
trail: `task.05-08-mem-since-cross-day-filter`.

The historical Codex bug deserves a callout. The list function used to
short-circuit on `!inRange(tsFromName, f)` *before* even reading the file —
plausible-looking optimization, but `tsFromName` is the session's **creation
time**, so a cross-day session was dropped solely because it started before
`--since`. This was removed; Codex now stats every file and applies overlap on
`[created, updated]`. The performance cost is one `fs.statSync` per Codex
rollout per list call, which is negligible compared to the JSONL parse already
happening.

**Rule**: when adding a new platform, both `start` and `end` go through
`inRangeOverlap`. Never short-circuit on a single timestamp. If a platform only
exposes one timestamp, pass it as both `start` and `end` — `inRangeOverlap` is
defined to handle that degenerate case.

### `sameProject` semantics

`commands/mem.ts:sameProject` returns true iff target is undefined (no scope),
or if `path.resolve(sessionCwd) === path.resolve(target)`, or if the session
cwd is a descendant directory (`startsWith(target + sep)`). Sessions whose cwd
is unknown are dropped under cwd scoping but kept under `--global`.

---

## Cleaning pipeline

Before any search or display, raw turn text passes through:

1. **`commands/mem.ts:stripInjectionTags`** — case-insensitive removal of
   `<tag>...</tag>` blocks for every entry in `INJECTION_TAGS`. Also strips
   AGENTS.md preamble (`^# AGENTS\.md instructions for...` until the next
   blank-line + capital/CJK boundary). Collapses runs of `\n` to `\n\n` and
   trims.
2. **`commands/mem.ts:isBootstrapTurn`** — applied AFTER tag stripping. Drops
   the entire turn (returns `null` from the per-platform builder) when:
   - `cleaned.startsWith("# AGENTS.md instructions for")`, OR
   - `originalLength > 4000` AND `cleaned` begins with `<INSTRUCTIONS>` (case
     insensitive). The size threshold avoids false-dropping a tiny user reply
     that happens to start with `<INSTRUCTIONS>`.
3. **Compaction handling** — Claude `isCompactSummary` and Codex `compacted`
   events both reset accumulated turns and replace them with synthetic
   `[compact …]` markers (see platform sections above).

### Why the pipeline matters for search

Once turns are cleaned, search reduces to **multi-token AND substring matching
on lowercased text** — `searchInDialogue` does not need a tokenizer or stemmer.
The cleaning pipeline is what makes plain `String.prototype.includes` viable:
Trellis / platform injection tags would otherwise dominate every match.

If you need to add a new injection tag (e.g. a new Trellis hook adds
`<my-new-tag>`), append it to the `INJECTION_TAGS` array and add a fixture-based
test. Do not write platform-specific stripping logic; the tag list is shared.

`INJECTION_TAGS` currently covers:

```
system-reminder, task-status, ready, current-state, workflow,
workflow-state, guidelines, instructions, command-name, command-message,
command-args, local-command-stdout, local-command-stderr,
permissions instructions, collaboration_mode, environment_context,
auto_compact_summary, user_instructions
```

`permissions instructions` (with a space) is intentional — Codex emits it
exactly that way.

---

## Search relevance scoring

`commands/mem.ts:searchInDialogue` returns a `SearchHit` with per-role hit
counts and excerpts. `commands/mem.ts:relevanceScore` is the ranker:

```
score(hit) = (3 * user_count + asst_count) / total_turns
```

### Weight rationale

- **User hits weighted ×3**: the user's own words anchor topic intent. An
  assistant repeating "session insight" twenty times in elaboration scores
  lower than the user mentioning it twice — assistant elaboration is downstream
  of what the user actually cared about.
- **Normalized by `total_turns`**: a tight 18-hit short session must outrank a
  sprawling 58-hit long session. Without normalization, every long session
  would dominate.

### Tie-breaking (`cmdSearch`)

```
1. score (descending)
2. raw count (descending)
3. updated ?? created (descending) — recency
```

### Excerpt selection

Within a turn, hit positions are scored by:

1. **Coverage** — distinct query tokens visible in the chunk (descending).
2. **Anchor rarity** — `1 / tokenFreq[anchorToken]` (descending). A chunk
   anchored on the rarest matching token best signals where the user actually
   talked about the topic; chunks anchored on common tokens (project name,
   "the") are mostly noise.
3. **Earliest start** — final stable tie-break.

Chunks come from `commands/mem.ts:chunkAround` — paragraph-aligned by `\n\n`
on either side of the hit, falling back to a centered char window if the
natural paragraph exceeds `maxChars` (default `400`). Truncation is reported
via the `truncated` flag and surfaces as leading / trailing `…` in the snippet.

User-role excerpts are emitted **before** assistant excerpts in the final list
(see the `[...userExcerpts, ...asstExcerpts]` concatenation in
`searchInDialogue`). With `maxExcerpts = 3` (default), a turn with three user
hits and ten assistant hits will surface only user excerpts.

### Chunk dedup

`seenStarts` set prevents adjacent hit positions inside the same paragraph
from generating multiple overlapping excerpts. Two hits in one paragraph
collapse to one chunk.

---

## Sub-agent merging (`--include-children`)

OpenCode is the only platform with a native parent-child link
(`parentID` on `OpenCodeSessionSchema`). When `--include-children` is set:

1. `commands/mem.ts:buildChildIndex` walks the candidate list and builds a
   `Map<parent_id, descendants[]>` with **transitive flattening** — a parent
   maps to all descendants, not just direct children.
2. **Search**: `commands/mem.ts:searchSessionWithChildren` concatenates the
   parent's cleaned dialogue with every descendant's cleaned dialogue and runs
   `searchInDialogue` once over the merged turn list. Scores reflect topic
   density across the entire sub-agent tree.
3. **Filter absorbed children**: any candidate whose `parent_id` is also in the
   candidate set is dropped from the result list — the parent already absorbs
   its hit.
4. **Context** (`cmdContext`): same merge; children turns are appended after
   parent turns in `extractDialogue` order; the count of merged children is
   surfaced in output.

Claude and Codex pass through unchanged — `parent_id` is undefined, so they
never absorb children.

---

## Boundaries — what `mem.ts` does NOT do

- **No live process attach**: only reads files already on disk. Sessions
  in-flight may be partially indexed (the JSONL is append-only, so reads are
  consistent at line granularity).
- **No global cross-cwd implicit search**: by default everything is cwd-scoped
  to `process.cwd()`. Cross-project queries require explicit `--global` or the
  `projects` subcommand to discover other cwds first.
- **No write path**: `mem` never modifies session files, indexes, or any other
  state. It is a strict reader.
- **No remote/cloud sync**: OpenCode's optional cloud sync is invisible here;
  only the local store under `~/.local/share/opencode/storage` is parsed.
- **No transitive dependency on Trellis runtime**: `mem.ts` does not import
  from `configurators/`, `migrations/`, `templates/`, or `.trellis/scripts`.
  It uses `node:fs / node:path / node:os / zod` only.
- **No OpenCode-style sub-agent linkage outside OpenCode**: even if a future
  Codex / Claude release exposes parent-child IDs, the current
  `buildChildIndex` only consults `s.parent_id`, which only OpenCode emits.
  Adding cross-platform sub-agent merging means extending `SessionInfo`.

---

## Search index gaps (known limitations)

`mem search` / `mem extract --grep` / `mem context --grep` operate on the
**cleaned dialogue text only** — user messages plus assistant `text` blocks,
post-`stripInjectionTags`. The following raw-JSONL fields are deliberately
excluded from the search index:

| Excluded field | Where it lives | Example value the index misses |
|---|---|---|
| `tool_use.name` | Claude assistant blocks (`type:"tool_use"`) | `"Skill"`, `"Bash"`, `"Read"` |
| `tool_use.input.*` | same | `{"skill":"res-literature-search","args":"…"}` |
| `tool_use.id` | same | `toolu_01XYZ…` |
| `tool_result.content` | Claude user blocks (`type:"tool_result"`) | command stdout, file contents |
| `thinking` blocks | Claude assistant blocks (`type:"thinking"`) | extended-thinking text |
| Codex `payload.tool_call.*` | Codex events with `type:"tool_call"` | similar tool metadata |
| Codex `payload.function_call_output.*` | tool result events | function output |
| `cwd`, `gitBranch`, `version`, `entrypoint` | top-level event metadata | `feat/v0.6.0-beta`, `2.1.132` |

**User-visible consequence**: queries phrased in terms of *what tool / skill /
agent was invoked* return false-negatives even when the conversation used that
tool heavily. For example, `tl mem search "Skill"` against a session that
called `Skill` 40 times will return 0 hits — the tool name lives in
`tool_use.name`, which is dropped at extraction time.

This is **by design**: the dialogue cleaner exists to make `String.includes`
relevance ranking work on conversational text. Indexing tool metadata would
flood every assistant turn with `Skill`/`Read`/`Bash`/`Edit`/etc. and destroy
signal-to-noise. The right tool for tool-usage queries is **raw `grep` over
the JSONL files**:

```bash
# What skills did this session invoke?
grep -oE '"name":"Skill","input":\{[^}]+\}' \
  ~/.claude/projects/-Users-…-Trellis/<session-id>.jsonl

# Cross-session skill usage in a project
grep -hoE '"skill":"[a-z0-9-]+"' \
  ~/.claude/projects/-Users-…-Trellis/*.jsonl | sort | uniq -c
```

**Decision rule** for choosing between `tl mem` and raw `grep`:

| Searching for | Tool |
|---|---|
| User/assistant said something / discussed a topic / made a decision | `tl mem search` |
| What tool / skill / agent / sub-agent was used | `grep` over JSONL |
| Tool call frequency / parameters | `grep` + `jq` over JSONL |
| Cross-session topic recall (concepts in dialogue) | `tl mem search` |

A future enhancement could add an opt-in `--include-tools` flag to
`extractDialogue` that emits synthetic `[tool: <name>]` turns or surfaces
tool metadata as a separate result stream, but the current scope does not.
Document the limitation, point users at `grep`, do not silently lower
relevance quality on the conversational path.

---

## Phase slicing (`--phase`)

`tl mem extract <id> --phase <brainstorm|implement|all>` slices the cleaned
dialogue by Trellis brainstorm windows, allowing the high-density discussion
turns (user thinking, AI proposals being rejected, decision rationale) to be
extracted independently from implementation work.

### Three values

| `--phase` | Behavior |
|-----------|----------|
| `all` (default) | Pre-existing behavior — full cleaned dialogue, unchanged. |
| `brainstorm` | Returns only turns inside `[task.py create, task.py start)` windows. |
| `implement` | Returns turns OUTSIDE every brainstorm window (i.e., turns the user spent doing the actual work, plus session warm-up before the first `create`). |

### Boundary signal

A brainstorm window is bounded by `task.py` invocations recovered from raw
Claude JSONL `tool_use` blocks (which `claudeExtractDialogue` discards):

- **Window start**: assistant `tool_use` block with `name === "Bash"` whose
  `input.command` matches `task.py create`.
- **Window end**: the next `task.py start` Bash invocation in the same
  session.

The detection is performed by
`commands/mem.ts:collectClaudeTurnsAndEvents` — a single pass that produces
both the cleaned `DialogueTurn[]` (semantically identical to
`claudeExtractDialogue`) AND a list of `task.py` events with their
`turnIndex` (the cleaned-turn index AT THE TIME the tool_use was seen).

### Regex compatibility

`commands/mem.ts:parseTaskPyCommand` parses individual Bash commands. It must
cover every shape Trellis users actually write:

```
\b(?:python3?|py(?:\s+-3)?)?\s*\S*[/\\]?task\.py\s+(create|start)\b
```

Concretely supported invokers + path forms:

- `python ./.trellis/scripts/task.py create "title"`
- `python3 ./.trellis/scripts/task.py create my-task`
- `py -3 .trellis/scripts/task.py create ...` (Windows launcher)
- `python3 .trellis\\scripts\\task.py start ...` (JSONL-double-escaped backslash)
- `python3 .trellis\scripts\task.py start ...` (single backslash)
- `task.py start <task-dir>` (PATH + chmod +x, no invoker prefix)
- `python3 /Users/.../task.py create ...` (absolute path)

The parser also captures `--slug FOO` / `--slug=FOO` for create events and the
positional task-dir for start events. False-positive guard: `task.py` must
appear at the start of the command, after whitespace, or after a path
separator — never embedded inside a flag value like `--slug=task.py-create-x`.

### Pairing strategy (multi-task sessions)

A single Claude session often contains N `[create, start)` pairs as the user
moves through several tasks. Pairing in
`commands/mem.ts:buildBrainstormWindows`:

1. **Slug match wins**: any create with an explicit `--slug` is paired with
   the first unmatched start whose `taskDir`'s last segment equals that slug,
   regardless of position.
2. **FIFO fallback**: remaining creates pair with the next unmatched start
   appearing AFTER them in event order.
3. **Output order**: windows are sorted by `startTurn` ascending (so output
   reflects chronological session flow).

Each window emits a label: the explicit slug if known, else
`slugFromTaskDir(start.taskDir)`, else `window-N`.

### Multi-window output format

`--phase brainstorm` with multiple windows emits a separator before each
group:

```
--- task: <slug-or-label> ---

## Human

...
```

In `--json` mode, the output adds:

```json
{
  "phase": "brainstorm",
  "windows": [{ "label": "demo", "startTurn": 1, "endTurn": 3 }, ...],
  "total_turns": 5,
  "groups": [{ "label": "demo", "turns": [...] }, ...],
  "turns": [...]   // flat concatenation of all groups, for legacy parsers
}
```

`groups` is the structured form (one entry per window). `turns` is a flat
concatenation kept for backwards compatibility with consumers that parsed the
pre-`--phase` output.

### Fallback matrix

| Condition | `--phase brainstorm` | `--phase implement` |
|-----------|---------------------|---------------------|
| Both `create` and `start` found, paired | Slice `[start, end)` of each window | Turns NOT in any window |
| `create` found, no following `start` | `[create, totalTurns)` (window kept open to session end) | Turns before any `create` |
| `start` found, no preceding `create` (task created in earlier session) | `[0, start)` | Turns at or after `start` |
| Neither found | Full dialogue + stderr warning | Empty + stderr warning |
| `start.turnIndex < create.turnIndex` (event interleave anomaly) | Window discarded | (no impact) |

Warnings are emitted to stderr (`console.error`) so they don't pollute the
machine-readable stdout used by `--json` consumers.

### Platform coverage

| Platform | `--phase brainstorm` / `implement` |
|----------|------------------------------------|
| Claude | Native — boundary detection runs on raw JSONL |
| Codex | Degraded: emits stderr warning, returns full dialogue (no slicing) |
| OpenCode | Degraded: emits stderr warning, returns full dialogue (no slicing) |

This is by design (PRD MVP scope) — Codex/OpenCode equivalents to Claude's
`tool_use` block are different shapes and are deferred to a follow-up.

### Combining with `--grep`

`--phase` runs FIRST, then `--grep` filters turns within the resulting slice.
Order matters: `--grep KW --phase brainstorm` searches only inside the
brainstorm windows, not the entire session.

### Common pitfall: tool_use is dropped during cleaning

`claudeExtractDialogue` (and the per-platform analogs) discard `tool_use`
blocks because their text is not user/assistant dialogue. Boundary signals
live in those blocks, so phase slicing CANNOT post-filter cleaned turns —
the signals would already be gone. The implementation does its own raw
JSONL pass that builds turns and tracks tool_use events together. When
adding new boundary signals (e.g., for Codex / OpenCode), follow this
pattern: read raw events, do not consume the cleaned `DialogueTurn[]`.

### Compaction resets task.py event list, not just turns

`collectClaudeTurnsAndEvents` resets BOTH `turns` AND `events` when an
`isCompactSummary` event is encountered. Pre-compact `task.py` events
anchor to `turnIndex` values that index into the now-collapsed dialogue
(replaced by a single `[compact summary]` synthetic turn). Carrying them
forward and pairing with post-compact `start` events would emit a window
referencing dialogue that no longer exists. Symptom (if forgotten): a
window with `startTurn` deep inside the post-compact region but labeled
with a stale slug from the pre-compact task. Fix: any new boundary
detector that mutates a `turns` accumulator on compaction must also
reset its event accumulator.

---

## Common pitfalls

When extending or refactoring `mem.ts`:

### Single-point `inRange` for session list filtering
**Wrong**: `if (!inRange(created, f)) continue;` — drops cross-day sessions.
**Correct**: `if (!inRangeOverlap(created, updated, f)) continue;` — see
`commands/mem.ts:codexListSessions` for the canonical pattern.

### Short-circuiting on filename timestamp
**Wrong**: skip Codex sessions where `tsFromName < f.since` without reading the
file. **Correct**: stat the file for `updated` and apply `inRangeOverlap`.
Filename ts is creation time; `--since` filtering must consider the active
window.

### Bypassing `stripInjectionTags`
Adding raw turn text to `searchInDialogue` skips injection-tag removal and
inflates hit counts on every Trellis-using session. Always run text through
`stripInjectionTags` *before* the bootstrap check, and pass the
post-strip text into `isBootstrapTurn` along with `originalLength` so the size
threshold is computed against the raw input.

### Mishandling compaction
Both Claude and Codex compaction events **reset** the `turns` array, not
append. Forgetting to reset means double-counting the pre-compact history. The
synthetic marker (`[compact summary]` / `[compact]`) is intentional — it makes
the compaction visible to readers and surfaces correctly in `extract` output.

### Forgetting to advance `from` past the matched token
In `searchInDialogue`, `from = idx + tok.length` is required to avoid an
infinite loop when a token has length zero. The `tokens.filter(Boolean)` guard
in `kw.toLowerCase().split(/\s+/).filter(Boolean)` ensures empty tokens are
dropped before this loop.

### `readJsonlFirst` on huge files
`commands/mem.ts:readJsonl` reads the entire file with `fs.readFileSync` then
splits on `\n`. For session files in the tens of MB, even
`readJsonlFirst` (which only needs the first valid line) loads everything
into memory before the `"stop"` short-circuit fires. This is a known TODO —
streaming via `readline.createInterface` would be a drop-in win, but no
production session has hit a problematic size yet so the simpler synchronous
path stayed.

### Mock `node:os` BEFORE importing `mem.ts`
Module-load constants `HOME`, `CLAUDE_PROJECTS`, `CODEX_SESSIONS`, `OC_*`
capture `os.homedir()` once. Tests must mock `node:os` via `vi.hoisted` and
`vi.mock("node:os", ...)` *before* `await import("../../src/commands/mem.js")`.
See `test/commands/mem-platforms.test.ts` for the canonical pattern.

### Adding a new platform without updating all dispatchers
A new platform requires updates in:

| Site | What |
|------|------|
| `PlatformSchema` | enum entry |
| `commands/mem.ts:listAll` | call to new `*ListSessions` |
| `commands/mem.ts:extractDialogue` | switch case |
| `commands/mem.ts:searchSession` | switch case |
| `commands/mem.ts:cmdProjects` `Agg.by_platform` | new key with default `0` |
| `cmdHelp` | mention in `--platform` line |

There is no exhaustiveness check — TypeScript's `switch` over `s.platform`
will warn for unhandled cases only if every dispatcher uses an explicit
discriminated union, which they do; trust the compiler here.

---

## Schemas (Zod)

All declared in `commands/mem.ts`. They guard against silent shape drift in
upstream platform formats — when Claude / Codex / OpenCode change their on-disk
format, `safeParse` returns `false` for the affected lines and they are skipped
rather than crashing the run.

| Schema | Domain |
|--------|--------|
| `commands/mem.ts:PlatformSchema` | `"claude" \| "codex" \| "opencode"` |
| `commands/mem.ts:SessionInfoSchema` | unified session metadata across platforms |
| `commands/mem.ts:DialogueRoleSchema` | `"user" \| "assistant"` |
| `commands/mem.ts:SearchExcerptSchema` / `SearchHitSchema` | search output shape |
| `commands/mem.ts:FilterSchema` | parsed cross-cutting flags |
| `commands/mem.ts:ArgvSchema` | parsed CLI arguments |
| `commands/mem.ts:ClaudeBlockSchema` / `ClaudeMessageSchema` / `ClaudeEventSchema` | Claude JSONL events |
| `commands/mem.ts:ClaudeIndexEntrySchema` / `ClaudeIndexSchema` | Claude `sessions-index.json` |
| `commands/mem.ts:CodexContentPartSchema` / `CodexCompactedItemSchema` / `CodexPayloadSchema` / `CodexEventSchema` | Codex rollout JSONL |
| `commands/mem.ts:OpenCodeSessionSchema` / `OpenCodeMessageSchema` / `OpenCodePartSchema` | OpenCode three-store |

### Schema evolution rules

- **Stay loose**: every external schema uses `.loose()` (Zod v4) so unknown
  fields survive parse without errors. Never tighten with `.strict()` — upstream
  format additions would silently break parsing.
- **Optional everything**: every field on external schemas is `.optional()`.
  Required fields are reserved for the unified `SessionInfoSchema` (`id`,
  `platform`, `filePath`).
- **Keep schema-mismatch silent**: `readJsonl` skips lines that fail
  `safeParse`. Don't log per-line warnings — production session files contain
  legitimately diverse event shapes (tool_result, errors, telemetry) that we
  don't care about.

When extending `SessionInfoSchema` (e.g. adding a `conversation_id` field for a
new platform), every `*ListSessions` function must populate the field (or
explicitly leave it undefined for platforms that don't have it). Forgetting to
populate it on platform A while platform B does will cause schema-validated
output to be inconsistent across platforms.

---

## Output formatting

| Helper | Purpose |
|--------|---------|
| `commands/mem.ts:shortDate` | `iso.slice(0, 16).replace("T", " ")` — minute-precision local-looking timestamp |
| `commands/mem.ts:shortPath` | replaces `$HOME` with `~`; `(no cwd)` when undefined |
| `commands/mem.ts:printSessions` | tabular human-readable dump shared by `cmdList` |

Every subcommand supports `--json`. JSON output is structurally stable and is
the contract for AI agents consuming `mem` output. If you change a field name
in JSON output (e.g. rename `hit_count` → `total_hits`), assume an AI somewhere
is parsing it and version the change.

---

## Test conventions

Existing test files (under `packages/cli/test/commands/`):

| File | Tier | What it covers |
|------|------|----------------|
| `mem-helpers.test.ts` | Tier-1 (pure-function) | `parseArgv`, `buildFilter`, `inRange`, `inRangeOverlap`, `sameProject`, `stripInjectionTags`, `isBootstrapTurn`, `chunkAround`, `searchInDialogue`, `relevanceScore`, `shortDate`, `shortPath` |
| `mem-platforms.test.ts` | Tier-2 (fixture-based) | Per-platform `*ListSessions` and `*ExtractDialogue` against synthetic JSONL / JSON fixtures with mocked `os.homedir()` |
| `mem-since-cross-day.test.ts` | Regression | Cross-day session must survive `--since` later than `created`; pins the `inRangeOverlap` contract |
| `mem-integration.test.ts` | Tier-3 | End-to-end `runMem` with stdout capture |

### Fixture pattern (Tier-2)

The `mem-platforms.test.ts` pattern is mandatory for any new platform parser
test:

1. **`vi.hoisted` block** mints a tmpdir for `fakeHome`. This runs *before*
   module resolution so `mem.ts`'s top-level `const HOME = os.homedir()`
   captures the fake value.
2. **`vi.mock("node:os", ...)`** preserves the rest of the `os` API
   (`tmpdir`, `EOL`, etc.) — Vitest itself uses them. Spread `actual` and only
   override `homedir`.
3. **`await import("../../src/commands/mem.js")`** *after* the mock is set up.
4. **Per-test fixture seeding**: write minimal JSONL / JSON files into
   `<fakeHome>/.claude/projects/...`, `<fakeHome>/.codex/sessions/...`, or
   `<fakeHome>/.local/share/opencode/storage/...`.
5. **`utimesSync`** is the canonical way to anchor `mtime` for `updated`
   assertions — `fs.statSync(file).mtime` is what `mem.ts` reads.
6. **`afterEach`** cleans up its own fixture files; tests must be isolated
   from each other within the suite.

### What new tests must cover

When adding a feature to `mem.ts`:

- A new flag → `mem-helpers.test.ts` for `buildFilter` parsing + a
  `mem-integration.test.ts` for end-to-end behavior.
- A new injection tag → `mem-helpers.test.ts` `stripInjectionTags` test asserting
  the tag is removed AND a paragraph adjacent to the tag survives intact.
- A new platform → new `*ListSessions` / `*ExtractDialogue` block in
  `mem-platforms.test.ts` mirroring the existing per-platform test groups.
- A bug fix touching filtering → `mem-since-cross-day.test.ts` style
  regression: a fixture with a known boundary case + the assertion that pins
  the fix.

### What tests must NOT do

- Don't assert on whole stdout block in human-readable mode — the format
  changes (line spacing, padding). Assert on `--json` output instead.
- Don't write fixtures outside `fakeHome`. `mem.ts`'s constants only know
  about `HOME`-derived paths; tests using `os.tmpdir()` directly will not be
  exercised by the parsers.
- Don't `mem.ts`-import without the `node:os` mock in place — the constants
  would lock onto the real `~/.claude` etc. and your test would either pass by
  accident or pollute the developer's actual session store.

---

## Public API surface (exported)

For consumers (currently only `tl` Commander wire and tests):

| Export | Use |
|--------|-----|
| `runMem(args)` | Entry point — `tl mem ...` calls into this |
| `parseArgv(argv)`, `buildFilter(flags)` | Argument parsing — used by tests |
| `inRange`, `inRangeOverlap`, `sameProject` | Filtering primitives — tested directly |
| `stripInjectionTags`, `isBootstrapTurn` | Cleaning primitives — tested directly |
| `chunkAround`, `searchInDialogue`, `relevanceScore` | Search primitives — tested directly |
| `shortDate`, `shortPath` | Formatting — tested directly |
| `claudeListSessions`, `claudeExtractDialogue`, `claudeSearch` | Claude adapter — tested via `mem-platforms.test.ts` |
| `codexListSessions`, `codexExtractDialogue`, `codexSearch` | Codex adapter — same |
| `opencodeListSessions`, `opencodeExtractDialogue` | OpenCode adapter — same |
| `parseTaskPyCommand`, `buildBrainstormWindows`, `collectClaudeTurnsAndEvents` | Phase slicing — tested via `mem-phase-slice.test.ts` |

`opencodeSearch` is intentionally file-private; the dispatcher
`commands/mem.ts:searchSession` is what tests should use to exercise OpenCode
search end-to-end. If you need to test it directly, prefer testing the
exposed `extract` + `searchInDialogue` composition rather than reaching into
the unexported function.

---

## Reference

- `packages/cli/src/commands/mem.ts` — implementation
- `packages/cli/test/commands/mem-helpers.test.ts` — pure-function tests
- `packages/cli/test/commands/mem-platforms.test.ts` — per-platform fixture tests
- `packages/cli/test/commands/mem-since-cross-day.test.ts` — cross-day regression
- `packages/cli/test/commands/mem-integration.test.ts` — end-to-end
- `packages/cli/test/commands/mem-phase-slice.test.ts` — phase slicing tests
- `.trellis/tasks/05-08-mem-since-cross-day-filter/` — historical context for
  the `inRangeOverlap` switch
- `.trellis/tasks/05-08-mem-phase-slice/` — historical context for the
  `--phase` flag and `[task.py create, start)` boundary signal
