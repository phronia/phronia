# Design: Path-scoped on-demand spec injection

> Revision history: the v1/v2 designs below record how the implementation
> evolved. The current contract is `.trellis/spec/cli/backend/spec-injection.md`;
> transcript-based clocks and `compact_boundary` parsing were superseded by
> documented `SessionStart(source=clear|compact)` lifecycle resets in
> `.trellis/tasks/archive/2026-07/07-27-compaction-event-reset/design.md`.

## Architecture

```text
.trellis/spec/**/*.md  (optional frontmatter: paths: [globs])
        │  bounded head-read + hand-rolled frontmatter parse
        ▼
common/spec_match.py  ── match(file_path) -> [SpecMatch(path, description)]
        │                                   │
        ▼                                   ▼
shared-hooks/inject-spec-context.py   get_context.py --mode spec --file <p>
  (Claude PostToolUse Read|Edit|Write|MultiEdit;
   SessionStart clear|compact reset)          (pull mode, all platforms)
  budget + ticket refresh + lifecycle reset + truncation
  → hookSpecificOutput.additionalContext
```

## Contracts (historical v1; superseded)

### 1. Frontmatter (parsing in `common/spec_match.py`, new)

- Only files whose first line is exactly `---` are considered; scan ends at the
  closing `---` or after 100 lines / 8 KiB head-read, whichever first.
- Recognized: `paths:` followed by `- <glob>` items (flat list). `name:` /
  `description:` single-line strings tolerated (description reused in index
  lines). Unknown keys ignored. Hand-rolled parser modeled on
  `channel/agent-loader.ts` / `trellis_config.parse_simple_yaml` style —
  no YAML dependency.
- Glob validation: repo-relative, POSIX separators, must not be absolute, no
  `..` segments, charset `[A-Za-z0-9_./*?-]`. Invalid entry ⇒ stderr warn, skip
  that glob (not the whole file).
- Glob semantics: `**` matches across segments, `*` within a segment, `?`
  single char. Implemented by deterministic translation to a compiled regex
  (documented in module docstring with examples; unit-tested). A glob ending
  in `/` is sugar for `<glob>/**`.

### 2. `common/spec_match.py` API

```python
@dataclass(frozen=True)
class SpecMatch:
    spec_path: Path        # absolute
    rel_path: str          # repo-relative, for display
    description: str | None

def match_specs_for_file(repo_root: Path, file_path: str | Path) -> list[SpecMatch]:
    """file_path absolute or repo-relative; returns exact/narrow matches before
    broad matches, with rel_path as the final tie-break. Scans
    .trellis/spec/**/*.md head-reads only. Never raises; unreadable spec files
    are skipped with stderr warning."""
```

### 3. Hook `shared-hooks/inject-spec-context.py`

- stdin: Claude hook JSON. Uses `session_id`, `cwd`, `tool_name`,
  `tool_input.file_path`. Missing/foreign fields ⇒ exit 0 silently.
- Kill switches: honors `TRELLIS_HOOKS=0` / `TRELLIS_DISABLE_HOOKS=1` like the
  other shared hooks; config `spec_injection.enabled: false` disables.
- Flow: resolve repo root (existing hook convention from cwd) → match →
  dedup-filter → budget-assemble → emit
  `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": ...}}`
  or nothing at all when the final payload is empty.
- Payload shape per spec:
  `<spec-context file="<edited rel path>" spec="<spec rel path>">\n<body>\n</spec-context>`
  with truncation notice inside when capped. Overflow-degraded matches are
  emitted as one `<spec-index>` block of `- <rel_path> — <description|no description>` lines.
- Budgets (config `spec_injection:`): `max_spec_bytes` default 8192,
  `max_total_bytes` default 9000 (Claude additionalContext hard ceiling is
  10,000 chars — stay under with margin), `0` = unlimited. UTF-8-safe
  truncation reusing the truncate_utf8 approach from inject-subagent-context.py
  (self-contained copy — shared-hooks scripts are standalone by design).

### 4. Session dedup state

- File: `.trellis/.runtime/spec-injection/<sanitized session_id>.json`
  → `{"<spec rel path>": <mtime-at-injection>, ...}`.
- Eligible again when current mtime != recorded mtime.
- Prune sibling state files older than 48 h (mtime) on each run, best-effort.
- All state IO fail-open (inject rather than skip) and non-fatal.
- `.runtime/` already gitignored (`.trellis/.gitignore`).

### 5. Pull mode (`get_context.py --mode spec --file <path>`)

- New mode in `common/git_context.py` dispatch → `spec_match`.
- Output: one line per match `<rel spec path> — <description|(no description)>`,
  or `No spec files declare paths matching <path>.` Exit 0 always.
- No budget/dedup (it lists paths, not bodies).

### 6. Registration / distribution

- `templates/claude/settings.json`: add PostToolUse block with matchers
  `Edit`, `Write`, `MultiEdit` → `{{PYTHON_CMD}} .claude/hooks/inject-spec-context.py`,
  timeout 15 (matcher casing/shape copied from existing PreToolUse entries).
- `templates/shared-hooks/index.ts` SHARED_HOOKS_BY_PLATFORM: add
  `inject-spec-context.py` to claude only (comment: other platforms follow-up;
  table drives both init and update).
- Dogfood mirrors: `.claude/settings.json`, `.claude/hooks/inject-spec-context.py`,
  `.trellis/scripts/common/spec_match.py`, get_context dispatch mirror.

### 7. Dogfood frontmatter (translate existing index.md checklist, no invention)

E.g. `commands-workflow.md` → `packages/cli/src/commands/workflow.ts`,
`packages/cli/src/utils/workflow-resolver.ts`; `commands-update.md` →
`packages/cli/src/commands/update.ts`; `script-conventions.md` →
`.trellis/scripts/**`, `packages/cli/src/templates/trellis/scripts/**`,
`packages/cli/src/templates/shared-hooks/**`; `platform-integration.md` →
`packages/cli/src/configurators/**`, `packages/cli/src/templates/**` (will
truncate at cap — the notice + path is the point); full set = whatever
`.trellis/spec/cli/backend/index.md` Pre-Development Checklist names.

## Failure-mode table

| Failure                                         | Behavior                                                       |
| ----------------------------------------------- | -------------------------------------------------------------- |
| No frontmatter anywhere (all existing projects) | zero matches, no output                                        |
| Malformed frontmatter                           | stderr warn, spec skipped                                      |
| Spec listed but unreadable                      | stderr warn, skipped                                           |
| State dir unwritable                            | inject (fail-open), warn                                       |
| Hook crashes (bug)                              | exit code guarded by top-level try/except → exit 0             |
| additionalContext near ceiling                  | budget keeps total ≤ 9000 bytes                                |
| Windows PostToolUse quirk                       | cosmetic error display only (#45065); worst case: no injection |

## Compatibility

- Projects without frontmatter: hook emits nothing; the only observable delta
  is one extra fast subprocess per Edit/Write. Mitigation: bail out before any
  spec scan when `.trellis/spec` is absent; head-reads are bounded.
- Sub-agents editing matched files receive the injection themselves (verified:
  PostToolUse fires for subagent tool calls; context lands in the editing
  agent's context) — complements, never duplicates, JSONL curation (different
  channel; dedup is per session).
- No interaction with #464 / PR #456 (different injection paths).

## Rollback

Revert removes hook + registration + frontmatter; specs with leftover
frontmatter are inert prose to every other consumer (parsers all skip it —
verified: session-start spec-path listing and index.md readers treat it as
content; harmless `---` block at file top).

Wait — verify that claim during implementation: grep any spec consumers that
would choke on a leading `---` block (e.g. spec-refresh hash tracking is
byte-based, fine; index.md Guidelines tables are prose, fine).

---

# Historical design v2: ticket-refresh

This section superseded v1's session dedup at the time. Its transcript-clock
details are themselves superseded by the lifecycle-reset design linked at the
top of this file.

## Emissions (frozen formats)

FULL (per matched spec; sha256 attr added vs v1):

```xml
<spec-context file="<edited rel>" spec="<spec rel>" sha256="<first 12 hex>">
<spec body, budgeted, truncation notice inside when capped>
</spec-context>
```

TICKET (per matched spec):

```xml
<spec-ticket file="<edited rel>" spec="<spec rel>" sha256="<first 12 hex>">
You were shown this spec earlier in this session and its content is unchanged.
It still governs edits to matching files. If you no longer remember it, Read
<spec rel> before continuing.
</spec-ticket>
```

Overflow degradation (`<spec-index>` block) applies to FULL bodies; the index
block is itself budget-bounded — lines that do not fit collapse into one
summary line `- (+N more governing specs over budget — run get_context.py
--mode spec --file <edited rel> to list them)` so the ceiling is honored while
no governing spec is ever silently dropped. Tickets are counted against the
total budget last — if even they do not fit, drop with stderr warn, never
malformed JSON.

## Decision engine

```text
EDIT_TOOLS = ("Read", "Edit", "Write", "MultiEdit")

identity, stateless = resolve_identity(root, payload)
  # Session/window key DELEGATED to common.active_task.resolve_context_key
  # (payload-first: allow_environment_context=False, then an env-inclusive
  # second pass) — inherits all platform-verified key handling. On top:
  # "+a-" + sanitize(agent_id) when payload has non-empty agent_id;
  # minimal payload-only fallback ladder when the resolver is unavailable;
  # no key from any source → stateless=True (ticket-only, zero state IO)
clock = {"lines": line_count(transcript_path) or None, "ts": time.time()}
for spec in matches:                    # specificity, then rel_path order
    h = sha256(spec bytes).hexdigest()
    last = newest state line for spec   # None when stateless or no record
    decide per PRD v2 state machine; window compare:
      both have lines → lines delta vs refresh_window_lines
      else            → ts delta vs refresh_window_seconds
      incomparable    → past-window
      NEGATIVE delta  → past-window (transcript compacted shorter / clock
                        skew: the earlier injection was likely lost — the
                        over-inject side of the asymmetry principle)
    emit FULL or TICKET → append state line (mode recorded); silent → no append
```

## State file contract

Path: `${TRELLIS_SPEC_STATE_DIR:-~/.trellis/spec-inject}/<project16>/<identity>.<pid>.jsonl`
project16 = sha256(str(realpath(repo_root)))[:16]
Line: {"v":1,"spec":"<rel>","sha256":"<64hex>","mode":"full"|"ticket","ts":<float>,"lines":<int|null>,"pid":<int>}
Read: merge every `<identity>.*.jsonl` shard, newest record per spec wins
(ts is the tiebreaker); malformed lines skipped silently.
Write: O_APPEND single line to own-pid shard; failure → stderr warn, proceed.
GC: under the base dir, when `.last-gc` mtime older than 1 h: touch it, then
unlink any `*.jsonl` with mtime older than 48 h (best-effort, errors ignored).

## Config keys (template + doc)

```yaml
spec_injection:
  enabled: true
  max_spec_bytes: 8192
  max_total_bytes: 9000
  refresh_window_lines: 300 # transcript-line clock; 0 = never refresh
  refresh_window_seconds: 2700 # wall-clock fallback;  0 = never refresh
```

## Registration delta

claude settings template + live mirror: PostToolUse matchers gain "Read"
(same command/timeout shape). No other platform wiring.

## Explicitly rejected in this scope (upstream doc's larger plan)

Kernel ABI / forwarding shells / behavior registry / config.resolved.json /
heartbeat / doctor / interpreter baking — P-1..P4 territory, separate efforts.
Tier-3 ppid identity: reserved, unwired (rationale in PRD v2 §2).

---

# Review revision (2026-07-25) — taosu's PR #468 review, evidence-frozen contract

Every item below maps to taosu's review comments verbatim. Facts re-verified on
this machine before freezing (real transcripts under ~/.claude/projects: 28
lines/real-turn on a local sample vs his 124 — both confirm lines≫turns; compact
appends `compact_boundary` and files never shrink — 2 local samples; subagent
transcripts exist at `<parent-uuid>/subagents/agent-<id>.jsonl` — 57 local
files). Claude Code docs re-fetched 2026-07-25: matcher `"Edit|Write"` pipe
lists are official (PostToolUse example verbatim), and ALL hook output strings
including additionalContext cap at 10,000 characters.

## R1. Budget in characters (review §1)

- Config keys renamed: `max_spec_chars` (default **9400**) / `max_total_chars`
  (default **9500**). Rationale: ceiling is 10,000 **characters** (platform's
  own unit — bytes made CJK pay 3×); 9500 leaves headroom; 9400 leaves wrapper
  room so taosu's 9,353-char CJK example injects **whole**. `0` = unlimited.
- Hard ceiling: budget checked on the **assembled payload string** (wrappers,
  `\n\n` separators, `<spec-index>` block, `(+N more)` summary, tickets — all
  counted). Nothing is appended unchecked (fixes review §7 "budget accounting
  misses two things").
- Truncation is by code points (`body[:max_spec_chars]` + notice) — character
  slicing cannot split a multi-byte sequence; byte-level truncate_utf8 is no
  longer needed in THIS hook.

## R2. Clock = real turns + compact boundaries (review §2, §3)

- `refresh_window_lines` → **`refresh_window_turns`** (default **30**, the
  originally-intended "30 turns of breathing room"). `refresh_window_seconds`
  2700 unchanged (fallback when no transcript).
- A **turn** = transcript line with `type=="user"` AND `message.content` is a
  string AND no `isMeta` (taosu's rule, verified locally).
- A **compact boundary** = line with `type=="system"`,
  `subtype=="compact_boundary"`. Transcripts are append-only (verified) — the
  negative-delta-as-compact guard was built on a false assumption and is
  DEMOTED to a plain clock-anomaly guard (still past-window, safe direction);
  docs/tests must stop claiming it detects /compact.
- decide() gains a boundary rule, placed BEFORE the window check:
  `boundaries_now > last.boundaries (both known) → FULL` — after compaction the
  text is genuinely gone; "a ticket would be wrong here" (review comment 2).
- Scan is single-pass with substring prefilter before json.loads; 64 MiB cap
  falls back to wall clock (unchanged).

## R3. Subagent clock (review §4)

- When `agent_id` is present, the clock reads the SUBAGENT's own transcript,
  derived: `<transcript dir>/<parent stem>/subagents/agent-<agent_id>.jsonl`
  (convention verified, 57 files locally). If that file is absent → wall
  clock — NEVER the parent's line/turn count (parent idles while the subagent
  runs; measuring it under-injects, the unacceptable direction).
- Identity/state separation via `+a-<agent_id>` suffix unchanged.

## R4. State: one file per session, no pid shards, locked (review §5)

- Shard path becomes `<base>/<project16>/<identity>.jsonl` — **no pid**.
  Fresh-process-per-hook made pid shards one-file-per-emission with
  O(session) glob+merge on every event; O_APPEND short-line appends are safe
  (taosu measured 12×38KB concurrent, zero corruption).
- Records: `{v:2, spec, sha256, mode, ts, turns, boundaries}`; `v != 2`
  records ignored (safe direction: re-inject).
- Best-effort `fcntl.flock` held across read→decide→append closes the
  duplicate-injection race on POSIX; on platforms without fcntl → no lock,
  fail-open (documented).

## R5. Fail-closed gaps (review §6)

- **Circuit breaker**: state dir/file unwritable (probe at resolve time) →
  the event runs in stateless ticket-only mode (no reads, no writes, no FULL
  re-emission loop). Reproduces review's "8,986 bytes three runs in a row" →
  now three tickets.
- **GC scope**: no rglob. Exactly `base/<16-hex-project>/<name>.jsonl` where
  name matches `^[A-Za-z0-9_-]+(\.[0-9]+)?\.jsonl$` (second alternative covers
  our own legacy pid shards), mtime > 48h, hourly `.last-gc` gate. Foreign
  files/dirs are never touched even via a hostile TRELLIS_SPEC_STATE_DIR.

## R6. Robustness smalls (review §7)

- **Glob validation** flips whitelist→blacklist: reject only empty / leading
  `/` / `..` segment / `\` / control chars. `@scope`, `[slug]`,
  `(marketing)`, non-ASCII dirs now valid (translation already escapes
  literals char-by-char).
- **Stateless ticket wording**: stateless (and circuit-breaker) tickets use a
  body that does NOT claim prior exposure: "This spec governs the file you
  just touched. If you have not read it in this session, Read <path> before
  continuing." Stateful past-window ticket text unchanged.
- **Frontmatter tolerance**: unknown line shapes are ignored; block scalars
  (`key: >` / `key: |`) consume their indented continuation; stray `- item`
  ignored. Only a malformed `paths:` itself (inline scalar) still warns+skips
  the file. A SKILL.md-style `description: >` no longer kills the spec.
- **Windows stdin**: reconfigure stdin alongside stdout (per this repo's own
  script-conventions "Windows stdio Encoding").
- **settings.json**: ONE PostToolUse entry, matcher `"Read|Edit|Write|MultiEdit"`
  (official docs list-of-exact-strings semantics). New optional config
  `spec_injection.tools` (list, default those four) filters in-hook so users
  can e.g. drop Read.

## R7. Structure (review "On structure")

- Pure logic extracted to **`common/spec_inject.py`** (registered in
  templates/trellis/index.ts + live mirrors): scan_transcript, decide,
  within_window, truncate_chars, render_full/render_ticket, assemble_payload,
  record helpers. Hook keeps IO/orchestration only. Unit tests import the
  module directly (runSpecProbe pattern).
- read+hash before decide is KEPT deliberately: sha-change-beats-window
  requires knowing current content; a stat shortcut would weaken that
  contract. Recorded here as an accepted trade-off, not an oversight.

## R8. Back-port (review "Pre-existing bug")

- The truncate_utf8 boundary fix (complete trailing sequence kept whole) is
  back-ported to inject-subagent-context.py template + live twins, with
  taosu's exact repro cases as regression tests ("你好世界" cap 6 → "你好").

## Explicitly NOT in this revision (with review's own words)

- Transcript-as-state full rewrite: "orthogonal … you may well have considered
  and rejected it"; comment 3 confirms the standalone findings above hold
  regardless. Tracked as the likely next-iteration direction.
- Rules-section spec authoring: "treat it as a separate question".
- settings.json structured merge for existing users: requires the hooks-merge
  capability (a separate PR per the architecture doc); acknowledged in review
  reply as a known follow-up.
- Cross-platform provider contract: moved by taosu to discussion #474.

## Contract amendments (post-validation, same day)

Stage V1's hermetic validation surfaced four defects IN THE FROZEN CONTRACT
ITSELF (implemented as written, reported instead of improvised — see the run
report). Amendments, each with the measured evidence that forced it:

1. **R1 amendment — derived truncation cap.** As frozen,
   `truncated-body (9400) + notice (~114) + wrapper (~148) > 9500`, so any spec
   over ~9,240 chars
     degraded to an index line — the truncation path was unreachable (measured:
     30,000-char fixture → 66-char index-only payload; live commands-update.md
     34,985 chars → index-only, WORSE than pre-review). Amended rule: a FULL
     that cannot fit whole is truncated to the LARGEST body prefix that still
     fits the remaining total budget (wrapper + notice counted, join-accurate);
     `max_spec_chars` remains an upper bound. Defaults stay 9400/9500.
2. **R5 amendment — GC name class gains `+`.** The frozen regex could not
   match `+a-<agent_id>` subagent shards (R3's own suffix), so they were never
   pruned. New pattern: `^[A-Za-z0-9_+-]+(\.[0-9]+)?\.jsonl$`.
3. **R1 amendment — summary must be reachable.** Greedy index packing left
   less slack than one summary line (~103 chars), so "(+N more)" almost never
   appeared and over-budget specs vanished with only a stderr warn. Amended:
   when the summary does not fit, pop already-chosen index lines (re-counting
   them as dropped) until it fits; only an absurdly small total budget can
   drop the summary (stderr warn stays).
4. **R2 amendment — prefilter tolerates both JSON spacings.** The byte
   prefilter now matches `"type":"user"` AND `"type": "user"` (same for the
   boundary subtype), removing the silent zero-turn failure mode against
   producers that emit a space after the colon.

---

# Audit fix round (2026-07-25) — frozen contract F1-F20

Input: the 32-confirmed / 5-partial adversarial audit (41 agents, every finding
reproduced). Decisions below are final for this round; agents implement
verbatim and report contract defects instead of improvising.

## F1 (HIGH) Subagent clock beats

Main transcripts tick on real user turns (unchanged). Subagent transcripts
(agent_id present) tick on **assistant-message lines** (`type=="assistant"`,
parsed not substring-guessed) — the agent-loop iteration is the conversation
beat there; real user turns are structurally frozen at 1 (verified: 58/58 real
subagent transcripts). scan_transcript returns
{"turns", "assistant_turns", "boundaries"}; the hook selects beats =
assistant_turns when agent_id is present, else turns. One window key
(refresh_window_turns=30) — unit is "beats of that transcript". Docs define
both beats explicitly.

## F2 Identity: collision-free sanitization

Replace truncate-and-collapse _sanitize: keep filesystem-safe head
(re.sub [^A-Za-z0-9_-] -> "-", first 80 chars) and, WHENEVER any character was
replaced OR length exceeded 80, append "-" + sha256(raw)[:8]. Distinct raw keys
can no longer fold together. GC name regex unchanged (output stays in
[A-Za-z0-9_+-]). The `+a-<agent_id>` suffix is appended AFTER sanitization of
each part, preserving subagent separation.

## F3 One normalization

spec_match.\_normalize_repo_relative becomes the exported canonical
(resolve(strict=False) both root and file to kill /tmp-vs-/private/tmp and
symlink divergence; NFC-normalize; on darwin/win32 the glob regexes compile
with re.IGNORECASE — case-insensitive filesystems, over-inject-safe). Hook
deletes \_repo_rel and imports the canonical. rel_path stored/displayed and
rel used for matching are now the same string by construction.

## F4 Frontmatter robustness

- Flow sequences supported: `paths: [a, b]` splits on commas + unquotes each.
- Head-read bound raised to 16 KiB / 200 lines; hitting the bound BEFORE the
  closing `---` => warn + skip spec (never silently partial).
- Opening `---` with NO recognized key before the closing marker => treated as
  not-frontmatter (hr-opening prose files unaffected), no warning.

## F5 Config surface honesty

- tools accepts block lists, flow lists ("[Edit, Write]"), and "[]" == disable
  all triggers (early exit). Unknown tool names warn once to stderr.
- max_spec_chars: 0 == unlimited FULL body (fix \_derive hi bound to len(text));
  0 stays documented and tested.
- MAX_SPEC_SOURCE_BYTES = 10 MiB: larger spec files degrade to index line with
  a stderr warn (no unbounded read+hash).

## F6 Budget: named-index reserve + honest tickets

- Reserve while more candidates pend = actual per-candidate index-line sizes
  (true strings, not estimates) + summary line, capped at 900 chars; if the cap
  binds, fall back to summary-only reserve. §5 doc claim softened to match
  (named lines guaranteed only within the cap).
- Records gain optional "complete": false when a FULL was derived-truncated
  below the whole body (absent == true). decide(): an incomplete last record
  is re-taught as FULL when past window instead of a ticket — the stateful
  ticket wording ("you were shown this spec") must never be a lie.
- fits/fits_reserved merged into one closure.

## F7 GC containment hardening

Skip when project_dir or shard is a symlink; verify realpath(shard) stays
under realpath(base). Keep name/depth gates.

## F8 Fail-soft scan

scan_transcript catches Exception (not just OSError) -> None (wall-clock
degrade); the whole injection event must never abort because a transcript
line was hostile.

## F9 Platform-neutral input

tool_input falls back to camelCase toolInput (sibling-hook parity). Windows
stream reconfigure covers stderr too (six-hook parity).

## F10 Duplication removals

\_unquote/\_strip_inline_comment imported from .trellis_config (copies deleted);
SpecCandidate Protocol deleted — spec_inject imports SpecMatch from
.spec_match; load_state tie-break fixed to newest-wins on equal ts.

## F11 Truthful docs & wording

- \_derive_fitting_full docstring rewritten (binary search).
- Hook module docstring: delegation-era identity description.
- spec-injection.md: beats definition, sanitization scheme, reserve rule,
  complete-flag re-teach, GC symlink rule, bounds (16KiB/200), tools grammar,
  corrected 9400/9500 arithmetic (wrapper ~152 chars, spec <= ~9348 lands
  whole), purge pid-merge vocabulary, fix code-map claim about live config.
- index.md Guidelines row rewritten for v2 reality; checklist row includes
  common/spec_inject.py.
- Summary line: dynamic plural + runnable command
  ("python3 ./.trellis/scripts/get_context.py --mode spec --file <path>");
  frozen-wording tests updated in lockstep.
- The em-dash escape artifact in spec_match.py comment fixed.

## F12 Pi TS coverage

New test transpiles truncateUtf8 out of pi/extensions/trellis/index.ts.txt via
the typescript devDep (transpileModule), runs taosu's repro cases + a cap
sweep. Reverting the TS fix must turn the suite red.

## F13 Five §12-required tests

Implemented as written in the doc (or the doc line amended in the same commit
when the case is genuinely untestable — each such amendment justified inline).

## Accepted, documented, not changed

- Config numeric-coercion helper stays local to the hook (changing shared
  common/config.py has wider blast radius than the duplication costs) —
  comment added citing this decision.
- State-dir layout intentionally diverges from channel per-project buckets
  (user-global by design, review-agreed) — doc note added.
- Mixed-comparability compaction gap (wall-clock record then transcript event)
  self-heals on the next transcript-based emission; documented as a bounded
  known gap with the healing mechanism named.

## Verification bar for this round (user-mandated)

Real-state evidence required: shipped scanner run against REAL transcripts on
this machine (main session, subagent, compacted) with sane counts asserted in
the gate log; every fixed finding re-run through its original audit repro;
full suite green; mirrors byte-identical.
