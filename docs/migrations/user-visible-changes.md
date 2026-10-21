# User-visible behaviour changes

Every batch that changes what a user sees (injected text, command availability,
default paths, hook behaviour) appends an entry here. The goal is that a
release note can be assembled from this file without reading commit history.

## Format

```markdown
## <version or batch>

- [platform] <behaviour> changed from A to B.
  - Why:
  - Migration:
  - Escape hatch:
```

## Unreleased (B1 — Phronia identity)

- **All platforms**: the CLI is `phronia`; `trellis` and `tl` remain aliases for
  one major version and print a deprecation notice.
- **All platforms**: the workflow directory is `.phronia/`. Upstream projects
  must run `phronia adopt` once; user specs/tasks/journals are preserved, and
  generated files are regenerated. `adopt-report.md` lists everything kept,
  regenerated, or needing review.
- **All platforms**: environment variables are `PHRONIA_*`; `TRELLIS_*` values
  are mapped automatically for one major version.
- **All platforms**: skills are `phronia-*`, sub-agents are `phronia-implement`
  / `phronia-check` / `phronia-research`, and slash commands live under
  `commands/phronia/`. Legacy `trellis-*` agent names are still recognized.
- **All platforms**: managed AGENTS.md/Copilot markers are
  `PHRONIA:START/END`; legacy markers are migrated in place on update.
- **Pi / OMP**: the project extension moved from `extensions/trellis/` to
  `extensions/phronia/`.
- **OpenCode**: persisted context metadata is written under `phronia`; old
  `trellis` metadata is still read.
- **Update hint**: probes `phronia --version` and the notice says "Phronia".

Batches that must update this file:

- **B3**: Kiro sub-agent output (JSON → plain text); Codex/Copilot gain
  first-reply notice and update hint; stale-pointer wording unified; JS hosts
  regain `task_error` / `Present:` / JSONL warnings.
- **B5/B6**: unknown harness versions may switch to `degraded` fallback;
  shim files become managed artifacts and are no longer overwritten silently.
- **B7**: ZCode may select `bridge` or `prelude` instead of project hooks; the
  doctor reports the reason.
- **B9**: check output gains a machine-readable verdict file.
- **B10**: hooks stop invoking Python; a platform package is used when
  available.
- **B12**: `phronia init` no longer creates `00-bootstrap-guidelines` or
  `00-join-*` tasks; `docs/` is generated on demand.
