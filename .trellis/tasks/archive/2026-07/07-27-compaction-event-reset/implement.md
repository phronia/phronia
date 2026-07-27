# Implementation Plan: Event-driven spec-injection reset

## 1. Confirm change surface

- Run the available code-intelligence impact check for every modified symbol.
  If the repository graph remains unavailable, record that fact and manually
  audit all callers with `rg`.
- Freeze focused pre-change tests for the current decision engine, hook state
  path, Claude settings, and config parser.

## 2. Replace transcript clock in the pure decision engine

- Remove transcript parsing, beat selection, boundary logic, and their imports
  from the template and live `common/spec_inject.py`.
- Change `within_window` to compare wall-clock seconds only.
- Add current reset identifier comparison to `decide`.
- Store the current reset identifier in new emission records.
- Remove turn-window arguments from `assemble_payload` and its callers.

Check: focused pure decision tests cover first sight, unchanged inside/outside
the time window, hash change, incomplete FULL, stateless mode, and reset
mismatch.

## 3. Add lifecycle-event reset recording to the hook

- Resolve base-session identity separately, then append the existing agent
  suffix only for emission history.
- Extend state loading to return the latest reset identifier.
- Add the `SessionStart(clear|compact)` dispatch before tool-field validation.
- Append a UUID reset record to the base session shard with existing open,
  lock, append, and failure helpers.
- Make parent and subagent tool events read the base reset identifier; keep
  their emission histories separate.
- Remove `clock_transcript_path`, transcript-derived subagent layout handling,
  and unused constants/imports.

Check: fabricated hook stdin verifies no reset stdout, reset persistence,
parent/subagent invalidation, legacy state compatibility, and fail-soft state
errors.

## 4. Wire templates and configuration

- Add the existing spec-injection command after `session-start.py` under
  Claude `clear` and `compact`; leave `startup` unchanged.
- Remove `refresh_window_turns` from template/live config and hook config
  parsing.
- Keep template/live mirrors byte-identical.

Check: template tests assert the exact hook counts, commands, matchers, and
order.

## 5. Replace transcript-contract tests and documentation

- Delete transcript scanner, compact-boundary fixture, turn-count, hostile
  transcript, and derived subagent transcript tests.
- Add event-driven reset integration cases matching every PRD acceptance
  criterion.
- Update `.trellis/spec/cli/backend/spec-injection.md` and its code map/state
  contract to the lifecycle-event model.
- Preserve the previous task documents as historical records.

Check: one focused regression test must fail if reset-marker comparison is
removed.

## 6. Verify and deliver

- `python3 -m py_compile` for changed Python files.
- Focused spec-injection and Claude template tests.
- `pnpm lint:py` in `packages/cli`.
- Repository TypeScript lint and type check.
- Full CLI, core, and repository test gates used by PR #468.
- Compare every changed template/live mirror.
- Run `detect_changes` against `feat/v0.7-beta` if GitNexus becomes available;
  otherwise review `git diff --stat`, `git diff --check`, and all changed
  callers manually.
- Commit in English and push to `feat/spec-on-demand-injection`.

## Rollback

One revert restores the transcript-clock implementation and removes the two
additional lifecycle-hook commands. State reset lines are ignored by the old
loader because they have no `spec`, so rollback requires no state migration.
