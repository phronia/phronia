# Acceptance Report — parallel-task-execution

- Task: `.phronia/tasks/10-28-parallel-task-execution`
- Date: 2026-10-28
- Branch: `phronia/parallel-task-execution`
- Environment: macOS 15.7.7 (arm64), Node 25.9.0, pnpm 10.32.1, ZCode 3.16.3, git 2.50.1
- Acceptance owner: current session (implementation delegated to W0–W6 sub-agents)

## Result

**Implementation acceptance passed on macOS.** The full repository gate and a real no-remote dogfood pass. Four platform/environment items remain manual and are listed at the end; none is a code failure.

## Commands run

| Command | Result |
|---|---|
| `pnpm verify` | pass (layout, typecheck, layout-json, shims, lint, build, full test suite) |
| `python3 ./.phronia/scripts/task.py validate .phronia/tasks/10-28-parallel-task-execution` | pass (20 implement entries, 17 check entries; one spec file truncation warning) |
| `node packages/cli/dist/cli/index.js docs generate --check` | current |
| `python3 -m py_compile .phronia/scripts/common/task_store.py` | pass |
| `pnpm --filter @phronia/cli lint:py` | pass (pre-existing warnings only) |

## Dogfood: no-remote end-to-end

Temp git repo with a minimal `.phronia/` project and two `in_progress` tasks:

- Task A: `src/a/**`, reuses the main checkout.
- Task B: `src/b/**`, gets a worktree because A owns main.

Observed:

1. `task parallel plan --explain --json` → one wave with A and B, both `independent`.
2. `task workspace ensure A --session-key s1` → `reuse-current`; A owns main.
3. `task workspace ensure B --session-key s2` → `create` at `.phronia/worktrees/b`, branch `phronia/b`, base `main`.
4. `task commit`. For a worktree task it must run inside the worktree; running it from main returns `COMMIT_WRONG_WORKSPACE` with the exact `cd` command. Running inside the worktree succeeds.
5. `task integrate A --mode local --verify true --session-key s1` → `landed`.
6. `task integrate B --mode local --verify true --session-key s2` → `landed`.
7. `git log --graph` is linear: init → seed → ignore → feat A → metadata A → feat B → metadata B.
8. `git status --porcelain` empty after each integration.
9. `task.py archive` on B printed `Removed landed worktree` and archived; A archived with no worktree. `git worktree list` then showed only the main checkout.

This dogfood caught and fixed a real defect: a worktree task referenced by its full `.phronia/tasks/<id>` ref was canonicalized to `.phronia/worktrees/<id>/.phronia/tasks/<id>`, so artifact verification ran against the wrong path. The fix prefers the shared registry's `taskRef`; a regression test now covers the full-ref case.

## Capability gate smoke

| Command | Observed |
|---|---|
| `task parallel status --platform claude-code --json` | `coordinator.available=true` |
| `task parallel status --platform zcode --json` | `available=false`, reason `subagentWorkspace: inherited`, fallback `multi-session` |
| `task parallel dispatch --batch smoke --platform zcode --dry-run --json` | `COORDINATOR_UNSUPPORTED` with multi-session commands; no worktree or lease created |

Safety checks:

- `git worktree list` showed only the main checkout after dispatch.
- `<git-common-dir>/phronia/leases/` empty after dispatch.
- `coordinator.ts` / `dispatch.ts` do not import `node:child_process` or call `spawn`.
- No `pr merge` / `mr merge` / merge API call in the forge or integrate paths.
- `.phronia/.gitignore` still ignores `worktrees/` and `.runtime/`.

## Acceptance scenario coverage

| Scenario | Status | Evidence |
|---|---|---|
| PLAN-01..04 | pass | `packages/core/test/task/parallel.test.ts`, `packages/cli/test/commands/parallel.integration.test.ts`, CLI plan smoke |
| WS-01..06 | pass | `workspace-policy.test.ts`, `workspace.integration.test.ts`, dogfood |
| LEASE-01 | pass | `lease.integration.test.ts`, coordinator policy tests |
| INT-01 | pass (lock-level) | `integrate.integration.test.ts` holds the real lock and asserts no interleave; no OS-level two-process spawn in the suite |
| INT-02..07 | pass | `integrate.integration.test.ts` (verify rollback, semantic handoff, remote no-merge, recovery, confirm-once, commit ownership) |
| COORD-01..04 | pass (mock capability) | `dispatch.integration.test.ts`, `coordinator.integration.test.ts`, CLI gate smoke |
| LIFE-01 | pass | dogfood archive + W6 temp-repo smoke |
| COMPAT-01 | pass | dogfood no-remote flow |
| WORKFLOW-01 | partial | workflow/skills updated and `pnpm verify` idempotence passes; the real `/phronia:continue` flow was exercised manually via `workspace ensure`, not as a full slash-command run |

## Non-functional

- **macOS**: pass (locks, worktrees, paths, archive guard).
- **Linux/Windows**: not run in this session; lock/path unit tests exist but real CI is pending.
- **Performance**: no benchmark run; planner/status tests are fast, but the 100-task/20-worktree budgets were not measured.
- **Security**: handoff/log redaction paths are covered by tests; no token/env values were found in the dogfood handoff/logs.

## Remaining manual acceptance (not code failures)

1. **Claude Code live coordinator** — W0 verified the Agent schema (`cwd`, `isolation: worktree`) and docs, but no live `ANTHROPIC_API_KEY` run was possible. Run one orchestrator + two sub-agents with `cwd` and confirm `Active task:` injection.
2. **ZCode/Codex multi-session fallback** — verified by the capability gate and fallback commands; run one real two-window dogfood to confirm the UX.
3. **Real forge (GitHub/GitLab)** — remote mode is tested with a mock forge; run one real PR/MR against a scratch remote.
4. **Windows** — lock unlink, path normalization, and archive guard on a Windows checkout.

## Known deviations (documented)

- After a local landing, Phronia writes a metadata-only commit for the task record. Code commits remain the verified commits; the metadata commit only touches `task.json`.
- `task commit` is intentionally strict: it must run inside the task worktree, not main.
- Coordinator mode is gated fail-closed; only Claude Code is a candidate today, and it is not marked fully `supported` until the live run above.

## Branch state

The feature is committed on `phronia/parallel-task-execution`. The task is still `in_progress` and not archived: archive requires merging the feature branch into the integration branch first. After review/merge, run `/phronia:finish-work` to integrate, archive, and record the journal.
