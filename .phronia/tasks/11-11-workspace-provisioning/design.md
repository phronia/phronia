# Design: workspace provisioning

## 1. Layering

The change moves three decisions to the layer that owns them.

| Decision | Current owner | Target owner |
|---|---|---|
| Which ref a worktree forks from | CLI service (`integrationBase`, `resolveBase`) | `packages/core/src/task/workspace/base.ts` (pure) |
| Which worktrees exist and how they are classified | Shared registry loader (registry-first) | `packages/core/src/task/worktree/inventory.ts` (pure) + git adapter facts |
| Whether a taskless workspace may be provisioned | CLI service (`prepare`) | Core policy + CLI service execution |

Target call flow:

```
command (render only)
  -> service/workspace.ts (collect facts, execute, persist)
       -> core/task/workspace/base.ts      resolveWorktreeBase(facts) -> BaseRefResolution
       -> core/task/workspace/policy.ts    decideWorkspace(context incl. base)
       -> core/task/worktree/inventory.ts  reconcileWorktrees(registry, git, root)
       -> adapters/git.ts                  symbolic-ref, rev-list, worktree list/add/fetch
       -> adapters/shared-runtime.ts       atomic read/write of managed entries
```

Hard rules:

- `packages/core` stays pure: no git, filesystem, process, terminal, or CLI argv.
- The CLI service never re-implements base precedence or worktree classification.
- Commands never decide; they render `--json` and human output.
- No service reads stdin. Confirmation is data (`shouldAsk`), not a prompt.

## 2. Base resolver

New file: `packages/core/src/task/workspace/base.ts`.

```ts
export type BaseRefMode = "auto" | "local" | "remote";
export type BaseRefSource =
  | "cli"
  | "task"
  | "config"
  | "remote-head"
  | "local-integration"
  | "head";

export interface BaseRefFacts {
  readonly cliBase?: string | null;
  readonly taskBaseBranch?: string | null;
  readonly configBranch?: string | null;
  readonly mode: BaseRefMode;
  readonly confirm: "auto" | "always" | "never";
  readonly remoteHead?: string | null;   // origin/HEAD symbolic target
  readonly remoteMain?: string | null;   // origin/main
  readonly remoteMaster?: string | null; // origin/master
  readonly localMain?: string | null;
  readonly localMaster?: string | null;
  readonly localIntegration?: string | null;
  readonly headCommit: string;
  /** Resolve an arbitrary ref to a commit; injected by the adapter. */
  readonly resolveRef: (ref: string) => string | null;
  readonly freshness: "local" | "fetched" | "unverified";
}

export type BaseRefResolution =
  | {
      readonly ok: true;
      readonly ref: string;
      readonly commit: string;
      readonly source: BaseRefSource;
      readonly remote: boolean;
      readonly localIntegration: string | null;
      readonly behind: number | null;
      readonly ahead: number | null;
      readonly freshness: "local" | "fetched" | "unverified";
      readonly shouldAsk: boolean;
      readonly alternatives: readonly string[];
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "WORKTREE_BASE_UNRESOLVED"
        | "WORKTREE_BASE_REMOTE_UNAVAILABLE"
        | "WORKTREE_BASE_INVALID";
      readonly reason: string;
      readonly next: string;
      readonly diagnostics: readonly Diagnostic[];
    };

export function resolveWorktreeBase(facts: BaseRefFacts): BaseRefResolution;
```

### 2.1 Precedence

1. `--base` (`cliBase`), when it resolves to a commit.
2. `task.base_branch`.
3. `parallel.integration.branch`.
4. Mode-selected integration ref:
   - `remote`: `origin/HEAD` → `origin/main` → `origin/master`;
   - `local`: `main` → `master`;
   - `auto`: the remote chain when any remote ref exists, otherwise the local chain.
5. Explicit `HEAD` is only reachable through `--base HEAD` (step 1). It is never a
   silent fallback.

When a step names a ref that does not resolve, the resolver refuses with
`WORKTREE_BASE_INVALID` instead of skipping to the next step. A typo in `--base`
must not silently produce a different base.

When no step yields a ref:

- `mode: remote` → `WORKTREE_BASE_REMOTE_UNAVAILABLE`, next:
  `pass --base <ref>` or set `parallel.base.mode: local`.
- otherwise → `WORKTREE_BASE_UNRESOLVED`, next:
  `pass --base <ref>` or configure `parallel.integration.branch`.

The literal `"main"` fallback in `createDecision` is removed.

### 2.2 Behind / ahead

The service computes `git rev-list --left-right --count <base>...<localIntegration>`
and passes the numbers as facts. Convention:

- `ahead` = commits reachable from `base` but not from the local integration
  branch;
- `behind` = commits reachable from `localIntegration` but not from `base`.

Example from the incident: `origin/master` is behind local `master` by 2
commits, so `behind: 2`. That is the signal the caller needs before deciding.

If the base is the local integration branch itself, both are `0`. If no local
integration branch exists, both are `null`.

### 2.3 Freshness and fetch

`remote` means "the remote-tracking ref as currently stored", not "the latest
remote state". The resolver reports `freshness`:

- `local` — the base is a local branch;
- `fetched` — the service fetched this ref in this invocation;
- `unverified` — a remote-tracking ref that was not fetched.

Configuration:

```yaml
parallel:
  base:
    mode: auto        # auto | local | remote
    confirm: auto     # auto | always | never
    fetch: never      # never | always
```

- Default `fetch: never`. No command performs hidden network I/O; agent
  sandboxes and offline CI must stay deterministic.
- `--fetch` overrides to `always` for one invocation; `--no-fetch` overrides to
  `never`.
- A fetch failure is a warning (`WORKTREE_BASE_FETCH_FAILED`), not a refusal:
  the resolution continues with `freshness: "unverified"` and keeps the
  original commit.
- Do not implement `if-behind`: without fetching, the resolver cannot know
  whether the remote advanced. Claiming otherwise would be dishonest.

### 2.4 shouldAsk

`shouldAsk` is a data field consumed by the agent or a human-facing wrapper:

```
confirm === "always"
  || (confirm === "auto" && remote)
```

With the default `auto`, every remote-tracking base asks once. The agent asks
the human, then re-runs with `--base <ref>` (or `--base <local-integration>`)
to settle the choice. `confirm: never` is for scripted flows that accept the
resolved base. The service never blocks on stdin.

`alternatives` lists the other refs that were available (for example
`["master", "origin/master"]`), so the agent can present a concrete choice.

## 3. Worktree inventory

New file: `packages/core/src/task/worktree/inventory.ts`.

```ts
export interface GitWorktreeFact {
  readonly path: string;
  readonly branch: string;
  readonly head: string | null;
  readonly bare?: boolean;
}

export interface InventoryEntry extends WorktreeRegistryEntry {
  readonly managed: boolean;     // registry entry with a taskRef
  readonly insideRoot: boolean;  // path is under the resolved root
  readonly outsideRepo: boolean; // path is outside the main checkout
  readonly exists: boolean;      // present in git worktree list
}

export interface ReconcileInput {
  readonly registry: readonly WorktreeRegistryEntry[];
  readonly git: readonly GitWorktreeFact[];
  readonly mainRoot: string;
  readonly root: WorktreeRoot;
}

export interface ReconcileResult {
  readonly entries: readonly InventoryEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

export function reconcileWorktrees(input: ReconcileInput): ReconcileResult;
```

Classification:

| Bucket | Definition |
|---|---|
| `managed` | registry entry with non-empty `taskRef`, path present in git |
| `provisional` | registry entry with `taskRef: ""`, path present in git |
| `unmanaged` | git worktree (not the main checkout) with no registry entry |
| `missing` | registry entry whose path is absent from git |

Rules:

- Deduplicate by path always. Deduplicate by `taskRef` only when `taskRef` is
  non-empty. `taskRef: ""` is not a unique key; this is the bug that collapses
  multiple provisional workspaces today (`loadWorktreeRegistry` `add()`).
- Never write `unmanaged` entries into the registry. Phronia did not create
  them and cannot safely claim ownership.
- Never delete an unmanaged directory.
- `missing` entries are dropped from persisted state with a diagnostic; the
  existing behavior is preserved.
- The main checkout is excluded from the inventory (it is the control plane, not
  an execution worktree).

Persisted shape stays unchanged: `{schemaVersion, worktrees: [...]}` with only
`taskRef`, `path`, `branch`, `kind`, `provisional`, `createdAt`. Derived fields
(`managed`, `insideRoot`, `outsideRepo`, `exists`, `head`) appear only in
command output.

### 3.1 Adapter changes

`packages/cli/src/adapters/shared-runtime.ts`:

- merge legacy entries first (unchanged);
- always reconcile against `git worktree list --porcelain`, not only when the
  merged registry is empty;
- persist only `managed` and `provisional` entries;
- keep `write: false` read-only for list/doctor;
- emit `RUNTIME_WORKTREES_REBUILT`, `RUNTIME_WORKTREES_PRUNED`,
  `RUNTIME_WORKTREES_UNMANAGED` diagnostics.

`packages/cli/src/services/workspace.ts`:

- `listWorktrees` returns managed + provisional by default;
- `--include-unmanaged` returns every inventory entry;
- `WorktreeRecord` gains optional `managed`, `insideRoot`, `outsideRepo`;
- `doctor` adds: unmanaged worktrees outside the resolved root, count by
  bucket, and a non-blocking hint to migrate or attach.

## 4. Taskless provisioning

Extend the existing provisional-workspace flow instead of adding a second
top-level command.

`phronia task workspace prepare --for-new-task "<title>"` gains:

| Option | Behavior |
|---|---|
| `--branch <name>` | Use this branch for the provisional worktree. Refuse when it is the integration branch, `HEAD`, already checked out, or already exists locally. |
| `--base <ref>` | Forwarded to the base resolver. |
| `--fetch` / `--no-fetch` | One-invocation override of `parallel.base.fetch`. |
| `--isolate` | Create the provisional worktree even when the main checkout is clean and unclaimed. Without it, `prepare` keeps its current behavior (claim main when free). |

Validation for `--branch`:

- non-empty after trimming;
- not `main`, `master`, `origin/main`, `origin/master`, or the configured
  integration branch;
- not currently checked out by any worktree (`git worktree list`);
- no local branch of that name exists (refuse; do not overwrite).

The resolved path always comes from `resolveWorktreeRoot`. No `--path` is added
to `prepare`; escaping the managed root stays an explicit `worktree add` +
`attach` operation with its existing warnings.

Multiple provisional workspaces are supported: the registry keying fix in §3 is
a prerequisite. Two `prepare --for-new-task` invocations with different titles
(or branches) must produce two directories and two registry entries.

Later binding keeps working: `phronia task workspace bind <task-ref> --path <dir>`
sets `taskRef` on the provisional entry and preserves the branch.

Documented flow (`.phronia/workflow.md`, new "Detached hotfix (no task)"
section):

```bash
phronia task workspace prepare \
  --for-new-task "fix xdb bench leak" \
  --branch fix/xdb-benches-session-scope \
  --base origin/master \
  --isolate \
  --session-key <key> \
  --json
```

Then open a session in the printed path (or `cd` there when the harness cannot
move a session). The flow explicitly:

- is not in `parallel plan` and has no footprint;
- does not acquire the main checkout claim;
- must not run parallel mutating sub-agents in one session;
- integrates via a hand-written commit/PR and is cleaned with
  `git worktree remove` or `worktree prune --older-than`.

## 5. Task artifacts

No default change in this task.

`workspace ensure` and `worktree add` keep the `TASK_ARTIFACTS_UNCOMMITTED`
gate: a worktree must see `.phronia/tasks/<ref>`. The existing `next` already
offers two paths (scoped commit or `--copy-task`). This task adds regression
coverage and ensures the `next` text always includes `--copy-task`, so a new
task in a dirty main is not a dead end.

Decoupling task metadata from the base commit (default copy) is a larger
semantic change and is deferred; the taskless flow in §4 does not need it.

## 6. Config surface

Add `parallel.base` next to `parallel.integration` in
`packages/core/src/state/config/readers.ts`:

```ts
interface ParallelBaseConfig {
  readonly mode: "auto" | "local" | "remote";
  readonly confirm: "auto" | "always" | "never";
  readonly fetch: "never" | "always";
}
```

Defaults: `mode: auto`, `confirm: auto`, `fetch: never`.

Invalid values follow the existing pattern: fall back to the default and emit a
`state.config.invalid_value` diagnostic. Unknown keys are ignored as today.

`parallel.integration.branch` keeps its meaning: an explicit integration branch
that also wins over remote/local auto-detection. `task.base_branch` keeps
winning over config, consistent with the current `integrationBase` handling.

## 7. Output contract

`workspace ensure` / `prepare` `--json` success:

```json
{
  "ok": true,
  "decision": {
    "kind": "create",
    "path": "/repo/.phronia-workspace/fix-xdb-benches-session-scope",
    "branch": "fix/xdb-benches-session-scope",
    "base": "origin/master",
    "baseSource": "remote-head",
    "baseCommit": "8ad2929",
    "remote": true,
    "freshness": "unverified",
    "behind": 2,
    "ahead": 0,
    "shouldAsk": true,
    "alternatives": ["master", "origin/master"]
  },
  "workspace": "/repo/.phronia-workspace/fix-xdb-benches-session-scope",
  "worktreeRoot": {
    "absolute": "/repo/.phronia-workspace",
    "relativeFromRepo": ".phronia-workspace",
    "outsideRepo": false,
    "source": "default",
    "gitignore": { "ignored": true, "file": ".gitignore", "pattern": "/.phronia-workspace/", "reason": "already-ignored" }
  },
  "warnings": []
}
```

`worktree list --json`:

```json
{
  "worktrees": [
    {
      "taskRef": ".phronia/tasks/11-11-a",
      "path": "/repo/.phronia-workspace/11-11-a",
      "branch": "phronia/11-11-a",
      "managed": true,
      "insideRoot": true,
      "outsideRepo": false
    }
  ],
  "unmanaged": [
    {
      "taskRef": "",
      "path": "/parent/bedrock-fix-x",
      "branch": "fix/x",
      "managed": false,
      "insideRoot": false,
      "outsideRepo": true
    }
  ],
  "worktreeRoot": { "...": "..." }
}
```

Default human/JSON output remains managed-only; `--include-unmanaged` adds the
second array. Existing consumers that read `worktrees` are unaffected.

## 8. Compatibility and migration

- No `task.json` field is written. `branch`/`worktree_path` remain legacy
  read-only fallbacks.
- Registry persisted shape is unchanged; derived fields are output-only.
- Existing worktree paths never change. `attach` and cleanup keep working.
- The intentional behavior changes:
  1. `ensure` refuses instead of silently using `"main"` when no base resolves;
  2. `origin/HEAD` is consulted before `origin/main`, so a repository whose
     default remote branch is `develop` now bases on `origin/develop`;
  3. unmanaged worktrees appear in `worktree list --include-unmanaged` and
     `doctor` instead of being invisible.
- Document these in `docs/migrations/user-visible-changes.md`.
- Rollback: revert the commits. No persisted field was added, and unmanaged
  entries are never written, so no cleanup is required.

## 9. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Interactive prompt inside the service | Blocks agent sessions; violates the core/CLI boundary. Use `shouldAsk` + `--base`. |
| Fetch on every remote base | Hidden network I/O, slow, fails offline; makes tests nondeterministic. |
| `if-behind` fetch | Cannot know whether the remote advanced without fetching; the name promises something the code cannot deliver. |
| Auto-import unmanaged worktrees | Silently claims ownership of user/platform directories. Report, never import. |
| Auto-move worktrees into the managed root | Breaks running builds, IDEs, and tests; destructive. Report and let the user migrate. |
| New top-level `workspace` command | Duplicates the provisional-workspace concept and `bind`. Extend `prepare`. |
| Default `--copy-task` for task artifacts | Larger semantic change; not needed for the taskless path. Defer. |

## 10. Risks

| Risk | Mitigation |
|---|---|
| `origin/HEAD` changes the selected base for some repositories | `baseSource` in JSON, `shouldAsk: true`, and docs; `--base` settles it. |
| Fetch hangs in a sandbox | Default `fetch: never`; explicit `--fetch` only. |
| Registry reconciliation hides a regression in persisted entries | Keep persisted shape unchanged; integration tests assert managed/provisional round-trip. |
| Multiple provisional entries collide on slug | Existing `hardenedPath` fallback plus branch validation; regression test with two titles. |
| Doctor output grows noisily | Counts plus paths, non-blocking, no exit-code change. |
