# Implementation Plan: workspace provisioning

Execution order is deliberate: tests first, then core, then service/adapter,
then commands/docs. Each stage is independently shippable and reversible.

## Stage 0 — Regression fixtures (write these first)

- [ ] Add `packages/core/test/task/workspace-base.test.ts` with failing cases:
  - explicit `--base` wins over task/config/remote/local;
  - `task.base_branch` wins over config;
  - config wins over remote/local auto;
  - `origin/HEAD` wins over `origin/main` and `origin/master`;
  - `origin/develop` (non-main default) resolves in `remote` and `auto`;
  - `local` mode ignores remote refs;
  - `remote` mode refuses with `WORKTREE_BASE_REMOTE_UNAVAILABLE` when no
    origin exists;
  - no base resolves → `WORKTREE_BASE_UNRESOLVED`, never `"main"`;
  - `--base` naming an unknown ref → `WORKTREE_BASE_INVALID`, no fallback;
  - behind/ahead numbers and `freshness: "unverified"` for an unfetched remote.
- [ ] Add `packages/core/test/task/worktree-inventory.test.ts`:
  - managed/provisional/unmanaged/missing classification;
  - two registry entries with `taskRef: ""` both survive;
  - unmanaged entries are not returned in the persisted set;
  - `insideRoot`/`outsideRepo` for a sibling directory.
- [ ] Add a CLI integration fixture reproducing the incident in
  `packages/cli/test/commands/workspace-provisioning.integration.test.ts`:
  - main is dirty with an unrelated in-progress change and has no claim;
  - two `prepare --for-new-task ... --branch fix/a|fix/b --isolate` calls;
  - both directories land under `.phronia-workspace/`, both branches differ,
    both registry entries survive a reload;
  - `worktree list --include-unmanaged --json` sees a manual sibling worktree;
  - `doctor` reports it as unmanaged/outside-root.

Run the new tests and confirm they fail for the expected reason before stage 1.

## Stage 1 — Core base resolver

- [ ] Create `packages/core/src/task/workspace/base.ts` with
  `resolveWorktreeBase` and exported types (`BaseRefFacts`,
  `BaseRefResolution`, `BaseRefSource`, `BaseRefMode`).
- [ ] Export the new symbols from `packages/core/src/task/index.ts`; no wildcard
  export, no deep import from the CLI.
- [ ] Extend `WorkspacePolicyContext` (`workspace/types.ts`) with
  `base: BaseRefResolution` and let `decideWorkspace` return the resolver's
  refusal unchanged.
- [ ] Remove the literal `"main"` fallback from `createDecision`
  (`workspace/policy.ts`).
- [ ] Add `baseSource`, `baseCommit`, `remote`, `freshness`, `behind`, `ahead`,
  `shouldAsk`, `alternatives` to the `create` decision type (keep the existing
  `base: string` field for compatibility).
- [ ] Update `packages/core/test/task/workspace-policy.test.ts` to pass a
  resolved base instead of relying on the implicit `"main"`.

Validation:

```bash
pnpm --filter @phronia/core test -- workspace-base workspace-policy
pnpm --filter @phronia/core typecheck
```

Review gate: the resolver is pure (no imports from `cli`, no `fs`, no `child_process`)
and every test is offline.

## Stage 2 — Service, adapters, and CLI options for base selection

- [ ] `packages/cli/src/adapters/git.ts`:
  - add `symbolicRef(cwd, ref)` using
    `git symbolic-ref --quiet --short <ref>`; return `null` on failure;
  - add `revListLeftRight(cwd, left, right)` using
    `git rev-list --left-right --count <left>...<right>`;
  - keep the existing `fetch`.
- [ ] `packages/cli/src/services/workspace.ts`:
  - collect base facts (CLI flag, task, config, `origin/HEAD`,
    `origin/main`, `origin/master`, local `main`/`master`, current branch,
    local integration) and call `resolveWorktreeBase`;
  - delete `integrationBase` and `resolveBase`; every caller uses the one
    resolver;
  - add `--base`, `--fetch`, `--no-fetch` to `ensure` and `prepare`;
  - when `shouldAsk` is true, pass it through unchanged; never read stdin;
  - return the base provenance in `WorkspaceSuccess.decision`.
- [ ] `packages/cli/src/commands/parallel.ts`:
  - render `baseSource`, `baseCommit`, `remote`, `freshness`, `behind`,
    `ahead`, `shouldAsk`, `alternatives`, and `worktreeRoot` in `--json`;
  - render a one-line human summary such as
    `base origin/master (remote-head, behind 2, unverified; ask before proceeding)`.
- [ ] `packages/cli/src/cli/index.ts`: add the new options to the `prepare` and
  `ensure` command definitions.
- [ ] `packages/core/src/state/config/readers.ts`: add `parallel.base`
  (`mode`, `confirm`, `fetch`) with defaults `auto`/`auto`/`never` and invalid
  value diagnostics.
- [ ] Tests:
  - service test for `--base`, `--fetch` success/failure, and `shouldAsk`;
  - JSON snapshot asserting `worktreeRoot` is present (the current renderer
    drops it).

Validation:

```bash
pnpm --filter @phronia/cli test -- workspace workspace-provisioning
pnpm --filter @phronia/cli typecheck
pnpm check:layout
```

Review gate: grep proves there is no remaining base-precedence logic outside
`packages/core/src/task/workspace/base.ts`.

```bash
grep -rn "origin/main\|origin/master\|localIntegrationRef\|integrationBase\|resolveBase" packages/cli/src packages/core/src
```

Only the resolver and the config reader should match.

## Stage 3 — Git-derived worktree inventory

- [ ] Create `packages/core/src/task/worktree/inventory.ts` with
  `reconcileWorktrees` and the `InventoryEntry` types.
- [ ] Export it from `packages/core/src/task/index.ts`.
- [ ] `packages/cli/src/adapters/shared-runtime.ts`:
  - reconcile on every load when git is available, not only when the merged
    registry is empty;
  - persist only `managed`/`provisional` entries; leave `unmanaged` derived;
  - fix the `add()` keying: dedupe by path always, by `taskRef` only when it is
    non-empty;
  - keep `write: false` read-only.
- [ ] `packages/cli/src/services/workspace.ts`:
  - `listWorktreesWithRoot` returns managed/provisional by default and all
    entries when `--include-unmanaged` is passed;
  - add `managed`, `insideRoot`, `outsideRepo` to `WorktreeRecord`.
- [ ] `packages/cli/src/cli/index.ts`: add `--include-unmanaged` to
  `worktree list`.
- [ ] `packages/cli/src/commands/doctor.ts`: add a non-blocking report for
  unmanaged worktrees outside the resolved root, with counts and paths; do not
  change the exit code.
- [ ] Tests:
  - multiple provisional entries round-trip through load/write;
  - manual sibling worktree appears as `managed: false`, `insideRoot: false`;
  - dry-run/list does not write the registry;
  - doctor output includes the new counters.

Validation:

```bash
pnpm --filter @phronia/core test -- worktree-inventory
pnpm --filter @phronia/cli test -- worktree workspace doctor
pnpm --filter @phronia/cli typecheck
```

Review gate: inspect the written `worktrees.json` from the integration fixture;
it must contain exactly the managed/provisional entries and no unmanaged path.

## Stage 4 — Taskless provisioning flow

- [ ] `prepareWorkspace` options gain `branch`, `base`, `fetch`, `isolate`.
- [ ] Branch validation: reject integration/main/master/origin refs, `HEAD`,
  an already-checked-out branch, and an existing local branch.
- [ ] `--isolate` bypasses the "claim main when free" path and always creates a
  provisional worktree under the resolved root.
- [ ] Respect `parallel.worktree: never`: refuse with
  `WORKSPACE_WORKTREE_DISABLED` and the existing `next` text.
- [ ] Emit a provisional record with a unique path and branch; regression test
  for two concurrent provisional workspaces.
- [ ] `workspace bind` continues to work on the resulting entry without
  rewriting the branch.

Validation:

```bash
pnpm --filter @phronia/cli test -- workspace-provisioning
```

Review gate: run the flow twice in the fixture and confirm two directories, two
registry entries, two distinct branches, and no write to `.current-task`.

## Stage 5 — Workflow, migration notes, and spec delta

- [ ] `.phronia/workflow.md`:
  - add "Detached hotfix (no task)" under the parallel/workspace section;
  - document `prepare --for-new-task --branch --base --isolate`;
  - document base precedence and `parallel.base.{mode,confirm,fetch}`;
  - document the ZCode/Codex constraint (`--session-key`, one session per
    worktree, no parallel mutating sub-agents in one session);
  - document cleanup and that detached worktrees are not in `parallel plan`.
- [ ] `docs/migrations/user-visible-changes.md`: add the three intentional
  behavior changes from design §8.
- [ ] Write `spec-delta.md` (do not edit `.phronia/spec/**` on this branch):
  - target `.phronia/spec/cli/backend/parallel-tasks.md`: base resolver section,
    inventory buckets, provisional keying rule, detached-hotfix flow;
  - target `.phronia/spec/core/backend/index.md` if a new core subpath export is
    added.
- [ ] Update `task.json.meta.parallel.touches` if this task will share a wave:
  `packages/core/src/task/workspace/**`,
  `packages/core/src/task/worktree/**`,
  `packages/cli/src/services/workspace.ts`,
  `packages/cli/src/adapters/{git,shared-runtime}.ts`,
  `packages/cli/src/commands/{parallel,doctor}.ts`,
  `.phronia/workflow.md`. If the change is serialized, record
  `meta.parallel.exclusive: true` instead.

## Full validation

```bash
pnpm check:layout
pnpm typecheck
pnpm check:layout-json
pnpm check:shims
pnpm lint
pnpm test
```

`pnpm verify` is the final gate (it runs build + all tests).

## Review gates

1. **After Stage 1**: core purity review and base precedence table review.
2. **After Stage 2**: no duplicated base resolution; JSON contract review.
3. **After Stage 3**: registry write review (managed/provisional only) and
   unmanaged classification review.
4. **After Stage 4**: two-provisional-workspaces regression review.
5. **Before commit**: `git diff --stat` shows only the intended layers;
   `spec-delta.md` targets are valid.

## Rollback points

- Stage 1 and 2 are additive options plus a resolver; revert the commits and
  the old `integrationBase` path can be restored without data migration.
- Stage 3 never writes unmanaged entries, so reverting leaves no cleanup.
- Stage 4 is additive flags on `prepare`; existing callers are unaffected.
- No stage changes `task.json` or existing worktree paths, so rollback needs no
  migration.

## Definition of done

- All PRD acceptance criteria checked.
- `pnpm verify` green.
- A regression test reproduces the incident fixture end to end.
- `spec-delta.md` written and reviewed; no `.phronia/spec/**` change on the
  task branch.
- `docs/migrations/user-visible-changes.md` updated.
