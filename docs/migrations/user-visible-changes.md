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

## Unreleased

No user-visible changes yet. B0 only adds verification tooling.

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
- **B12**: `trellis init` no longer creates `00-bootstrap-guidelines` or
  `00-join-*` tasks; `docs/` is generated on demand.
