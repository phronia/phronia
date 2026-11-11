# Research: bedrock workspace-provisioning incident

Date: 2026-11-11. Access to the bedrock repository was read-only.

## Scenario

The main checkout `/Volumes/MagicWork/xp-non-aosp-codes/bedrock` was being used
by another session for an in-progress v2 task. A second session fixed two
unrelated bugs in parallel. Two isolated worktrees were created manually with
`git worktree add` in sibling directories, not under the managed root:

```text
/Volumes/MagicWork/xp-non-aosp-codes/bedrock                           38fb98e [master]
/Volumes/MagicWork/xp-non-aosp-codes/bedrock-agent-xdb-local-identity  f1c5c45 [task/agent-xdb-local-identity]
/Volumes/MagicWork/xp-non-aosp-codes/bedrock-fix-bench-leak            919cb03 [fix/xdb-benches-session-scope]
/Volumes/MagicWork/xp-non-aosp-codes/bedrock-fix-onboard-404           b9a8a98 [fix/onboard-release-assets]
```

The managed root `.phronia-workspace/` existed and was empty. `.gitignore`
already contained the expected block:

```text
# PHRONIA:START
# Task worktrees created by `phronia task workspace ensure`
/.phronia-workspace/
# PHRONIA:END
```

## Evidence

### Main checkout was dirty and unclaimed

`git status --porcelain` showed modified v2 files, modified `.omv` projections,
and an untracked task directory:

```text
 M rust/hub/src/lib.rs
 M rust/hub/src/routes/v2/unit.rs
 ...
?? .phronia/tasks/11-11-fix-v2-group-binding-projection/
?? rust/hub/src/app/config_projection.rs
```

There was no `workspace.claim.json` under `.git/phronia/`, so the "occupation"
was dirty files only, not a Phronia claim.

### Two tasks were already in progress

`grep -rl '"status": "in_progress"' .phronia/tasks/*/task.json` matched:

```text
.phronia/tasks/11-11-v2-runtime-cutover/task.json
.phronia/tasks/11-11-fix-v2-group-binding-projection/task.json
```

### The remote-tracking base was stale

```text
git log --oneline -1 origin/master   -> 8ad2929 chore(release): 2611.11.4
git log --oneline -1 master          -> 38fb98e docs(task): plan v2 runtime cutover
```

Two local commits (`56fb33d feat(v2): add endpoint lifecycle APIs`, `38fb98e`)
were not on `origin/master`. A worktree based on `origin/master` therefore did
not contain the other session's committed work.

### The shared registry did not know the manual worktrees

`.git/phronia/worktrees.json` was last written on 2026-11-07 and contained
legacy entries under `.phronia/worktrees/...`. It contained no entry for either
`bedrock-fix-*` directory:

```text
grep -c "fix-bench\|fix-onboard" .git/phronia/worktrees.json   -> 0
```

Because the shared registry file existed and was non-empty, the loader never
rebuilt from `git worktree list`. The code only rebuilds when the merged entry
list is empty (`packages/cli/src/adapters/shared-runtime.ts`).

### The new task directory was not on the base

The new fix task directory was untracked in the main checkout. `workspace
ensure` checks `git rev-parse <base>:<task-ref>/task.json`, so it would have
refused with `TASK_ARTIFACTS_UNCOMMITTED` unless `--copy-task` was passed.

## Code findings validated against this incident

1. **Dirty main is not a blocker.** With the default `auto` policy and no claim,
   `decideWorkspace` returns `create` for a dirty checkout
   (`packages/core/src/task/workspace/policy.ts`). The incident did not hit a
   dirty refusal; it bypassed Phronia entirely.
2. **The taskless entry point exists but is incomplete.**
   `workspace prepare --for-new-task` creates a provisional workspace without a
   task and without claiming main, but it cannot set the branch or base, and it
   is not documented as the hotfix path.
3. **Multiple provisional workspaces collapse.** The registry loader's `add()`
   dedupes by `taskRef`; every provisional entry uses `taskRef: ""`, so only the
   first survives a reload. This blocks the "two parallel hotfixes" scenario even
   if both `prepare` calls succeed.
4. **`origin/HEAD` is not consulted.** The service only checks `origin/main`
   then `origin/master`, although `hasOrigin()` checks `refs/remotes/origin/HEAD`.
   Repositories whose default remote branch is `develop` cannot resolve a remote
   base.
5. **Base resolution is duplicated.** `integrationBase()` (ensure/prepare) and
   `resolveBase()` (worktree add) have different precedence and one silently
   falls back to `"main"`.
6. **`worktreeRoot` is dropped from `--json`.** `renderWorkspace` does not emit
   the resolved root even though `workflow.md` says the JSON carries it.

## Reproduction recipe for tests

Use a local fixture repository; no network is required.

1. Create `main` with one commit and `origin` pointing at a bare clone.
2. Advance local `main` two commits beyond `origin/main`.
3. Leave the main checkout dirty with one unrelated modified file.
4. Do not write `workspace.claim.json`.
5. Run `prepare --for-new-task "fix a" --branch fix/a --isolate --json` and the
   same for `fix/b`.
6. Assert: both paths are under `.phronia-workspace/`, both branches are
   distinct, both registry entries survive a second load, and the JSON reports
   `base: "origin/main"`, `baseSource: "remote-head"`, `behind: 2`,
   `freshness: "unverified"`, `shouldAsk: true`.
7. Run `git worktree add ../manual-fix -b fix/manual origin/main` and assert
   `worktree list --include-unmanaged --json` reports it with
   `managed: false, insideRoot: false`.
