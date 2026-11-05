# Spec delta: centralized worktree root

## Target files

- .phronia/spec/cli/backend/parallel-tasks.md
- .phronia/spec/cli/backend/directory-structure.md

## Intent

- parallel-tasks.md: the execution plane row now names `.phronia-workspace/<task-id>`
  as the default root and calls `.phronia/worktrees/<task-id>` legacy.
- parallel-tasks.md: add the contract that `resolveWorktreeRoot` is the single
  resolver, that the root must be gitignored, and that ensure/add/init/update
  maintain an idempotent `# PHRONIA:START` block. A root outside the repository
  is reported as `outside-repo` rather than silently left unignored.
- directory-structure.md: add `.phronia-workspace/` to the project-root tree
  with the rationale for it being a sibling of `.phronia/`, and note that
  `parallel.worktree_dir` overrides it.

## Rationale

The default moved from inside the workflow root to a repository-root sibling so
the directory is covered by the repository's own `.gitignore` and is obvious to
delete as a whole. Both spec documents describe on-disk layout, so leaving them
unchanged would make the next reader create worktrees in the wrong place.

## Verification

- `git check-ignore .phronia-workspace` returns 0 in a fresh project after
  `phronia init`.
- `phronia doctor --json` reports `worktreeRoot.relativeFromRepo` and `ignored`.
- Worktrees created before the change keep their recorded paths.
