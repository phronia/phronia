# PRD: Unify task.json schema across all writers

## Problem

Three different code paths write `task.json` in 0.5, each with its own field set:

| Writer | Location | Schema |
|---|---|---|
| Normal user task | `.trellis/scripts/common/task_store.py:147-172` (`cmd_create`) | 24 fields — the canonical shape (id / name / title / description / status / dev_type / scope / package / priority / creator / assignee / createdAt / completedAt / branch / base_branch / worktree_path / commit / pr_url / subtasks / children / parent / relatedFiles / notes / meta) |
| Bootstrap task | `packages/cli/src/commands/init.ts:258-339` (`getBootstrapTaskJson` + interface `TaskJson`) | 17 fields — no `title` / `scope` / `package` / `branch` / `base_branch` / `worktree_path` / `pr_url`; `status` init to `in_progress` |
| Migration task (breaking update) | `packages/cli/src/commands/update.ts:2009-2036` | 19 fields — no `id` / `name` / `package`; includes legacy `current_phase` (int) + `next_action` (array of `{phase, action}`) that nothing reads in 0.5 |

This divergence causes real problems:

1. **Docs are hard to write**: `appendix-c` / `ch06 §6.3` have to disclaim variant schemas or users hit surprises inspecting real task.json files.
2. **Downstream readers break on missing fields**: any hook / integration / `get_context.py` path that expects a canonical 24-field shape has to defensively handle missing keys per task type.
3. **Dead legacy fields leak into prod**: `current_phase` / `next_action` in migration tasks reference the removed Multi-Agent Pipeline. `phase.py` (the reader) is orphan code — no active script imports it. So those fields are pure noise, but `update.ts` keeps writing them.
4. **Same concept, three implementations**: `TaskJson` interface in `init.ts` duplicates what `task_store.py` already defines; `update.ts` inlines a third literal. Any schema evolution (e.g. adding a new field) requires updating three places.

## Goal

Single source of truth for `task.json` shape. All three writers (normal create / bootstrap / migration) produce the same 24-field canonical schema. Bootstrap and migration keep their special field VALUES (e.g. `status: "in_progress"`, `scope: "migration"`) but share the structural layout.

## Proposed approach

1. **Pick the canonical shape**: `task_store.py cmd_create`'s 24-field output. Field names, field order, null defaults.
2. **Drop dead fields**: remove `current_phase` and `next_action` from `update.ts`. No reader uses them in 0.5. If migration tasks need a checklist representation, use `subtasks: [{name, status}, ...]` (which matches the bootstrap task's existing usage).
3. **Factor into a shared TypeScript helper**: introduce `packages/cli/src/utils/task-json.ts` (or similar) exporting:
   - `TaskJson` type (mirror of the Python schema)
   - `emptyTaskJson(overrides)` helper producing a fully-populated, canonical-shape object with all 24 keys and documented defaults
   - Replace both `getBootstrapTaskJson` and the `update.ts` inline literal with calls to `emptyTaskJson({...})`.
4. **Keep the Python create canonical on runtime side**. Optional: extract the field list into `common/task_store.py` module-level constant `EMPTY_TASK_JSON_DEFAULTS` so a future `cmd_repair` could top up missing keys.
5. **Remove `.trellis/scripts/common/phase.py`** at the same time — orphan code, no importers.

## Out of scope

- Auto-migrating existing tasks in users' repos to add missing keys. `task.py` already treats missing fields as null, so no user breaks; a future `trellis update` migration entry can normalize if desired.
- Changing the runtime Python writer (`task_store.py`) — it's already canonical.

## Acceptance criteria

- [ ] `packages/cli/src/utils/task-json.ts` (or equivalent) exports a single `TaskJson` type + `emptyTaskJson` factory.
- [ ] `init.ts getBootstrapTaskJson` uses the factory; output has all 24 canonical fields.
- [ ] `update.ts` migration task block uses the factory; output has all 24 canonical fields; `current_phase` / `next_action` removed.
- [ ] `.trellis/scripts/common/phase.py` deleted (and removed from `trellis/index.ts` enumerator).
- [ ] `trellis init` on a fresh project still produces a working bootstrap task end-to-end.
- [ ] `trellis update --migrate` across a breaking boundary still produces a working migration task end-to-end.
- [ ] `docs-site/.../appendix-c.mdx` + `ch06-task-management.mdx` can be simplified (no "variant schemas" disclaimer needed).

## Notes

- This is a pure code-cleanup task, not a schema evolution. End-user tasks created by `task.py create` already look canonical — only bootstrap / migration tasks are structurally divergent today.
- Caught during docs audit of 0.5.0-beta.8 (`docs-site-version-audit` task, 2026-04-21).
