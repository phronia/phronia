# ADR-0002: Naming migration and upstream adoption

- Status: accepted
- Date: 2026-10-21
- Deciders: project owner
- Supersedes: none

## Context

The project is a fork of `mindfold-ai/Trellis` (AGPL-3.0-only). The fork is
named **Phronia**: CLI `phronia`, directory `.phronia/`, npm scope
`@phronia/*`, environment variables `PHRONIA_*`, skill prefix `phronia-`.

The current tree still uses `trellis` everywhere:

- 407 `.trellis` literals in `packages/cli/src/**/*.{ts,js,py}`.
- 979 `.trellis` literals under `packages/cli/src/templates/**`.
- 270 `.trellis` literals across 57 of 149 upstream migration manifests.
- 104 `@mindfoldhq` references in the CLI package.
- `constants/paths.ts` claims a single `DIR_NAMES` flip renames everything; it
  does not (`template-hash.ts:264-287`, `manifest-prune.ts:139`,
  `shared.ts:631-642`, `template-fetcher.ts:25-30`, Python `paths.py`).

Upstream migration manifests describe `0.1.x → 0.7.x` path moves. They cannot
run after the root directory changes name, and replaying them would require
carrying 270 old-path references forward.

## Decision

1. Rename in B1 using a three-step sequence:
   - introduce `WorkspaceLayout` while values stay `.trellis`;
   - flip values;
   - regenerate dogfood and platform artifacts.
   A global search-and-replace is forbidden.
2. Provide `phronia adopt` for upstream projects:
   - back up outside the repository;
   - rename `.trellis` → `.phronia`;
   - delete only files whose hash matches the old manifest;
   - rewrite manifest keys and upgrade the manifest schema to v3;
   - regenerate Phronia-owned artifacts;
   - emit an auditable `adopt-report.md`.
3. Archive the 149 upstream manifests under
   `packages/cli/src/migrations/upstream/`; they are not loaded. Phronia's own
   manifest history starts at `1.0.0`.
4. Migration is intentionally lossy for generated artifacts:
   - user-authored specs, tasks, journals, and custom files are never deleted;
   - Phronia-owned hooks/commands/skills are regenerated;
   - local edits to generated files are preserved as conflicts or `.new`, and
     listed as `needs-review`.
5. Keep a compatibility window of one major version:
   - `TRELLIS_*` environment variables still work with a one-time warning;
   - the published package does not install a `trellis` bin, so an existing
     upstream CLI is not clobbered and users are not asked to uninstall it;
     `bin/trellis.js` is available for an explicit manual symlink and prints
     the legacy notice;
   - `trellis-*` skill names are recognized.

## Options rejected

- **Dual directories** (`.trellis` + `.phronia`): doubles runtime-state bugs
  and keeps old names in every new contract.
- **Replaying upstream migrations**: couples Phronia's history to a product it
  no longer follows; the manifests cannot express a root-directory rename.
- **Renaming after the architecture work**: writes old names into new
  contracts, fixtures, manifests, and ADRs, forcing a second sweep.

## Consequences

- B1 is a large but mechanical diff with hard verification (grep assertions,
  `adopt` fixture, idempotent regeneration).
- Users must run one command; the report tells them exactly what changed.
- The AGPL provenance remains: `NOTICE.md` keeps upstream attribution, and
  `/docs/legal/modification-log.md` records removed/rewritten files.
