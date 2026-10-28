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

- **All platforms**: the CLI is `phronia`. The published package no longer
  claims the `trellis`/`tl` bin names, so it can be installed alongside an
  existing `@mindfoldhq/trellis`; **users do not need to uninstall Trellis**.
  `trellis` keeps pointing at the old CLI until the user removes it. A manual
  `bin/trellis.js` entry point remains for an explicit symlink and prints the
  legacy notice.
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
    OpenCode plugins are now build-time single-file artifacts under
    `templates/_generated/shims/opencode/` with adapter, shim version,
    source-based build id, and content hash in the header; a manifest records
    every artifact. `pnpm build:shims` regenerates them and `check:shims`
    fails on drift. A locally modified shim is never overwritten: `update` writes
    `<path>.new`, keeps the installed file, and prints the adopt/reset
    commands. `--force` remains the explicit overwrite path.
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
- **B7**: ZCode now uses a project-local plugin instead of workspace hooks.
  - `phronia init` / `update` install `.zcode/plugins/phronia/` and register it
    through `.zcode/config.json` `plugins.dirs`. The plugin uses
    `type: "process"` hooks and `${ZCODE_PLUGIN_ROOT}`, so the tool cwd cannot
    move the script path. Hooks call `phronia hook --platform zcode --event …`,
    which resolves the nearest `.phronia/` root and delegates to the Python
    shim.
  - `phronia doctor` checks and repairs the plugin by default; `--no-fix` is
    read-only. `phronia zcode detect` reports `plugin` as the selected path.
  - The old `project-hooks` / `bridge` / `prelude` selection remains as a
    fallback. Pin it with `platforms.zcode.path:
    plugin|project-hooks|bridge|prelude` in `config.yaml` or
    `PHRONIA_ZCODE_PATH`. A build in the 3.7.x range is still treated as
    hooks-disabled; the legacy bridge/prelude fallback applies only when the
    project plugin is unavailable.
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
  - check output is still prose, but `phronia rules verdict --task <ref>
    --input <file|->` validates per-rule verdicts and writes
    `.phronia/tasks/<ref>/check-results.json` with `pass|fail|partial` and
    a `missing` list for verified rules that were not evaluated.
  - Fifth-level gate: `phronia rules compile` also writes `.phronia/gate.yaml`;
    `phronia rules gate --changed` blocks protected paths, `--task` blocks
    missing high/critical verdicts and coverage below 100%, and
    `rules verdict --check` applies the same gate. `phronia doctor` reports
    gate status for `loopControl: full` platforms (dsh).
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
  - `phronia task cross-repo attach <task> <repo=path|remote>...` stores
    touches/consumes under `task.json.meta.crossRepo`; `task cross-repo
    status` reads `phronia/<task-id>:task.yaml` from each repo, reports
    `unresolvable` instead of guessing, and flags consumed ref drift.
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
    and manually curated. `finish-work` now runs `phronia docs generate`
    after archiving and prompts for narrative updates; `check` now requires
    `phronia rules verdict` output for evaluated verified rules.
- **B13**: parallel tasks, shared worktree lifecycle, and coordinator mode.
  - **New commands**
    - `phronia task parallel plan [refs...] [--include-planning] [--max N] [--allow-unknown] [--explain] [--json]`
    - `phronia task parallel status [--platform <id>] [--json]`
    - `phronia task parallel dispatch --batch <id> [--wave N] [--max N] [--dry-run] [--platform <id>] [--session-key <key>] [--owner-id <id>] [--json]`
    - `phronia task workspace prepare [--for-new-task <title>] [--force] [--reuse-dirty] [--session-key <key>] [--json]`
      and `workspace ensure <ref>` / `bind <ref>` / `release` / `reclaim` (same workspace flags; `reclaim` adds `--ttl <seconds>`)
    - `phronia task lease acquire|release|status <ref>` (`acquire` accepts `--owner-type session|subagent|task`, `--owner-id`, `--session-key`, `--workspace`, `--ttl`)
    - `phronia task worktree attach <ref> [--path <dir>]`, plus `worktree add|list|remove|prune` (existing primitives)
    - `phronia task integrate <ref> [--mode auto|local|remote] [--base <branch>] [--queue|--wait|--drain] [--verify <cmd>|--no-verify] [--timeout <d>] [--interactive|--yes] [--handoff] [--dry-run] [--recover] [--rollback] [--force] [--sync] [--json]`
    - `phronia task commit <ref> [-m <message>] [--json]`
    - `phronia task coordinator status [--batch <id>] [--platform <id>] [--json]`
  - **Worktree registry moved to the shared runtime.** Runtime mappings are
    written only to `<git-common-dir>/phronia/worktrees.json`, which every
    linked worktree of the same repository resolves. The legacy
    `.phronia/.runtime/worktrees.json` registry and
    `task.json.worktree_path` / `branch` are read as fallbacks but are no
    longer written. The repository stays clean after a worktree is created,
    and machine paths no longer enter task history.
  - **`task worktree add` default base changed** from `HEAD` to the resolved
    integration branch (`--base` → task `base_branch` → `origin/HEAD` → current
    branch). `--base HEAD` restores the old behavior.
  - **Claims and leases are TTL-only.** `sessionKey` + heartbeat decide
    staleness; `pid` is diagnostic only (each CLI invocation is a new
    process). Only the integration lock may opt into `ttl-or-pid`.
  - **Three distinct mutexes**: task lease (`leases/<hash>.json`), workspace
    claim (`workspace.claim.json`), integration lock (`integration.lock`).
    Acquisition order is fixed: task lease → workspace claim → integration
    lock. The locks coordinate worktrees of one repository (one object
    database); they are not cross-machine locks. Multi-person projects should
    use remote mode and the forge's merge queue.
  - **`integrate` is not `archive`.** Integrate lands the task and writes
    `meta.integration.outcome` (`none|landed|pushed|blocked|needs_human`).
    Local mode may add a metadata-only commit (`chore(task): record integration
    state`) after landing; the verified code commit stays the task branch head.
    Archive remains a separate step in `finish-work`.
  - **Archive lifecycle guard.** Archiving a task with a worktree now:
    - refuses when `git status --porcelain` in that worktree is non-empty
      (next: `phronia task commit <ref>`, or `phronia task worktree remove
      <ref> --force` to discard);
    - removes the worktree and keeps the branch when it is clean and
      `meta.integration.outcome == "landed"`;
    - refuses when it is clean but not landed (next: `phronia task integrate
      <ref>`, or `phronia task worktree remove <ref>` to keep the branch and
      drop the workspace);
    - refuses if `git worktree remove` fails, printing the git error.
    Tasks without a worktree keep the previous archive behavior.
  - **`parallel.enabled: false`** disables the planner and automatic workspace
    creation only. `worktree add/attach`, `workspace ensure`, and `integrate`
    remain general primitives.
  - **Coordinator capability matrix** (`phronia task parallel status --json`
    or `coordinator status --json` reports the gate):
    | Harness | Mode |
    |---|---|
    | Claude Code | coordinator candidate (parallel/nested sub-agents + per-task `cwd`); live dogfood pending |
    | Codex | multi-session (`codex exec -C <worktree>`); sub-agents inherit cwd |
    | ZCode | multi-session (one window/worktree per task) or serial; sub-agents inherit cwd |
    | Unverified platforms | unsupported until Phase 0 evidence exists (`coordinator.mode` fails closed) |
    | No sub-agent surface | unsupported; use the planner plus manual sessions, or serial |
  - Why: several independent tasks could only be executed one checkout at a
    time; worktree mappings were machine-local and made the main checkout
    dirty; and archive could silently leave a worktree behind.
  - Migration: none required for existing tasks. Old registry entries are
    merged into the shared location on first use; `task.json` gains only
    optional `meta.parallel` / `meta.integration` data. Create worktrees from
    the main checkout so the task artifacts are visible inside them.
  - Escape hatch: `parallel.enabled: false`; `--mode local|remote` to override
    mode detection; `--no-verify` when no verification command exists (the
    result is reported as unverified); `phronia task worktree remove` for an
    explicit cleanup that archive would otherwise refuse.
