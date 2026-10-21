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
  - **OMP**: session start now injects the core session plan; the per-turn
    message carries the core `<workflow-state>` breadcrumb instead of OMP's
    nested `[workflow-state:*]` block plus `<session-overview>`. Task context
    uses the core materializer, so files appear as `=== path ===` blocks.
  - **Snow**: the hook is a thin adapter over `phronia context`. Session/user
    inject and `.snow/log/phronia-context.txt` now contain the core session
    plan and breadcrumb; Snow's own role-specific sub-agent checklists are
    gone, and sub-agent material comes from the core JSONL/artifact pipeline.
  - **Pi**: the sub-agent prompt is the core role prompt prefixed with the
    `.pi/agents/<name>.md` definition (Pi has no `--agent` flag); per-turn
    runtime context carries only the core breadcrumb, while the startup
    snapshot stays in `systemPrompt`.
  - **OpenCode**: the session-start plugin now injects context, so the
    generated `.opencode/commands/phronia/start.md` fallback is no longer
    written; existing copies are harmless and can be deleted. Sub-agent
    prompts come from the core role templates; the research prompt no longer
    carries the `<!-- phronia-hook-injected -->` marker (Python never emitted
    it for research).
  - Why: one assembly implementation; OMP/Pi/Snow had three drifting copies.
  - Migration: no action for users; custom text that matched Snow's
    `Sub-agent checklist (...)` headings must read the task artifacts instead.
- **B5/B6**: unknown harness versions may switch to `degraded` fallback;
  shim files become managed artifacts and are no longer overwritten silently.
  - **B5 now**: `phronia doctor` reports the selected adapter, harness version
    and source, status, and last handshake per platform; `--json`,
    `--no-probe`, `--refresh-manifest`, and `--check` are available.
    `phronia platforms --detect` probes configured platforms and writes
    `.phronia/manifest.json` (gitignored, machine-local). Every `phronia
    context` call records a per-platform handshake under
    `.phronia/.runtime/harness/`, storing payload key names only — a plugin
    that loads but never runs now shows `last handshake never` instead of
    silently doing nothing. OpenCode 2.x selects an unimplemented `@v2`
    shard and reports `unsupported` rather than reusing the v1 plugin.
- **B7**: ZCode may select `bridge` or `prelude` instead of project hooks; the
  doctor reports the reason.
- **B9**: check output gains a machine-readable verdict file.
- **B10**: hooks stop invoking Python; a platform package is used when
  available.
- **B12**: `phronia init` no longer creates `00-bootstrap-guidelines` or
  `00-join-*` tasks; `docs/` is generated on demand.
