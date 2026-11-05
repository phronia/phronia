# Spec delta: centralized worktree root

## .phronia/spec/cli/backend/parallel-tasks.md

- Execution plane row: root is now `.phronia-workspace/<task-id>`; the legacy
  `.phronia/worktrees/<task-id>` is called out as legacy.
- New contract bullets: single resolver (`resolveWorktreeRoot`), managed
  `.gitignore` block written by ensure/add/init/update, outside-repo roots
  reported instead of silently unignored.

## .phronia/spec/cli/backend/directory-structure.md

- Project-root tree gains `.phronia-workspace/` with the rationale for being a
  sibling of `.phronia/`, and notes that `parallel.worktree_dir` overrides it.
