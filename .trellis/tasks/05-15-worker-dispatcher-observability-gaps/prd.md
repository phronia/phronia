# Discuss worker dispatcher observability gaps

## Goal

Clarify and prioritize the `trellis-issue` thread
`worker-dispatcher-observability-gaps` into an implementable Trellis channel
runtime plan.

The thread reports four gaps surfaced by Vine while wiring a daemon dispatcher
to Trellis channel worker execution:

1. Worker inbox push API / in-process delivery surface.
2. `trellis channel wait --kind` only accepts one kind; dispatcher wants
   `done` or `killed` / warning-style union waits.
3. Supervisor has no pre-kill warning event before lifetime timeout.
4. Historical channel `type:"thread"` / `type:"threads"` logs do not have a
   CLI migration or projection compatibility story after the user-facing type
   became `forum`.

## Requirements

- Inspect current `@mindfoldhq/trellis-core` and CLI channel implementation
  before proposing changes.
- Separate what is already solved in `0.6.0-beta.15` from what is still open.
- Keep Vine/product identity and subscription semantics out of Trellis core;
  Trellis should expose channel substrate primitives only.
- Define API/CLI shape for each accepted gap:
  - core function signatures or event schema,
  - CLI flags if applicable,
  - reducer/projection behavior,
  - compatibility behavior for old event logs.
- Decide priority and release scope:
  - small CLI/runtime fixes suitable for `0.6.x` / `0.7.x` patch,
  - larger core API work that needs design before implementation.
- Record explicit rejected alternatives to avoid re-opening settled questions.

## Acceptance Criteria

- [ ] PRD records confirmed current behavior from code/help output.
- [ ] Design separates at least three buckets:
  - immediate CLI improvements,
  - core substrate/API work,
  - release/migration compatibility work.
- [ ] `wait --kind` union behavior is specified with exact CLI syntax and
      matching semantics.
- [ ] Legacy `thread`/`threads` channel type compatibility is specified without
      raw-editing `events.jsonl`.
- [ ] Supervisor pre-kill warning event schema and timing policy are specified
      or explicitly deferred.
- [ ] Worker inbox push API is either specified or scoped into a follow-up
      core runtime task with clear blockers.
- [ ] Implementation plan includes tests for event projection, CLI behavior,
      and old-log compatibility.

## Notes

- Source issue:
  `trellis channel thread trellis-issue worker-dispatcher-observability-gaps --scope global`
- Related prior thread:
  `trellis channel thread trellis-issue vine-trellis-core-sdk-needs --scope global`
- Current quick verification:
  - `trellis channel wait --help` still shows single `--kind <kind>`.
  - `trellis channel post --help` already supports `--stdin` and
    `--text-file`.
  - Core/CLI code contains `undeliverable`, `delivery-mode`, inbox policy,
    `turn_started`, and `turn_finished`.
  - No current `supervisor_warning` event was found.
