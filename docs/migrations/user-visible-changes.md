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

## Unreleased (dispatch admission)

- **All platforms**: a `phronia-implement` / `phronia-check` dispatch is now
  evaluated before the sub-agent starts. A structurally invalid dispatch is
  denied with a stable `DISPATCH_*` code and an executable `next` list:
  parent task, task not `in_progress`, wrong/other-owner checkout, required
  isolation, or a main checkout claimed by another task.
  - **Platforms that can block** (Claude Code, ZCode, OpenCode): the tool call
    is denied and the parent model sees the reason as the tool error. Do not
    retry; follow the printed `next`.
  - **Platforms that can only inject** (Codex) or are unverified (Cursor):
    dispatch is not blocked; the sub-agent prompt starts with a
    `WORKSPACE_GUARD ... STOP:` block instead.
  - Why: the constraints were pull-based and could be bypassed by calling the
    harness's native sub-agent tool directly.
  - Migration: none. The common single-task path still allows dispatch.
  - Escape hatch: `parallel.dispatch.enforce: warn` (deny → guard) or `off`
    (no guard). `phronia doctor` shows the mode and whether the harness can
    block.
- **All platforms**: each prompt now carries a `<runtime-state>` block with
  `workspace / claim / lease / parallel` (and `next` for a parent task).
  Read failures render `unknown (read failed)` rather than disappearing.
- **`task.py start`**: a parent task (`children.length > 0`) is refused by
  default. The error lists the children with statuses and one executable
  `task.py start <child>` per child. `--coordinator` allows the parent to
  become the active task and skips the implement/check context-manifest gate.
  Starting a child is unchanged. Dispatch admission still rejects implement
  dispatches against a parent.
- **`task.py start` branch recording**: the checked-out integration/base
  branch (e.g. `main`) is no longer written to `task.json.branch`; only a real
  feature branch is recorded. Detached HEAD still records nothing.
  - Why: `workspace ensure` treated the recorded integration branch as a
    worktree branch and failed with `WORKSPACE_TARGET_EXISTS: branch main is
    already checked out`.
  - Migration: none. Tasks that already carry `branch: main` are handled by
    `ensure` as if the branch were empty.
- **`phronia task workspace ensure`**: a serial task on a clean, unclaimed main
  checkout now returns `reuse-current` and claims it. A worktree (on
  `phronia/<slug>`) is created only when isolation is required
  (`parallel.worktree=always`, `exclusive`, a parallel batch, or main claimed
  by another task).
- **Session identity**: `phronia task workspace ...` and
  `phronia task lease ...` resolve the session key from the same pre-shell
  ticket bridge as `task.py`. When no key resolves and this checkout has
  exactly one session file, the error prints that key and a copy-paste
  `--session-key` command; multiple sessions still degrade instead of guessing.
- **`phronia platforms --json`**: each configured platform now includes
  `hookPolicy` and `subagentWorkspace` (existing fields unchanged).

## Unreleased (spec control plane / dispatch UX / worktree operations)

- **Spec is now a control-plane projection.** A code task writes its intended
  spec change to `.phronia/tasks/<ref>/spec-delta.md` and must not commit
  `.phronia/spec/**` on its branch.
  - New: `phronia task spec plan|commit|status <ref...> [--json]` and
    `python3 ./.phronia/scripts/task.py spec-delta <ref>` (template helper).
  - `spec commit` runs in the main checkout, takes the integration lock, and
    commits only the spec tree as `chore(spec): sync <refs>` (followed by a
    metadata-only `chore(task): record spec sync for <refs>`). It records
    `meta.spec_sync = {status, commit, synced_at, refs, mode}`.
  - `integrate` now refuses `.phronia/spec/**` changes on a code task branch
    with `SPEC_IN_CODE_TASK`; move the intent to `spec-delta.md`. There is no
    `--allow-spec-in-code`.
  - `task.py archive` refuses a task whose `spec-delta.md` is not synced with
    `SPEC_SYNC_PENDING`; `--skip-spec-sync` is the explicit escape hatch and
    records the reason in `notes`.
  - Why: spec describes landed code, and writing it from several task
    branches produced conflicts on shared files and on the git index.
  - Migration: move in-flight spec edits out of the task branch into
    `spec-delta.md`. Already-landed work needs no retroactive sync.
  - Escape hatch: `--skip-spec-sync` after an explicit user decision.
- **The planner no longer serializes spec.** `.phronia/spec/**` is removed
  from `DEFAULT_ALWAYS_SERIAL`. A task that still lists it in
  `meta.parallel.touches` gets a `SPEC_IS_POST_INTEGRATION` warning; it does
  not force a serial wave. `meta.kind: spec` tasks are control-plane units
  (`PARALLEL_SPEC_ONLY`) and never enter a wave. `docs/requirements.md`,
  `.phronia/config.yaml`, `.phronia/workflow.md`, `.phronia/gate.yaml`, lock
  files, and migrations remain always-serial.
- **Archive branch resolution is wider and correct.** Archive resolves the
  task branch from `task.json.branch`, then the shared worktree registry, then
  `meta.integration.outcome=landed` plus a `meta.integration.commit` reachable
  from the base branch. The normal worktree path no longer needs
  `--skip-branch-validation`; an open PR (`pushed`) still does not qualify.
- **Dispatch `next` is executable.** `DISPATCH_WRONG_CHECKOUT` now starts with
  "open a new session/window in `<worktree>`" and gives
  `first line: Active task: <ref>`; `cd` appears only as a harness-dependent
  hint. `DISPATCH_TASK_NOT_CHILD` names the session's active task, the
  requested task, their relation, the requested worktree (or "run workspace
  ensure first"), and forbids mutating siblings from the same session.
  `DISPATCH_ISOLATION_REQUIRED` explicitly forbids concurrent mutating
  sub-agents in the main session (ZCode/Codex inherit the parent cwd). Codes
  and block semantics are unchanged.
- **New multi-session launch plan.**
  `phronia task parallel launch [refs...] --wave <n> [--prepare] [--platform <id>] [--json]`
  returns, per task, its workspace, branch, `Active task:` line, prepare/lease
  commands, platform open instructions, and missing build inputs. It never
  starts a process or a session; `--prepare` is the explicit switch that
  creates/attaches workspaces. Containers and spec-only tasks are reported as
  skipped.
- **Declarative worktree inputs.** `parallel.inputs` (`- path:` + `mode:
  symlink|copy`; a path→mode map and a bare path list are still accepted)
  materializes gitignored build inputs when a worktree is created or ensured.
  Paths must stay inside the repository; Windows symlink failures degrade to
  a copy. `worktree add`/`workspace ensure` print executable `next` steps for
  missing `parallel.inputs`, `node_modules`, and `rust/target`.
  `parallel.build.cargo_target_dir: shared` and `parallel.build.sccache: true`
  emit recommendations only; Phronia never installs or reconfigures a cache.
- **Ignored inputs are explicit.** `parallel.integration.ignored_inputs` is an
  allow-list for `integrate` and `spec sync` dirty checks. A configured path
  is ignored only when it is an in-repo symlink or git itself ignores it;
  everything else still blocks. A symlink to a gitignored directory is **not**
  matched by git's `/dir/` pattern, so the link path must be listed. There is
  no blanket `--allow-untracked`.
- **`worktree add` matches `ensure`.** Dirty main with only
  `.phronia/tasks/<ref>` returns `TASK_ARTIFACTS_UNCOMMITTED` with a scoped
  commit command and `--copy-task`; `worktree add` now supports `--copy-task`.
  Other dirty paths still refuse.
- **Cleanup reports freed space.** `worktree remove` / `worktree prune`
  best-effort print `freed ~<size>`; measurement failure never blocks.
- **YAML subset extension.** Flat mappings inside `- ` list items
  (`- path: x` / `  mode: symlink`) are parsed instead of being hoisted into
  the parent map. Nested lists inside a list-item mapping remain unsupported.
- **`phronia doctor`** reports `task.worktreeInputs`, `task.ignoredInputs`, and
  `parallel.build` hints (read-only).
- **Runtime-state block** gains a fifth line, `spec: none|pending|synced`,
  derived from `spec-delta.md` and `meta.spec_sync`.
- Why: parallel work exposed friction in spec ownership, archive metadata,
  dispatch wording, and manual worktree setup.
  - Migration: none required for existing tasks. Add `spec-delta.md` only when
    a task changes spec. `parallel.inputs` / `ignored_inputs` / `build` are
    optional; omitting them preserves the old behavior.
  - Escape hatch: `--skip-spec-sync`, `--skip-branch-validation` (unchanged),
    `parallel.enabled: false`, `parallel.dispatch.enforce: warn|off`.

## Unreleased (adopt managed-path kinds)

- **All platforms**: `phronia adopt` no longer aborts with `ENOTDIR` on
  projects that configure GitHub Copilot (`.github/copilot-instructions.md`) or
  Snow (`.snow/SNOW.md`). Managed roots are now typed: directories live in
  `extraManagedDirs`, individual files in `managedFiles`, and directory walkers
  only ever see `getManagedDirs()`.
  - Why: the registry listed those two files among the directories, so adopt
    called `readdir` on a file after regenerating it.
  - Migration: none; affected projects simply re-run `phronia adopt`.
  - Escape hatch: not needed.
- **All platforms**: adopt's legacy-name cleanup now prunes `trellis-*`
  directories that pristine-file removal left empty (previously they survived
  as empty folders, or were reported as conflicts when the `phronia-*` target
  had already been regenerated). Directories that still hold user content are
  renamed to `phronia-*` when that name is free, and otherwise kept in place
  and reported under "Needs review" relative to the project root.
- **All platforms**: an adopt failure after `.trellis/` → `.phronia/` now
  restores the legacy root automatically and prints the backup path, so the
  command can be re-run instead of leaving a half-migrated tree that only
  reports `Both .trellis/ and .phronia/ exist`.
