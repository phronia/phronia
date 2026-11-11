# Spec Delta

## Target files

- .phronia/spec/cli/backend/parallel-tasks.md
- .phronia/spec/core/backend/index.md

## Intended changes

- `parallel-tasks.md` §4 (workspace decision):
  - Add the single base-ref resolver contract and its precedence
    (`--base` → task → integration config → remote/local mode → explicit HEAD).
  - State that there is no silent `"main"` fallback; unresolved bases refuse
    with `WORKTREE_BASE_UNRESOLVED` or `WORKTREE_BASE_REMOTE_UNAVAILABLE`.
  - Document `parallel.base.{mode,confirm,fetch}`, `freshness`
    (`local|fetched|unverified`), `shouldAsk`, and the no-stdin confirmation
    model.
  - Document `workspace prepare --branch/--base/--fetch/--isolate` and the
    detached-hotfix flow.
- `parallel-tasks.md` §1/§4 (source of truth):
  - `git worktree list --porcelain` is the source of truth for existence,
    path, branch, and HEAD; the shared registry supplies task metadata for
    managed/provisional entries only.
  - Reconciliation buckets: managed, provisional, unmanaged, missing.
    Unmanaged entries are reported, never persisted, moved, or deleted.
  - `taskRef: ""` is not a unique key; multiple provisional workspaces coexist.
- `parallel-tasks.md` §4 (dirty checkout):
  - Clarify that a dirty unclaimed main is a `create` trigger under the default
    `auto` policy (the current code behavior), while `parallel.worktree: never`
    and `worktree add` keep their refusals.
- `core/backend/index.md`:
  - Add `packages/core/src/task/workspace/base.ts` and
    `packages/core/src/task/worktree/inventory.ts` to the source map as pure
    domain modules (no git/fs/process), exported through `@phronia/core/task`.

## Rationale

The incident showed that base selection was duplicated across the CLI service,
the registry acted as an authority instead of a cache, and taskless isolation
had no supported entry point. Keeping the decisions pure and reporting their
provenance lets agents confirm a remote base without making the CLI
interactive.

## Verification

- `pnpm --filter @phronia/core test`
- `pnpm --filter @phronia/cli test`
- `pnpm check:layout && pnpm typecheck`
- `pnpm verify`
