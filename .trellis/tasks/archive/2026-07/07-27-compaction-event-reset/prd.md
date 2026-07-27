# Replace transcript parsing with compaction events

## Goal

Make spec reinjection after Claude context resets depend only on documented hook
events, never on Claude's internal transcript contents or directory layout.

## Background

PR #468 currently scans Claude transcript JSONL for user/assistant records and
`compact_boundary`. Claude documents `transcript_path`, but not the transcript
record schema, append timing, `compact_boundary`, or the derived subagent
transcript path. Discussion #474 therefore retracted transcript parsing as a
supported clock/reset contract.

Claude provides documented lifecycle events for the behavior this feature
actually needs:

- `SessionStart` with `source: compact` runs after compaction.
- `SessionStart` with `source: clear` runs after `/clear`.
- `PreCompact` runs before compaction and therefore cannot prove that a reset
  completed.

The existing Claude template already registers `SessionStart` for `startup`,
`clear`, and `compact`.

## Requirements

### R1. No transcript-content dependency

- Spec injection must not open, scan, or parse a Claude transcript.
- Spec injection must not derive a subagent transcript path from Claude's
  internal directory layout.
- The documented `transcript_path` string may remain an identity fallback when
  no session identifier is available; its contents must never be read.

### R2. Event-driven context reset

- The existing spec-injection hook must also handle `SessionStart` events with
  `source: compact` and `source: clear`.
- Those events record a reset marker and produce no stdout.
- `startup`, `resume`, and unrelated events must not record a reset.
- The next matching spec touch after a new reset marker must emit the full spec
  even when its content hash is unchanged.

### R3. Preserve parent/subagent correctness

- Parent and subagent emission histories remain separate because they do not
  share context.
- A reset marker is scoped to the base session identity and is visible to both
  parent and subagent emission histories.
- Missing identity remains stateless ticket-only behavior.

### R4. Wall-clock refresh only

- The periodic refresh window uses `refresh_window_seconds`.
- Remove `refresh_window_turns` and every turn/boundary counter from config,
  state records, decision APIs, tests, and current spec documentation.
- `refresh_window_seconds: 0` keeps its current meaning: never refresh
  unchanged content solely because time passed.

### R5. State compatibility and failure behavior

- Existing version-2 emission records remain readable.
- A reset marker carries an opaque unique identifier. Emission records store
  the latest marker identifier they observed.
- A legacy emission record without a marker becomes stale after the first
  later reset event.
- State read/write failures remain non-fatal. If reset state cannot be read
  during an injection event, use the existing stateless ticket-only circuit
  breaker instead of trusting stale emission state.
- Hook processes always exit successfully; warnings use stderr only.

### R6. Distribution and documentation

- Update both shipped templates and their live dogfood mirrors.
- Register the existing `inject-spec-context.py` command after the existing
  `session-start.py` command for `SessionStart(clear)` and
  `SessionStart(compact)` only.
- Update tests to exercise event-driven reset behavior rather than internal
  transcript fixtures.
- Update the current CLI spec and config comments to describe the event-driven
  contract.

## Acceptance Criteria

- [x] No production spec-injection code opens or parses transcript contents,
      references `compact_boundary`, or derives
      `<parent>/subagents/agent-<id>.jsonl`.
- [x] A first matching touch emits FULL; a second unchanged touch inside the
      wall-clock window is silent.
- [x] One `SessionStart(source=compact)` event causes the next unchanged
      matching touch to emit FULL, then normal dedup resumes.
- [x] `SessionStart(source=clear)` has the same reset behavior.
- [x] `SessionStart(source=startup)` and unrelated hook events do not create a
      reset marker.
- [x] Reset events emit no stdout and exit zero.
- [x] A base-session reset invalidates both parent and existing subagent
      emission histories without merging those histories.
- [x] A pre-change version-2 emission record without a reset identifier remains
      readable and is invalidated by a later reset.
- [x] Unwritable or unreadable reset state never blocks Claude and never makes
      the hook trust stale state.
- [x] Mirrored Python files are byte-identical; settings are identical after
      substituting the Python command placeholder; template/live config
      sections carry the same spec-injection behavior while preserving the
      live project's package-specific settings.
- [x] Claude template tests assert one hook for `startup` and two hooks, in the
      expected order, for `clear` and `compact`.
- [x] Focused spec-injection tests, CLI tests, Python lint, TypeScript lint, and
      type checking pass.

## Out of Scope

- Registering both `PostCompact` and `SessionStart(source=compact)` for the same
  reset.
- `PreCompact` reset recording.
- A provider-neutral compaction event abstraction.
- Token-count refresh when a provider does not expose documented token counts
  to the hook.
- Exact deduplication of duplicate lifecycle deliveries; duplicate reset
  delivery may cause an extra safe-side FULL reinjection.
- Rewriting historical task documents that describe the superseded experiment.

## Constraints

- Python 3.9 compatible and standard-library only.
- Preserve the existing 10,000-character platform ceiling and payload formats.
- Preserve non-blocking hook behavior and the existing state garbage collector.
