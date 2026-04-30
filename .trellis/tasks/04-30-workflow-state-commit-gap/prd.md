# fix(hook): in_progress flow indication missing commit step

## Goal

The `[workflow-state:in_progress]` breadcrumb in `workflow.md` (and its Python/JS hook fallbacks) lists the flow as `implement → check → update-spec → finish`, omitting the **commit (Phase 3.4)** step that must run before `/trellis:finish-work`. As a result, an AI agent that finishes implementation can read the breadcrumb, see "finish" at the end, and propose `/trellis:finish-work` without driving the commit — which then bails on a dirty working tree, wasting a turn and creating awkward back-and-forth.

Discovered while running task `04-30-init-yes-bootstrap-204`: the AI (me) skipped Phase 3.4, suggested finish-work, the skill bailed, the user pointed out the workflow gap.

## What I already know

- The breadcrumb has **two sources** in priority order (`inject-workflow-state.py:204-227 load_breadcrumbs`):
  1. `.trellis/workflow.md` `[workflow-state:STATUS]` ... `[/workflow-state:STATUS]` blocks (live, user-editable, source of truth)
  2. Python `_FALLBACK_BREADCRUMBS` dict — only used when workflow.md is missing/malformed/lacks the tag
- Three files carry the same `in_progress` text and must stay in sync:
  - `packages/cli/src/templates/trellis/workflow.md:528-534` (live tag, what's read at runtime)
  - `packages/cli/src/templates/shared-hooks/inject-workflow-state.py:175-192` (Python fallback)
  - `packages/cli/src/templates/opencode/plugins/inject-workflow-state.js:67` (opencode JS port)
- The `[workflow-state:completed]` block (`workflow.md:536-540`) already mentions commit + dirty-tree refusal, but **nothing transitions task status to `completed`** — `task.py finish` only clears the active task pointer; status stays `in_progress` until `task.py archive` removes the task entirely. So the `completed` breadcrumb is effectively dead text and cannot be relied on as a safety net.
- This is a template fix → has to flow through `trellis update` migration channel to land on user projects.

## Requirements

- Update the `in_progress` breadcrumb in all three locations to:
  1. List `commit (Phase 3.4)` between `update-spec` and `finish` in the Flow line.
  2. Add an explicit instruction: after `trellis-update-spec` (or whenever implementation is verifiably done), the main session **drives the commit** — states the commit plan, then runs `git commit` — BEFORE suggesting `/trellis:finish-work`. Mention that `/finish-work` refuses to run on a dirty working tree.
- Keep all three text sources byte-identical except for whatever language-specific quoting the file format requires (Python triple-quote, JS string concat, MDX-friendly markdown).
- Add a regression test that asserts the three sources produce the same breadcrumb body for `in_progress` (or at minimum that they all contain the substring `commit` in the flow line).
- Migration manifest entry for `trellis update` so existing user projects pick up the new `workflow.md` block.

## Acceptance Criteria

- [ ] Reading `inject-workflow-state.py` `_FALLBACK_BREADCRUMBS["in_progress"]` shows the new commit step + driver instruction.
- [ ] Reading `inject-workflow-state.js` `in_progress` breadcrumb shows the same.
- [ ] `workflow.md` `[workflow-state:in_progress]` block matches.
- [ ] Existing test `test/regression.test.ts` (or similar) asserts the three sources stay in sync — running the test on the prior text fails, on the fixed text passes.
- [ ] `trellis update --migrate` (or whichever migration verb) on a fixture project that has the old `workflow.md` block correctly replaces the `in_progress` block (markers preserved) and leaves user-customized content elsewhere intact.
- [ ] `pnpm test`, `pnpm lint`, `pnpm typecheck` all green.

## Definition of Done

- [ ] All three template files updated, byte-identical body.
- [ ] Regression test added for source-of-truth consistency.
- [ ] Migration manifest entry created (template-managed-block update for `workflow.md`).
- [ ] Manual dogfood: run `trellis update` on this repo (Trellis itself), verify the live `.trellis/workflow.md` picks up the new block.
- [ ] Changelog entry — deferred to next `/trellis:create-manifest` run.

## Technical Approach

Plain text edit across three files. Proposed new `in_progress` body:

```
Flow: trellis-implement → trellis-check → trellis-update-spec → commit (Phase 3.4) → finish
Next required action: inspect conversation history + git status, then execute the next uncompleted step in that sequence.
For agent-capable platforms, the default is to dispatch `trellis-implement` for implementation and `trellis-check` before reporting completion — do not edit code in the main session by default.
After trellis-update-spec (or whenever implementation is verifiably complete), the main session DRIVES the commit — state the commit plan, then run git commit — BEFORE suggesting `/trellis:finish-work`. `/finish-work` refuses to run on a dirty working tree (paths outside `.trellis/workspace/` and `.trellis/tasks/`).
Use the exact Trellis agent type names when spawning sub-agents: `trellis-implement`, `trellis-check`, or `trellis-research`. Generic/default/generalPurpose sub-agents do not receive `implement.jsonl` / `check.jsonl` injection.
User override (per-turn escape hatch): if the user's CURRENT message explicitly tells the main session to handle it directly ("你直接改" / "别派 sub-agent" / "main session 写就行" / "do it inline" / "不用 sub-agent"), honor it for this turn and edit code directly. Per-turn only; does not carry forward; do NOT invent an override the user did not say.
```

Migration: this is a `replace-managed-block` operation on `.trellis/workflow.md` keyed by the `[workflow-state:in_progress]` / `[/workflow-state:in_progress]` markers. Existing migration infrastructure (the same kind that handles `AGENTS.md` TRELLIS-marker block replacement) should be reusable — verify by reading `packages/cli/src/migrations/manifests/`.

## Decision (ADR-lite)

**Context**: The `completed` breadcrumb already covers commit + dirty-tree refusal, but no transition fires it. Two paths to close the gap: (a) add commit guidance directly to `in_progress`, or (b) introduce a real `in_progress → completed` status transition triggered by some new command.

**Decision**: Option (a). Cheaper, no schema/CLI changes, addresses 100% of the observed failure mode (AI reads `in_progress` breadcrumb, jumps to finish-work). Option (b) is a larger workflow redesign and out of scope.

**Consequences**:
- Pro: Single-turn fix scoped to template text + migration. No risk of breaking existing task scripts.
- Con: The `completed` breadcrumb stays dead text. Acceptable; can be cleaned up in a future task or repurposed for a real transition later. (Captured as Out of Scope below.)

## Out of Scope

- Adding an actual `in_progress → completed` status transition (needs `task.py` redesign, schema bump, slash-command rewiring). Track separately if pursued.
- Repurposing or removing the `completed` breadcrumb block. Leave as-is — harmless dead branch until a real transition exists.
- Updating the `planning` or `no_task` breadcrumbs. Out of scope for this fix.
- Fixing the AI behavior pattern itself (e.g., training feedback memory). The hook text is the leverage point; AI training is downstream.

## Technical Notes

- Source-of-truth ordering: workflow.md tag block > Python fallback > JS fallback. All three should match.
- `inject-workflow-state.py:204-227 load_breadcrumbs()` parses `_TAG_RE` blocks from workflow.md and overrides the fallback dict — so workflow.md is what users actually see; the Python/JS fallbacks are belt-and-suspenders.
- `task.py finish` (`/trellis:finish-work` Step 4 invokes `add_session.py`, archive happens in Step 3 via `task.py archive`). No status transition involved.
- Discovered during `04-30-init-yes-bootstrap-204` Phase 3.4 step (the AI suggesting `/finish-work` before committing).
- Issue link: N/A — internal workflow improvement, no GitHub issue.
