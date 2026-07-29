# PRD: Path-scoped on-demand spec injection

> Revision history: this task began with inject-once and transcript-clock
> designs. Those historical sections are retained below, but the current
> requirements and acceptance criteria are the first sections in this file.
> The executable contract is `.trellis/spec/cli/backend/spec-injection.md`;
> lifecycle reset details live in
> `.trellis/tasks/archive/2026-07/07-27-compaction-event-reset/prd.md`.

## Problem

Specs accumulate. This repo's own `.trellis/spec/` is 884 KB across 40 files
(cli/backend alone 680 KB; platform-integration.md is 162 KB — 5× the 32 KiB
per-file sub-agent cap and larger than the whole 128 KiB budget). Full injection
is impossible: Claude Code caps `additionalContext` at 10,000 characters, and
the 07-22-subagent-context-limits caps protect the sub-agent path for good reason.

Today the main session gets spec index **paths only** at SessionStart, and
"agent reads on demand" is unreliable — the model may simply not read them
(the recorded rationale for rejecting pure index-mode in
07-22-subagent-context-limits applies to the main session too). The
`cli/backend/index.md` Pre-Development Checklist already maps code paths to
spec files ("Editing `commands/update.ts` → commands-update.md") — but it is
prose, followed only when the model happens to read and obey it. The failure
mode: rules exist, model edits a matching file 99 turns in, rules are not in
context, model violates them.

**Goal: when the agent edits a file, the specs that govern that file are
injected right then — small, relevant, budgeted — instead of everything
up front or nothing at all.**

## Mechanism (summary)

1. Spec .md files declare which code paths they govern via YAML frontmatter
   (`paths:` glob list).
2. A shared hook `inject-spec-context.py` fires after Read/Edit/Write/MultiEdit
   (Claude Code PostToolUse), matches the touched file path against spec
   frontmatter, and injects matching content with a fixed ticket-refresh
   window. `SessionStart(source=clear|compact)` records a lifecycle reset so
   the next matching touch receives full content again.
3. A pull-mode command `get_context.py --mode spec --file <path>` exposes the
   same matching for platforms without tool-event hooks (and for testing).

Symlinking specs into code directories (an idea from the original discussion)
is explicitly dropped: nothing reads directory-local files today, symlinks
break on Windows without privileges, complicate `trellis update` hash
tracking, and a glob mapping is strictly more expressive (one spec ↔ many
directories).

## Requirements (current)

1. **Frontmatter contract** (optional, additive): spec .md files MAY start with
   a `---` frontmatter block containing `paths:` — a list of repo-relative
   globs (`*` within a path segment, `**` across segments). `name` /
   `description` keys are tolerated; descriptions are reused in index
   degradation and pull-mode output. Files without frontmatter behave exactly
   as today. Parsing is hand-rolled (house pattern — no YAML dependency).
2. **Matching**: edited file's repo-relative path tested against every
   `.trellis/spec/**/*.md` frontmatter's globs (`index.md` files included if
   they declare paths). Scan reads only the frontmatter head of each file
   (bounded read), not whole bodies.
3. **Injection hook** (`shared-hooks/inject-spec-context.py`), Claude Code
   registration: PostToolUse matcher `Read|Edit|Write|MultiEdit`, plus
   `SessionStart` for `clear` and `compact`. Tool events emit standard
   `hookSpecificOutput.additionalContext`; lifecycle resets write state and
   emit nothing. Non-matching events, missing file_path, no matches, any
   internal error → exit 0 (stderr warning allowed; never block the host).
4. **Refresh state**: user-global append-only JSONL under
   `~/.trellis/spec-inject/<project16>/<identity>.jsonl`. The first matching
   touch emits FULL, unchanged touches inside the fixed wall-clock window are
   silent, and older content receives a compact TICKET. Content hash changes
   or a later `SessionStart(source=clear|compact)` reset emit FULL again.
   Parent and subagent histories remain separate while sharing the base
   lifecycle reset. The hook never opens or parses transcript contents.
5. **Budget**: per-spec and per-event character caps with UTF-8-safe truncation and
   an explicit `[Trellis: truncated — read <path>]` notice (reuse the #441
   truncation conventions). Defaults fit Claude Code's **10,000-character**
   additionalContext ceiling: per-spec 9,400 characters, per-event total 9,500
   characters. Configurable via `.trellis/config.yaml` `spec_injection:`
   section; `0` = unlimited. Overflow specs degrade to an index line or bounded
   summary — never silently dropped.
6. **Pull mode**: `get_context.py --mode spec --file <path>` prints matching
   spec paths + descriptions (not bodies) — same matching engine, usable by
   class-2 platforms, skills, and tests. With `--json`, it emits the requested
   file plus a structured `matches` array; no match is an empty array.
7. **Cross-platform posture**: hook registered on Claude Code only this
   iteration. PostToolUse fires for subagent tool calls too, injecting into the
   touching agent's own context. Documented SessionStart `clear` / `compact`
   events drive reset state; undocumented transcript records are not a
   contract. The script keeps the shared-hooks platform-neutral shape so later
   registrations are wiring-only. Class-2 platforms get pull mode.
8. **Dogfood**: add `paths:` frontmatter to the `.trellis/spec/cli/backend/`
   specs already named by the index.md Pre-Development Checklist mapping
   (translate the existing prose mapping; do not invent new mappings).
9. **Distribution**: SHARED_HOOKS_BY_PLATFORM gains the new script for claude;
   `claude/settings.json` gains one PostToolUse registration plus SessionStart
   reset registrations; live `.claude/settings.json` + `.claude/hooks/` stay
   byte-equivalent to their shipped templates after placeholder substitution.
10. **Spec doc**: new `.trellis/spec/cli/backend/spec-injection.md` documenting
    frontmatter, matching, budgets, ticket refresh, lifecycle reset, identity,
    state, failure behavior, and the platform matrix; index.md table entry added.

## Non-goals

- No symlink mechanism (rationale above).
- No hook registration on non-Claude platforms this iteration (follow-up
  matrix documented in the spec doc).
- No auto-generation of frontmatter from index.md checklists (possible
  follow-up for trellis-spec-bootstrap).
- No change to sub-agent JSONL curation or its budgets.
- No central mapping config in config.yaml (frontmatter is the single source;
  avoids two sources of truth).
- No caching/index of frontmatter (bounded head-reads are cheap; caches
  invalidate).

## Acceptance Criteria (current)

- [ ] First touch of a matched file emits FULL; a second unchanged touch inside
      the wall-clock window is silent; an older touch emits a TICKET.
- [ ] A content-hash change or `SessionStart(source=clear|compact)` causes the
      next unchanged matching touch to emit FULL. Reset events emit no stdout.
- [ ] Parent and subagent emission histories remain separate while the base
      lifecycle reset invalidates both.
- [ ] Editing a file matching no spec, or a project with zero frontmatter
      specs: hook exits 0, empty output (byte-identical behavior to no hook).
- [ ] Oversized spec truncated at cap with notice; when per-event budget is
      exhausted remaining matches degrade to index lines.
- [ ] `get_context.py --mode spec --file packages/cli/src/commands/workflow.ts`
      lists commands-workflow.md; adding `--json` emits a structured `matches`
      array for both matching and no-match cases.
- [ ] Malformed frontmatter (bad YAML, non-list paths, absolute/`..` globs)
      → that spec is skipped with a stderr warning; hook still exits 0.
- [ ] `spec_injection.enabled: false` disables injection entirely.
- [ ] Production spec-injection code never opens or parses transcript contents.
- [ ] `pnpm lint && pnpm lint:py && pnpm typecheck && pnpm test` — no new
      failures vs the recorded main baseline (5 pre-existing).

---

# Historical PRD v2: transcript-clock ticket refresh

Source: taosu's v2 architecture doc (2026-07-24, "内核当子进程,平台侧只剩薄适配器",
§4 凭条机制 / §11 spec-inject / §12 会话身份四档阶梯 / §12.1 状态存储). Scope here is
the FEATURE only — the kernel-ABI refactor (P-1..P4) is explicitly out of scope.
This section records the intermediate v2 design. Transcript clock/boundary
details below are superseded by the current lifecycle-event reset contract.

## Why v1 semantics are wrong

v1 injects a spec once per session, then stays silent forever. The original
problem statement is recency decay: by round 100+ the agent no longer follows
rules that sit deep in history. Inject-once does not solve that; it recreates it.

## v2 behavior (per spec, per event)

```text
tier = identity ladder (below)
h    = sha256(spec content)
last = last emission recorded for (identity, spec)   # tier STATELESS → None

if tier == STATELESS:            emit TICKET          # bounded cost, always
elif last is None:               emit FULL TEXT
elif last.sha256 != h:           emit FULL TEXT       # spec changed → re-teach
elif clock - last.clock < WINDOW: silent               # fixed window: no state append
else:                            emit TICKET          # refresh attention cheaply
```

- FIXED window, not sliding: silent hits do NOT extend the window (continuous
  editing is exactly when drift is worst).
- A TICKET emission also appends state (tickets are rate-limited by the same window).

## Requirements (delta over v1)

1. **Triggers**: add `Read` to the matchers (Read/Edit/Write/MultiEdit) — touching
   a file counts; miss path must stay a fast exit.
2. **Identity ladder** (misfire asymmetry: collision→missed injection is
   unacceptable; drift→extra injection is fine):
   - The session/window key is DELEGATED to
     `common.active_task.resolve_context_key` (the shared, platform-verified
     resolver every other hook uses), called payload-first so env overrides
     can never collapse two live sessions onto one identity.
   - When payload carries `agent_id` (subagent context), identity includes it —
     parent and subagent must NOT share state (context is not shared between them).
   - Resolver unavailable (older scripts tree) → minimal payload-only fallback.
   - No key from any source → stateless: no state IO; every hit emits TICKET only.
   - ppid+TTL identity is documented as reserved for future CLI-only platforms
     and NOT wired (unreliable CLI-vs-IDE detection would violate the
     asymmetry principle).
3. **Clock**: transcript line count when `transcript_path` readable, else epoch
   seconds. State records both when available; compare lines-to-lines else
   seconds-to-seconds; units incomparable → treat as past-window (over-inject side).
4. **State**: user-global, out of the repo —
   `~/.trellis/spec-inject/<project16>/<identity>.<pid>.jsonl`, append-only JSONL,
   per-pid shard (merge on read, newest wins), bad lines skipped, best-effort
   (any state IO failure degrades toward emitting). `TRELLIS_SPEC_STATE_DIR`
   overrides the base dir (tests/hermeticity). GC: prune files older than 48 h,
   at most once per hour via a `.last-gc` mtime marker, event-independent.
5. **Config** (`spec_injection:`): existing keys plus
   `refresh_window_lines` (default 300) and `refresh_window_seconds` (default 2700,
   used when the line clock is unavailable). Both 0 → never refresh (v1 behavior).
6. **Payload shapes** are frozen contracts (see design.md v2 §emissions).
7. Budgets/truncation/degradation/pull mode/frontmatter engine: unchanged.

## Acceptance criteria (v2)

- [ ] First touch of a matched file → full `<spec-context>` block (with sha256 attr).
- [ ] Second touch within window → empty output.
- [ ] Touch past the line window (fixture-controlled transcript) → `<spec-ticket>`
      block, few-hundred-byte order, containing spec path + sha prefix + Read hint.
- [ ] Spec content edited between touches → full text again (hash change beats window).
- [ ] Payload without any identity → ticket-only on every hit, zero state files.
- [ ] Payload with `agent_id` keeps separate state from same `session_id` without it.
- [ ] `Read` tool event triggers exactly like Edit.
- [ ] State lands under `TRELLIS_SPEC_STATE_DIR` when set; stale files pruned by GC.
- [ ] Full gate green (lint, typecheck, lint:py, full test suite vs baseline).

## OpenCode extension (2026-07-29)

OpenCode 1.17.18 exposes target paths in `tool.execute.before`, but the stable
hook contract cannot return `additionalContext` and resume the same tool call.
Trellis therefore uses the platform's documented blocking behavior:

1. Intercept `write`, `edit`, and `apply_patch` before execution.
2. Adapt `filePath` / `patchText` to the existing shared Python spec engine.
3. When a FULL spec was emitted and its state record persisted, throw a
   model-visible tool error containing the context.
4. Let OpenCode continue the model loop; the shared state makes the model's
   retry silent and executable.
5. Map `session.compacted` to `SessionStart(source=compact)`.

Ticket-only and failure responses do not block. This prevents an unwritable
state directory from creating an infinite retry loop. Bash, MCP, custom tools,
and non-Trellis subagents remain outside this adapter's mutation boundary.

Acceptance:

- [x] Fresh `write` / `edit` / multi-file `apply_patch` sees the governing
      FULL spec before any mutation and succeeds on retry.
- [x] `session.compacted` resets exposure so the next governed mutation
      receives the FULL spec again.
- [x] Missing hook, subprocess failure, malformed output, stateless ticket, and
      ordinary refresh ticket all proceed without blocking.
- [x] Init and update both install `.opencode/plugins/inject-spec-context.js`
      and `.opencode/hooks/inject-spec-context.py`.
