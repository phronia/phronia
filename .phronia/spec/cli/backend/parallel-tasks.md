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

The Python archive guard resolves the task's worktree from the shared registry
(legacy `task.json.worktree_path` only when the registry is unavailable), then:

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
