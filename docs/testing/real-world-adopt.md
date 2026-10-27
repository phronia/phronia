# Real-world adoption suite

`phronia adopt` is the migration boundary for upstream Trellis projects. Unit
fixtures cover the mechanics; this suite covers the mess that real repositories
accumulate: old workflow scripts, user-owned specs and tasks, OMV-managed
blocks, extra platform directories, and local edits to generated files.

## What it does

For every project in `test/adopt/real-world-projects.json`:

1. clone the repository once into a cache, checked out at the exact pinned
   commit;
2. copy the tracked files to a temporary directory and initialise a clean git
   repo;
3. run `phronia adopt --force --json`;
4. assert the migration result and the preserved user content;
5. run the regenerated `task.py` and `phronia update --dry-run` to prove the
   tree is usable and idempotent.

The fixture is never executed. Only files written by Phronia are run afterwards
(`.phronia/scripts/task.py`), which comes from Phronia's own templates.

## Running it

```bash
pnpm build
pnpm test:adopt-real-world
pnpm test:adopt-real-world --project oh-my-versioning --verbose
pnpm test:adopt-real-world --refresh          # ignore the clone cache
pnpm test:adopt-real-world --keep             # keep the temp worktree on failure
```

The clone cache lives in `$PHRONIA_ADOPT_CACHE`, defaulting to
`~/.cache/phronia-adopt-fixtures`. Pass `--refresh` after changing a pin when
the cache contains the old checkout.

## Adding a project

Add an entry to `test/adopt/real-world-projects.json`:

```json
{
  "name": "my-project",
  "description": "Why this project is a useful fixture.",
  "repo": "https://github.com/you/my-project.git",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "license": "MIT",
  "fromVersion": "0.5.19",
  "platforms": ["claude-code", "codex"],
  "expect": {
    "preservedPaths": [".phronia/spec/backend/index.md"],
    "archiveMonths": { "2026-06": 4 },
    "agentsMdMustContain": ["<!-- PHRONIA:START -->"],
    "agentsMdMustNotContain": ["<!-- TRELLIS:START -->"],
    "workflowMustContain": ["# Development Workflow"],
    "workflowMustNotContain": [".trellis/"],
    "tasksCommand": ["list-archive"],
    "tasksCommandMustContain": ["2026-06"],
    "updateDryRunMustContain": ["Already up to date"]
  }
}
```

Rules:

- **Pin a full 40-character commit SHA.** Never a branch, tag, or short SHA;
  the suite must fail identically next year.
- **Keep the commit reachable.** Rewriting history or deleting the repository
  breaks the suite. If that happens, pin a new commit and note why.
- **Use a public repository with a permissive license.** The suite clones it
  (read-only); it does not vendor the code. Record the license in the entry.
- **Only assert stable content.** Task counts and paths are fine because the
  commit is fixed. Avoid timestamps, versions of external tools, and anything
  the migration intentionally regenerates.
- Prefer assertions that would have caught a real bug:
  - user data exists after migration;
  - `workflow.md` and `scripts/` no longer contain the legacy root;
  - `AGENTS.md` keeps the project's own managed blocks;
  - `update --dry-run` is clean.

## Updating a pin

1. Change `commit` in the manifest.
2. Run `pnpm test:adopt-real-world --project <name> --refresh --verbose`.
3. Adjust expectations only when the new commit genuinely changes the fixture.
4. Keep the old commit in git history; do not rewrite the fixture repository.

## CI

`.github/workflows/ci.yml` runs the suite on pull requests and pushes that touch
the CLI, the manifest, or the runner script, on a weekly schedule, and via
`workflow_dispatch`. The fixture clone is cached by the manifest hash. A pin
change therefore invalidates the cache automatically.

Unit tests still gate every change (`pnpm test`). This suite is the
complementary end-to-end gate for the migration path.
