# User-visible behaviour changes

Every batch that changes what a user sees (injected text, command availability,
default paths, hook behaviour) appends an entry here. The goal is that a
release note can be assembled from this file without reading commit history.

## Format

```markdown
## <version or batch>

- [platform] <behaviour> changed from A to B.
  - Why:
  - Migration:
  - Escape hatch:
```

## Unreleased (B1 — Phronia identity)

- **All platforms**: the CLI is `phronia`; `trellis` and `tl` remain aliases for
  one major version and print a deprecation notice.
- **All platforms**: the workflow directory is `.phronia/`. Upstream projects
  must run `phronia adopt` once; user specs/tasks/journals are preserved, and
  generated files are regenerated. `adopt-report.md` lists everything kept,
  regenerated, or needing review.
- **All platforms**: environment variables are `PHRONIA_*`; `TRELLIS_*` values
  are mapped automatically for one major version.
- **All platforms**: skills are `phronia-*`, sub-agents are `phronia-implement`
  / `phronia-check` / `phronia-research`, and slash commands live under
  `commands/phronia/`. Legacy `trellis-*` agent names are still recognized.
- **All platforms**: managed AGENTS.md/Copilot markers are
  `PHRONIA:START/END`; legacy markers are migrated in place on update.
- **Pi / OMP**: the project extension moved from `extensions/trellis/` to
  `extensions/phronia/`.
- **OpenCode**: persisted context metadata is written under `phronia`; old
  `trellis` metadata is still read.
- **Update hint**: probes `phronia --version` and the notice says "Phronia".

Batches that must update this file:

- **B3**: Kiro sub-agent output (JSON → plain text); Codex/Copilot gain
  first-reply notice and update hint; stale-pointer wording unified; JS hosts
  regain `task_error` / `Present:` / JSONL warnings.
  - **OMP**: session start now injects the core session plan; the per-turn
    message carries the core `<workflow-state>` breadcrumb instead of OMP's
    nested `[workflow-state:*]` block plus `<session-overview>`. Task context
    uses the core materializer, so files appear as `=== path ===` blocks.
  - **Snow**: the hook is a thin adapter over `phronia context`. Session/user
    inject and `.snow/log/phronia-context.txt` now contain the core session
    plan and breadcrumb; Snow's own role-specific sub-agent checklists are
    gone, and sub-agent material comes from the core JSONL/artifact pipeline.
  - **Pi**: the sub-agent prompt is the core role prompt prefixed with the
    `.pi/agents/<name>.md` definition (Pi has no `--agent` flag); per-turn
    runtime context carries only the core breadcrumb, while the startup
    snapshot stays in `systemPrompt`.
  - **OpenCode**: the session-start plugin now injects context, so the
    generated `.opencode/commands/phronia/start.md` fallback is no longer
    written; existing copies are harmless and can be deleted. Sub-agent
    prompts come from the core role templates; the research prompt no longer
    carries the `<!-- phronia-hook-injected -->` marker (Python never emitted
    it for research).
  - Why: one assembly implementation; OMP/Pi/Snow had three drifting copies.
  - Migration: no action for users; custom text that matched Snow's
    `Sub-agent checklist (...)` headings must read the task artifacts instead.
- **B5/B6**: unknown harness versions may switch to `degraded` fallback;
  shim files become managed artifacts and are no longer overwritten silently.
  - **B6 now**: shim sources carry a `phronia-shim: <adapter>` /
    `shim-version` stamp; `pnpm check:shims` enforces per-file line ceilings
    and rejects shared-assembly markers. `@phronia/testing` gained contract
    fixture replay: a recorded payload plus minimal project is replayed
    through `phronia context`, and payload/envelope key drift fails the test.
    The interactive "keep my modified shim + write .new" update flow is not
    part of this change yet; shims are still handled as managed templates.
  - **B5 now**: `phronia doctor` reports the selected adapter, harness version
    and source, status, and last handshake per platform; `--json`,
    `--no-probe`, `--refresh-manifest`, and `--check` are available.
    `phronia platforms --detect` probes configured platforms and writes
    `.phronia/manifest.json` (gitignored, machine-local). Every `phronia
    context` call records a per-platform handshake under
    `.phronia/.runtime/harness/`, storing payload key names only — a plugin
    that loads but never runs now shows `last handshake never` instead of
    silently doing nothing. OpenCode 2.x selects an unimplemented `@v2`
    shard and reports `unsupported` rather than reusing the v1 plugin.
- **B7**: ZCode may select `bridge` or `prelude` instead of project hooks; the
  doctor reports the reason.
  - **B7 now**: `phronia zcode detect` reports the selected path, build class,
    trust state, and reason. Pin the path with `platforms.zcode.path:
    project-hooks|bridge|prelude` in `config.yaml` or `PHRONIA_ZCODE_PATH`.
    A build in the 3.7.x range is treated as hooks-disabled: the bridge is
    used when `PHRONIA_ZCODE_BRIDGE` points at one, otherwise pull-based
    skills. Unknown builds keep project hooks but stay `trust: unknown` until
    a handshake proves they run. A self-owned ≤30-line bridge is generated at
    `.zcode/bridge/phronia-zcode-bridge.mjs`; point the global ZCode plugin
    at it when project hooks are unavailable. The bridge refuses to run when
    ZCode does not supply a project root instead of searching the cwd.
- **B8**: the memory floor is now the first recall source.
  - `phronia mem floor [query]` searches session journals, task summaries,
    and spec sections written under `.phronia/`. It works with no harness
    database at all; `--kind` and `--cwd` filter it.
  - `phronia mem doctor` lists every source path, readability, and SQLite
    schema (table names).
  - `phronia mem search --scope enhancers|floor|all` selects the partition;
    the default remains `enhancers` for one version. JSON output for
    `mem list`, `mem search`, and `mem projects` is now an object carrying
    `warnings` instead of a bare array.
  - One failing session adapter is isolated: other sources still return and
    the failure appears as a `mem.<platform>.<op>_failed` warning.
  - ZCode schema mismatch is now `zcode-db-schema-unsupported`, distinct
    from an unreadable database. `--limit` rejects values below 1, `-h`
    works, and `--until` keeps an explicit time instead of forcing end-of-day.
- **B9**: spec rules become a ledger.
  - `rules.md` files under `.phronia/spec/**` can declare a table between
    `<!-- phronia:rules:start -->` and `<!-- phronia:rules:end -->` with
    `ID | Rule | Scope | Severity | Check | Fix | Status | Rationale`.
    `phronia rules compile` writes `.phronia/.runtime/rules.json`;
    `phronia rules list` filters by severity/status.
  - Edit/Write tool calls receive only the verified rules whose scope
    matches the target path (`<rules-for-path>`), capped at 8. Draft and
    deprecated rules are reported but never injected or enforced.
  - check output is still prose; the machine-readable verdict file is not
    part of this change yet.
- **B10**: hooks stop invoking Python; a platform package is used when
  available.
- **B11**: task worktrees and session GC.
  - `phronia task worktree add|list|remove <task-ref>` creates a per-task
    git worktree under `.phronia/worktrees/<task-id>` (gitignored), records
    `worktree_path`/`branch` in `task.json`, and keeps a
    `.phronia/.runtime/worktrees.json` registry. Dirty checkouts require
    `--force`; missing tasks are refused.
  - `phronia session gc [--ttl-days N] [--dry-run]` removes stale taskless
    session pointers. Session files are read from the v2
    `sessions/<worktreeId>/` namespace first, then the legacy flat path.
  - Session writes now use an exclusive lock and a revision CAS; a lost
    update retries instead of silently overwriting another window.
- **B12**: spec status and the visible knowledge layer.
  - Spec files may carry `phronia.status: draft|verified|deprecated`; files
    without frontmatter stay `verified`. `phronia spec status|verify|
    deprecate` manages the states, and `phronia spec bootstrap` reports
    missing `index.md` files and can create draft skeletons.
  - `phronia docs generate` writes `docs/requirements.md` as a deterministic
    projection of active and archived tasks (`--check` fails when stale).
  - `phronia onboard [--write]` prints or writes a contributor brief; it does
    not create `00-bootstrap-guidelines` or `00-join-*` tasks.
  - Narrative `docs/architecture.md` and `docs/product.md` remain optional
    and manually curated.
