# Parallel Tasks Contract

> Runtime contract for task-level parallelism, worktree lifecycle, serial
> integration, and coordinator mode. Read this before changing
> `packages/core/src/task/**`, `packages/cli/src/adapters/**`,
> `packages/cli/src/services/{parallel,workspace,lease,integrate,coordinator}.ts`,
> the task/workflow skills, or the Python archive guard.

---

## 1. Control plane, shared runtime, execution plane

| Plane | Location | Owns |
|---|---|---|
| Control | the main worktree: `.phronia/tasks/**`, `.phronia/config.yaml`, `docs/requirements.md` | task intent, planning, local merge target, docs projection |
| Shared runtime | `<git-common-dir>/phronia/` | locks, queue, worktree registry, workspace claim, task index, leases |
| Execution | linked worktrees under `.phronia/worktrees/<task-id>` | code, tests, logs, agent sessions |

`.phronia/spec/**` is **control-plane state, not an execution footprint**. A
code task records intended spec changes in `spec-delta.md`; the main checkout
applies them after the code lands (§6.1). Never put `.phronia/spec/**` in
`meta.parallel.touches`.

`git rev-parse --git-common-dir` resolves to the same directory from every
worktree of one repository. Coordination state **must** live there. Putting a
lock in `.phronia/.runtime/` is a bug: that directory is per-checkout and
gitignored, so two worktrees never see each other's lock.

Files:

```
<git-common-dir>/phronia/
  integration.lock        # who is integrating (phase + pre/post SHA)
  integration.json        # waiting queue + last result
  worktrees.json          # taskRef -> path/branch/kind/provisional
  workspace.claim.json    # who owns the main checkout
  tasks.index.json        # cross-session task projection (rebuildable)
  leases/<hash>.json      # one task lease
  batches/<id>.json       # coordinator batch projection (rebuildable)
  logs/
```

Source of truth:

| Question | Source |
|---|---|
| Branch exists / merged | git |
| Task's worktree | `worktrees.json`, rebuildable from `git worktree list --porcelain` |
| Who is integrating | `integration.lock` |
| Who owns the main checkout | `workspace.claim.json` |
| Who is doing a task | `leases/<hash>.json` |
| Task intent / footprint / dependencies | the task's `task.json` |
| Did the task land | `meta.integration.outcome` + git ancestry |

`task.json.worktree_path` and `task.json.branch` are legacy B11 fields. New
code must **not** write them; they are read-only fallbacks when the registry is
unavailable.

## 2. Three mutexes

| Mutex | File | Answers | Acquisition |
|---|---|---|---|
| Task lease | `leases/<sha256-prefix>.json` | who is doing this task | `O_EXCL` |
| Workspace claim | `workspace.claim.json` | who owns the main checkout | `O_EXCL` |
| Integration lock | `integration.lock` | who is landing | `O_EXCL` |

- **Fixed order:** task lease → workspace claim → integration lock. Release in
  reverse. Never invert this order; it is the deadlock-avoidance rule.
- **Staleness is TTL-only** (`heartbeatAt + ttlSeconds < now`) for leases and
  claims. `pid` is diagnostic only: every `phronia` invocation is a new
  process, so pid liveness says nothing. Only `integration.lock` may opt into
  `ttl-or-pid`.
- A stale claim is not free:
  - owner task still `planning`/`in_progress` → `stale-owned`, no auto-reclaim;
  - main checkout dirty → `stale-dirty`, never reclaim;
  - owner completed/archived and main clean → reclaim with a warning.
- Locks coordinate worktrees of one repository only. They are not
  cross-machine locks; remote mode + the forge merge queue owns multi-user
  ordering.

## 3. Task index and leases

`tasks.index.json` is a **rebuildable projection**, not a second source of
truth. Required fields: `taskRef`, `title`, `status`, `priority`, `updatedAt`;
optional `footprint`, `dependsOn`, `owner`, `workspace`. Rebuild from the main
worktree plus each worktree's `task.json`. A missing index must never block a
command.

A task lease records `taskRef`, `ownerType` (`session|subagent|task`),
`ownerId`, `sessionKey`, `workspace`, `acquiredAt`, `heartbeatAt`,
`ttlSeconds`. Expiry does not transfer the task automatically; the orchestrator
must explicitly reclaim after checking that the workspace has no uncommitted or
unpushed work.

## 4. Workspace decision and lifecycle

`decideWorkspace` returns exactly one of:

- `reuse-current` — claim the main checkout;
- `attach` — the task already has a worktree (or a platform-created one);
- `create` — isolate this task in a new worktree;
- `refuse` — with a `code` and a `next` command.

Rules:

- The isolation unit is the **task**, not the session. One task = one branch =
  at most one worktree. Two sessions on the same task share it.
- `task.json.branch` names the task's **feature branch only**. It is never the
  integration branch: `task.py start` leaves it empty when the checked-out
  branch is the integration/base branch (or detached HEAD).
- `ensure` resolves the candidate worktree branch in this order: the branch of
  an existing registry entry → a real `task.branch` (different from the
  integration branch) → `phronia/<slug>`. A `task.branch` equal to the
  integration branch is treated as "no dedicated branch"; it never becomes the
  worktree branch (that would always fail with "already checked out").
- A task that does not require isolation reuses a clean, unclaimed main
  checkout (`reuse-current`) and records a task claim there. Only
  `parallel.worktree=always`, an `exclusive` task, a parallel batch, or a main
  checkout claimed by another task creates a worktree.
- Default location is `.phronia/worktrees/<task-id>` (persistent). `/tmp` is
  only for explicit `ephemeral`.
- Task artifacts must be visible in the worktree: either
  `.phronia/tasks/<ref>` is already committed on the integration branch, or the
  caller explicitly scoped-commits it, or uses `--copy-task`.
- `worktree add` and `workspace ensure` share one task-artifact gate. When the
  main checkout is dirty only with `.phronia/tasks/<ref>`, both return
  `TASK_ARTIFACTS_UNCOMMITTED` with a scoped commit command
  (`git add .phronia/tasks/<ref> && git commit -m "chore(task): plan <id>"`)
  and the `--copy-task` alternative. Any other dirty path keeps the existing
  refusal. `worktree add --copy-task` copies the task directory instead of
  requiring the commit.
- **Declarative build inputs.** `parallel.inputs` materializes gitignored
  paths in each worktree. The canonical form is a list of mappings; a compact
  path→mode mapping and a bare list of paths (mode defaults to `symlink`) are
  also accepted:

  ```yaml
  parallel:
    inputs:
      - path: rust/web/node_modules
        mode: symlink      # symlink | copy
      - path: rust/xsdk-pin-v1202
        mode: symlink
      - path: .env.local
        mode: copy
    integration:
      ignored_inputs:
        - rust/xsdk-pin-v1202
    build:
      cargo_target_dir: per-worktree   # per-worktree | shared
      sccache: false
  ```

  `path` must be repo-relative with no `..`; a source outside the main
  checkout is refused (`WORKTREE_INPUT_FAILED`). Symlinks are relative and
  resolve inside the repository. On Windows a symlink permission failure
  degrades to a copy with a warning. Existing destinations are skipped.
- **Ignored inputs are explicit.** `parallel.integration.ignored_inputs` is an
  allow-list for the dirty check used by `integrate` and `spec sync`; any
  other uncommitted path still blocks. A configured path is removed only when
  it is a symlink whose target stays inside the repository, or
  `git check-ignore --no-index` confirms git ignores it; otherwise it is
  reported as dirty with a warning. **A symlink to a gitignored directory is
  not matched by git's `/dir/` pattern** (the pattern matches the directory
  entry, not the link), so the link path itself must be listed in
  `ignored_inputs`. There is deliberately no blanket `--allow-untracked`.
- **Build cache.** `parallel.build.cargo_target_dir: shared` only emits a
  recommendation (`export CARGO_TARGET_DIR=<repo>/.phronia/cache/cargo-target`)
  and warns that Cargo's target lock serializes concurrent builds.
  `parallel.build.sccache: true` only emits an install/`RUSTC_WRAPPER` hint;
  Phronia never installs or configures a compiler cache. Worktrees do not
  isolate ports, databases, or Docker.
- **Cleanup output.** `worktree remove` and `worktree prune` best-effort
  measure the removed directory and print `freed ~<size>`. Measurement failure
  never blocks the removal.
- `create` may be preceded by `workspace prepare --for-new-task` when the task
  does not exist yet. The provisional entry has `taskRef: null,
  provisional: true`; `task create` binds it.
- Phronia cannot move a running session. After `create`, print the path and
  require a new session there (or the platform's native worktree launch).
- Platform-native worktrees are registered with `worktree attach`; binding
  checks the branch and refuses a mismatch.

Cleanup:

| Trigger | Behavior |
|---|---|
| `integrate` success | keep the worktree (marked merged); `--clean` may remove it |
| `task archive`, clean + `landed` | remove the worktree, keep the branch |
| `task archive`, dirty | refuse |
| `task archive`, clean + not landed | refuse |
| `worktree prune` | only archived/landed/clean worktrees; never dirty/unlanded/unpushed |

Never auto-delete a dirty worktree or one with unlanded commits. A branch is
kept unless `--delete-branch` is explicit.

## 5. Parallel planning

Footprint priority: `meta.parallel.touches` → `relatedFiles` → `scope` mapping
→ `package` → unknown. Unknown, `exclusive`, and always-serial paths form
single-task waves. `depends_on` is the only dependency source; parent/child
tasks are not dependencies. Missing dependencies and cycles are errors
(`DEPENDENCY_MISSING`, `DEPENDENCY_CYCLE`), never silently dropped.

Parent tasks (`children.length > 0`) are **containers**, not execution units:
they never enter a wave. The planner emits `PARALLEL_CONTAINER_TASK` with the
child `task.py start` commands (`warn` when the parent was explicitly selected
via `--refs`, `info` otherwise). A container with included `planning` children
also produces `PARENT_HAS_PLANNING_CHILDREN`. `--explain` prints
`container (children: N): coordinator only; start a child to execute`.

`--explain` must state, for every task, the footprint source, the wave, and the
overlap (if any). `parallel.enabled: false` must print a reason, not an empty
result.

Spec is no longer always-serial. `.phronia/spec/**` is removed from
`DEFAULT_ALWAYS_SERIAL`; a task that still lists it in `meta.parallel.touches`
gets a `SPEC_IS_POST_INTEGRATION` **warning** but is not forced into a serial
wave (spec is not a footprint). `docs/requirements.md`, `.phronia/config.yaml`,
`.phronia/workflow.md`, `.phronia/gate.yaml`, lock files, and migrations stay
always-serial.

A spec-only task (`meta.kind: spec`) is a control-plane unit: the planner emits
`PARALLEL_SPEC_ONLY` (`info`) and excludes it from waves. Run it in the main
checkout; it may update `.phronia/spec/**` directly and does not need a
worktree.

## 6. Integration and commit

`task integrate` (no `land` alias) is the only landing path:

1. Resolve the mode: task override → `--mode` → project config → auto-detect
   (`origin` → remote, otherwise local). Always print `mode=<x> (reason)`.
2. Preconditions: main checkout clean (local), task worktree clean and
   committed, verification configured or explicit `--no-verify`.
3. Acquire in order: task lease → workspace claim → integration lock.
4. Local: fetch → record `preLandSha` → rebase the task branch → verify the
   rebased tree → CAS on `preLandSha` → `merge --ff-only` → write outcome.
5. Remote: push the branch, create the PR/MR, record `pr_url`, outcome
   `pushed`. **Never call a merge API.**
6. Verification failure or textual conflict must leave the base SHA unchanged.
7. `--recover` resolves an interrupted run from `phase` + git state;
   `--rollback` requires explicit confirmation.

`task commit <ref>` commits only inside the task worktree. Running it in the
main checkout for a worktree task is `COMMIT_WRONG_WORKSPACE`; the orchestrator
must never commit a worktree task on `main`.

After a local landing, a metadata-only commit may record the outcome
(`chore(task): record integration state`). It must not change the verified code
tree.

**`integrate` is not archive.** Integrate writes
`meta.integration.outcome ∈ {none, landed, pushed, blocked, needs_human}` and
releases its locks. Archive is a separate lifecycle step in `finish-work`.

### 6.1 Spec control plane (post-integration sync)

A code task must not commit `.phronia/spec/**` on its branch. It records intent
in `.phronia/tasks/<ref>/spec-delta.md`:

```md
# Spec Delta

## Target files
- .phronia/spec/cli/backend/parallel-tasks.md

## Intended changes
- Add the control-plane sync contract.

## Rationale
- The runtime now records intent instead of writing spec in the task branch.

## Verification
- `pnpm --filter @phronia/cli test -- spec`
```

Rules:

- `Target files` is required and every entry must be repo-relative, free of
  `..`, and under `.phronia/spec/`.
- A delta is intent, not a patch. The main session applies it to the current
  spec tree after the code lands; this is why two tasks can touch the same
  spec file without a merge conflict.
- No delta means `meta.spec_sync.status = "none"`; integration and archive do
  not require sync.

Commands:

```bash
phronia task spec plan <ref...> [--json]      # read-only
phronia task spec commit <ref...> [--json] [--allow-missing]
phronia task spec status [ref...] [--json]
```

`plan` requires `meta.integration.outcome == "landed"`, returns the delta, the
landed diff (`base_sha..commit`), the target files, and the current spec
hashes. It takes no lock and writes nothing.

`commit` runs only in the main checkout on the base branch, acquires the same
integration lock as `integrate` (order: task lease → workspace claim →
integration lock), and:

1. refuses when the main checkout has non-spec changes;
2. refuses when no spec file changed;
3. validates each delta target is `.phronia/spec/**` and actually changed
   (`--allow-missing` downgrades a missing target to a warning);
4. commits **only** `.phronia/spec/**` as `chore(spec): sync <refs>`;
5. writes `meta.spec_sync = {status: "synced", commit, synced_at, refs, mode: "agent"}`
   and commits the task metadata as `chore(task): record spec sync for <refs>`;
6. releases the lock.

Failure codes: `SPEC_SYNC_NOT_LANDED`, `SPEC_SYNC_LOCK_BUSY`,
`SPEC_SYNC_DIRTY_MAIN`, `SPEC_SYNC_TARGET_INVALID`, `SPEC_SYNC_NO_CHANGES`,
`SPEC_SYNC_BASE_MISMATCH`, `SPEC_SYNC_FAILED`. Each carries an executable
`next`.

`integrate` gate: a task with `.phronia/spec/**` changes on its branch and
`meta.kind != "spec"` fails with `SPEC_IN_CODE_TASK`. The next step is
`git restore --staged --worktree .phronia/spec` in the worktree, write the
intent into `spec-delta.md`, and re-commit. There is deliberately no
`--allow-spec-in-code` escape hatch. `meta.kind: spec` tasks bypass the gate.

`archive` gate: a task with `spec-delta.md` whose
`meta.spec_sync.status != "synced"` is refused with `SPEC_SYNC_PENDING`
(next: `task spec plan` / `task spec commit`). `--skip-spec-sync` is the only
escape hatch, requires an explicit choice, and records the reason in the
task's `notes`.

The breadcrumb's runtime line reports `spec: none | pending | synced`
(see `workflow-state-contract.md`). A `failed` sync reads as `pending` so it
cannot be mistaken for done.

Visibility (R10): `phronia doctor` reports `task.specSync`
(`pending`, `failed`, `synced`, `available`/`reason`) and
`phronia task parallel status` prints `spec=none|pending|synced|failed` per
task plus a `specSync {pending, failed}` summary in `--json`. Both read the
same core projection: `spec-delta.md` presence plus
`task.json.meta.spec_sync.status`; a task without a delta is never pending,
and `failed` stays distinct from `pending` in status output.

### 6.2 Archive branch resolution

Archive must not require `--skip-branch-validation` for the normal worktree
path. Resolve the task's feature branch in this order (never write it back to
`task.json`):

1. `task.json.branch` (explicit, legacy fallback);
2. the shared registry entry (`worktrees.json`) for this taskRef;
3. none.

Then validate:

- branch equals `base_branch` → refuse (a PR cannot target itself);
- branch present but no longer local → warning, continue;
- branch absent, `meta.integration.outcome == "landed"`, and
  `meta.integration.commit` is an ancestor of the base branch
  (`git merge-base --is-ancestor`) → accept
  (`landed without a dedicated branch`);
- branch absent and not landed → keep the existing refusal with `set-branch`
  and `--skip-branch-validation` next steps. `pushed` (an open PR) never
  qualifies as landed.

The Python archive guard resolves the task's worktree from the shared registry
(legacy `task.json.worktree_path` only when the registry is unavailable),
validates branch metadata first (§6.2), then enforces the spec-sync gate
(§6.1), then:

- dirty → refuse (`phronia task commit <ref>` or `worktree remove --force`);
- clean + `landed` → `git worktree remove <path>` (branch kept), then archive;
- clean + not landed → refuse (`phronia task integrate <ref>` or
  `worktree remove <ref>`);
- `git worktree remove` failure → refuse and print the git error.

## 7. Coordinator mode

Phronia **does not spawn agents**. It emits a dispatch manifest; the harness's
native sub-agent tool performs the dispatch.

Capability gate (`coordinator.mode`), fail closed:

- `subagentExecution ∈ {parallel, nested}` (unknown/none/single fail);
- `subagentWorkspace == "per-task"` (inherited fails);
- otherwise fall back to multi-session or serial.

Verified status: Claude Code is a coordinator candidate (`nested` + `per-task`,
identity `shared`); ZCode and Codex are multi-session only (sub-agents inherit
cwd); unverified platforms are unsupported until Phase 0 evidence exists.

### 7.1 Multi-session launch plan

`phronia task parallel launch [refs...] --wave <n> [--prepare] [--platform <id>] [--json]`
is the orchestration surface for harnesses that cannot dispatch a sub-agent
with an explicit `cwd`. It reads the plan (or explicit refs) and returns, per
mutating task: `taskRef`, `workspace`, `branch`, `activeTaskLine`
(`Active task: <ref>`), `prepareCommand`, `leaseCommand`, platform
`openInstructions`, missing build inputs plus executable `next` steps, and a
single `next` (`workspace ensure ...`) when the workspace is absent.

- Default is read-only: it reads the shared registry and never creates a
  worktree, lease, process, or session.
- `--prepare` calls `workspace ensure` per task (side effects: worktree,
  claim/lease), then re-reads the resulting workspace/branch.
- Containers (`PARALLEL_CONTAINER_TASK`) and spec-only tasks
  (`PARALLEL_SPEC_ONLY`) are returned in `skipped`, never fabricated into a
  launch entry.
- ZCode/Codex instructions say to open a **new window/session** in the
  worktree. `Active task:` is the first line. Mutating sub-agents inherit the
  parent cwd, so they must not be dispatched from another session. Claude Code
  instructions name the per-task-workspace capability and note that the
  coordinator rollout is a separate task.

The main session's multi-session loop is:
`parallel plan` → `parallel launch --prepare` → open one session per worktree
with its `Active task:` line → collect commits → serial `integrate` → spec
sync. Parallel read-only `phronia-research` sub-agents may still run in one
session; mutating work is always one session per worktree.

Manifest (`parallel dispatch --batch <id> --json`):

```json
{
  "batch": "bedrock-20261028",
  "tasks": [
    {
      "taskRef": ".phronia/tasks/10-28-a",
      "workspace": "/repo/.phronia/worktrees/a",
      "branch": "phronia/a",
      "lease": "lease-token",
      "dependsOn": [],
      "promptPrefix": "Active task: .phronia/tasks/10-28-a\nWork only in ..."
    }
  ]
}
```

Contract:

- Dispatch prepares workspaces and acquires leases, then returns the manifest;
  it starts no process.
- Every command in coordinator mode passes an explicit `--task <ref>`; the
  ambient active-task pointer is not trustworthy (identity may be `shared`).
- New sessions may add tasks mid-batch: register in the shared index, re-plan,
  and join the next wave or a free slot. Overlapping footprints wait. There is
  no global batch lock.
- A blocked task does not stop the batch; its lease can be reclaimed after
  inspection.
- The orchestrator must not hold the main checkout's claim; local integrate
  needs `main`. Finish a batch with `sequential integrate --drain`, or use
  remote mode for the whole batch.

### 7.2 Dispatch next wording

The dispatch codes are unchanged; only the `next` text and details are
user-facing:

- `DISPATCH_WRONG_CHECKOUT` — first `next` is
  `open a new session/window in <worktree>`, then
  `first line: Active task: <ref>`. `cd <worktree>` appears only as
  "only if your harness can move this session". A shell `cd` does not move an
  agent session's file tools.
- `DISPATCH_TASK_NOT_CHILD` — the reason names the session's active task, the
  requested task, and their relation (`child` / `sibling` / `other`). The
  `next` list says to open a separate session, prints its worktree (or
  "run workspace ensure first"), the `Active task:` line, forbids dispatching
  mutating siblings from this session, and states the platform's
  `subagentWorkspace` capability (coordinator mode is not enabled).
- `DISPATCH_ISOLATION_REQUIRED` — keeps the four multi-session steps and adds
  `do not run multiple mutating sub-agents in the main session; ZCode/Codex inherit the parent cwd`.

Every deny keeps a self-contained `reason` and the
`Do not retry; report this exactly.` guidance.

## 8. Error and output conventions

- Every command supports `--json`; errors return
  `{ok:false, code, message, next, details}`.
- Every failure carries an executable `next`.
- `integrate`, `parallel status`, and `coordinator status` print the resolved
  mode/locks/capability reason rather than silently degrading.
- No command uses `process.exit` or printing from `core`; the domain layer is
  pure.

## 9. Migration and rollback

- Read the legacy `.phronia/.runtime/worktrees.json` and merge into the shared
  registry; write only the shared location.
- Do not migrate or delete legacy `task.json` fields; read them as fallbacks.
- New data lives under `task.json.meta`; old tasks need no migration.
- Rollback: delete the new commands and set `parallel.enabled: false`.
  Already-landed commits remain; locks/leases can be removed.

## 10. 派发准入 (Dispatch admission)

`evaluateDispatch(facts)` in `packages/core/src/task/dispatch/` answers one
question: **may this implement/check dispatch happen now?** It is a pure
function (no IO, no platform branches). The read-only fact layer lives in
`packages/core/src/state/runtime-facts.ts`; the shim renders the verdict.

Only structural violations block. Rules are evaluated in order and the first
match wins; the order and codes are a public contract:

| # | Code | Decision | Condition |
|---|---|---|---|
| 1 | `DISPATCH_OUTSIDE_CONTRACT` | allow | agent is not mutating (`research`/read-only or unknown) |
| 2 | `DISPATCH_OK` | allow | `parallel.dispatch.enforce: off` (diagnostic only) |
| 3 | `DISPATCH_NO_ACTIVE_TASK` | allow | no task resolves; pull-based behaviour is preserved |
| 4 | `DISPATCH_TASK_NOT_CHILD` | block | explicit `Active task:` is neither the active task nor its child |
| 5 | `DISPATCH_PARENT_TASK` | block | effective task has `children` (a parent is a container) |
| 6 | `DISPATCH_TASK_NOT_IN_PROGRESS` | block | effective status is `planning`/`blocked`/`completed` |
| 7a | `DISPATCH_CHECKOUT_OWNED_BY_OTHER` | block | cwd is a linked worktree registered to another task |
| 7b | `DISPATCH_WRONG_CHECKOUT` | block | the task has a worktree and cwd is not it |
| 7c | `DISPATCH_CHECKOUT_UNREGISTERED` | allow + guard | cwd is a linked worktree with no registry entry |
| 8a | `DISPATCH_WRONG_CHECKOUT` | block | cwd is main but the task has a worktree |
| 8b | `DISPATCH_ISOLATION_DISABLED` | allow + guard | isolation is required but `parallel.worktree=never` |
| 8c | `DISPATCH_ISOLATION_REQUIRED` | block | isolation is required and cwd is main |
| 8d | `DISPATCH_MAIN_CLAIMED` | block | main is claimed by another task/fresh session |
| 8e | `DISPATCH_STALE_CLAIM_DIRTY` | block | stale claim + main has uncommitted changes |
| 8f | `DISPATCH_NO_CLAIM` | allow + guard | main is unclaimed or the claim is stale |
| 9 | `DISPATCH_LEASE_OTHER_OWNER` | allow + guard | the task lease belongs to another live session |
| — | `DISPATCH_PLATFORM_CANNOT_BLOCK` | allow + guard | a block was downgraded by capability or `enforce` |
| — | `DISPATCH_FACTS_UNRELIABLE` | allow + guard | the fact layer could not read git/runtime state |

`requiresIsolation` = `parallel.worktree=always` OR `exclusive` OR at least two
`in_progress` siblings. It never looks at `touches`: a footprint says a task
*can* run in parallel, not that it *is* running in parallel.

Capability degradation (`platform.hookPolicy`):

| `hookPolicy` | block verdict | guard |
|---|---|---|
| `block` (Claude Code, ZCode, OpenCode) | deny the tool call | allow + guard for `DISPATCH_NO_CLAIM` and friends |
| `inject` (Codex) | never deny; prepend `WORKSPACE_GUARD` (`STOP:` first line) | same |
| `unknown` (Cursor, unverified) | treated like `inject` (fail closed) | same |

`parallel.dispatch.enforce` (default `block`) applies on top:

| `enforce` | block verdict | allow + guard |
|---|---|---|
| `block` | deny when the platform can block | guard |
| `warn` | allow + guard (guard severity `error`) | guard |
| `off` | allow, no guard; breadcrumb still shows facts | allow, no guard |

Invalid values fall back to `block` with a `state.config.invalid_value`
diagnostic. The setting affects dispatch admission only — never
`parallel plan`, `workspace ensure`, or `integrate`.

`phronia doctor` reports `task.dispatchAdmission` /
`platforms[].dispatchAdmission` with `hookPolicy`, `enforce`, and whether the
harness can block.

## 11. Related contracts

- `.phronia/spec/cli/backend/workflow-state-contract.md` — per-turn breadcrumb
  and `task.json.status` writers.
- `.phronia/spec/cli/backend/filesystem-safety.md` — atomic writes and
  destructive-operation gates.
- `docs/migrations/user-visible-changes.md` — user-facing changes.
