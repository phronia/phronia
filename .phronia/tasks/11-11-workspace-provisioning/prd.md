# Workspace provisioning: single base resolver, git-derived registry, taskless hotfix path

## Goal

Make worktree provisioning predictable, observable, and reproducible:

1. every new worktree forks from a base ref that is chosen by one resolver, with its
   source and freshness reported to the caller;
2. the set of worktrees that exist is derived from git, so manually created or
   platform-created worktrees are visible instead of silently ignored;
3. a session that needs an isolated fix without creating a Phronia task has a
   supported, documented path that always lands under the managed worktree root.

## Problem Statement

A real incident (bedrock; see `research/bedrock-incident.md`) exposed three

independent defects at layer boundaries:

- **Base selection is duplicated and opaque.** `workspace ensure` and
  `worktree add` resolve the base ref with two different precedence lists, both
  in the CLI service. The chosen ref is returned as a bare string, so callers
  cannot see where it came from, whether it is a remote-tracking ref, or whether
  it is behind local work. The resolver never consults `origin/HEAD`, never
  reports freshness, and one branch silently falls back to `"main"`.
- **The worktree registry is treated as the source of truth.** The shared
  registry is only rebuilt from git when it is empty, and reconciliation only
  removes entries. Any worktree created by `git worktree add`, a platform, or a
  previous session without registry write is invisible to `worktree list`,
  planning, dispatch, and doctor.
- **Taskless isolation has no first-class entry point.** `workspace prepare
  --for-new-task` can create a provisional workspace, but it cannot choose the
  branch or base, is not documented as the hotfix path, and the registry loader
  collapses multiple provisional entries because they all share `taskRef: ""`.
  Operators consequently fall back to manual `git worktree add` outside the
  managed root.

## Requirements

### R1 — Single base-ref resolver

- One pure resolver owns base-ref precedence for `workspace ensure`,
  `workspace prepare`, and `worktree add`.
- Precedence: explicit `--base` → `task.base_branch` →
  `parallel.integration.branch` → remote HEAD (`origin/HEAD` symbolic ref, then
  `origin/main`, `origin/master`) or local integration (`main`, `master`)
  according to `parallel.base.mode` → explicit `HEAD`.
- The resolver returns the ref, the resolved commit, the source, whether the ref
  is remote-tracking, and the behind/ahead counts relative to the local
  integration branch.
- There is no silent fallback to a literal `"main"`. When no base can be
  resolved, the command refuses with an actionable `next` that includes
  `--base`.

### R2 — Git-derived worktree inventory

- `git worktree list --porcelain` is the source of truth for which worktrees
  exist, their path, branch, and HEAD.
- The shared registry remains the source of task metadata (`taskRef`, `kind`,
  `provisional`, `createdAt`) for managed entries only.
- Reconciliation classifies entries as `managed`, `provisional`, `unmanaged`
  (git only), or `missing` (registry only). Unmanaged entries are never silently
  written into the registry and never silently deleted.
- Multiple provisional entries must coexist; `taskRef: ""` is not a unique key.
- `worktree list` can include unmanaged entries, and `doctor` reports unmanaged
  worktrees that live outside the resolved root.
- Phronia never automatically moves an existing worktree.

### R3 — Supported taskless hotfix provisioning

- A session with no task can create one or more isolated worktrees under the
  resolved root with an explicit branch and base, without creating a task and
  without touching the active-task pointer.
- The command prints the path, branch, base, and the exact next step. If a task
  is created later, the existing `workspace bind` path attaches the provisional
  workspace.
- The flow is documented in `.phronia/workflow.md` as the detached-hotfix path,
  including cleanup and the constraint that it does not participate in
  `parallel plan` or footprints.

### R4 — Observable decisions

- Every `--json` result that creates or attaches a workspace includes: resolved
  base ref, base commit, base source, remote/local flag, behind/ahead,
  `shouldAsk`, the resolved worktree root, and whether the root is gitignored.
- `shouldAsk` is data, not an interactive prompt. The CLI never reads stdin.
  Agents use it to ask the human, then re-run with `--base`.
- `doctor` reports stale/unverified remote bases and unmanaged worktrees.

### R5 — Compatibility and safety

- Existing tasks and worktrees keep their current path and branch; no
  `task.json` field is rewritten and no directory is moved.
- Existing base-ref outcomes remain valid unless the caller opts into `--base`
  or a new config value. The only intentional behavior change is replacing the
  silent `"main"` fallback with an explicit refusal.
- Remote freshness is explicit: the default must not perform hidden network I/O.
  A remote base is reported as `unverified` unless the caller asked to fetch.
- All destructive or state-changing operations keep their existing gates.

### R6 — Layering

- Domain decisions (base resolution, worktree classification, decision matrix)
  live in `packages/core` and stay pure: no git, no filesystem, no process, no
  terminal output.
- Git and shared-runtime adapters perform IO only.
- The CLI service gathers facts, calls core, executes, and persists.
- Commands render; they do not decide.
- No duplicate base-selection or worktree-classification logic remains in the CLI
  service.

## Non-goals

- Platform-native worktree launch (`claude --worktree`, editor integrations).
  Phronia continues to attach those.
- Automatically moving or deleting existing worktrees.
- Changing the isolation policy (default isolation, lightweight escape hatch).
  That belongs to `11-05-worktree-execution-model`.
- Merge-conflict resolution or semantic conflict detection.
- Cross-repository parallel semantics.
- Changing the task-artifact commit gate's default. This task only makes its
  `--copy-task` alternative explicit and covered by tests.

## Constraints

- `packages/core` must expose new modules through the package's declared
  subpath exports; CLI must not import deep `src` paths.
- Every failure carries `{ok:false, code, message, next, details}` and an
  executable `next`.
- Registry writes use the existing atomic same-directory temp+rename path.
- Planning and code comments are English; user-facing chat summaries may be
  Chinese.
- Tests must run offline. No test may depend on a reachable remote; remote
  behavior is exercised with local fixture refs.

## Acceptance Criteria

- [ ] `resolveWorktreeBase` is a pure core function with unit tests covering:
      explicit, task, config, `origin/HEAD` (including a non-main default),
      `origin/main`, `origin/master`, local main/master, explicit `HEAD`, no
      resolvable base, and `auto`/`local`/`remote` modes.
- [ ] `workspace ensure`, `workspace prepare`, and `worktree add` all use that
      one resolver; the old `integrationBase`/`resolveBase` duplication is gone.
- [ ] `ensure` and `prepare` accept `--base <ref>`; JSON reports
      `baseSource`, `baseCommit`, `behind`, `ahead`, `shouldAsk`, and
      `worktreeRoot` (including gitignore state).
- [ ] A remote-tracking base is reported as `remote: true` and
      `freshness: "unverified"` unless a fetch was explicitly requested.
- [ ] No code path silently uses `"main"` as a base when no base resolves; the
      command refuses with `WORKTREE_BASE_UNRESOLVED` and a `--base` next.
- [ ] Two consecutive `prepare --for-new-task` calls create two distinct
      provisional worktrees under the resolved root; both survive a registry
      reload and both appear in `worktree list`.
- [ ] `worktree list --include-unmanaged --json` reports a manual
      `git worktree add` directory with `managed: false` and `insideRoot: false`.
- [ ] `doctor` reports unmanaged worktrees outside the resolved root and does
      not modify them.
- [ ] The detached-hotfix flow is documented in `.phronia/workflow.md` with the
      exact commands, base-selection semantics, cleanup, and ZCode/Codex
      constraints.
- [ ] Existing regression suites stay green; `pnpm lint`, `pnpm typecheck`, and
      the affected package tests pass.
- [ ] No existing worktree path or `task.json` field changes in the migration
      fixture.
