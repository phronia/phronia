# Modification Log (AGPL-3.0)

Upstream: `mindfold-ai/Trellis`, commit `f089cb32`, package version 0.6.17.
Fork: Phronia. The fork remains licensed under AGPL-3.0-only; see `LICENSE`,
`COPYRIGHT`, and `NOTICE.md`.

This log records files from the upstream project that this fork deletes,
renames, or substantially rewrites. It exists to satisfy the AGPL requirement
that modifications be evident and attributable. It is updated by every batch
that removes or rewrites upstream code.

## Format

| Date | Batch | Path | Change | Upstream commit | Reason |
|---|---|---|---|---|---|

`Change` is one of: deleted, renamed, rewritten, extracted.

## Entries

| Date | Batch | Path | Change | Upstream commit | Reason |
|---|---|---|---|---|---|
| 2026-10-21 | B0 | `packages/testing/**`, `bench/**`, `docs/adr/**`, `docs/legal/**`, `docs/migrations/**` | added | — | Fork-specific verification and governance; not derived from upstream code. |
| 2026-10-21 | B0 | `docs-site/`, `marketplace/` submodules | initialized | `f089cb32` | Required by the existing test suite; content remains upstream, unmodified. |
| 2026-10-21 | B1/T3 | `.trellis/**` → `.phronia/**` | renamed | `f089cb32` | Fork identity. User data (tasks, workspace, spec) moved verbatim; only generated workflow files changed content. |
| 2026-10-21 | B1/T3 | `.trellis` path literals across `packages/**`, platform dirs, templates, tests | rewritten | `f089cb32` | Workflow root rename. Historical material (upstream migration manifests, ADRs, NOTICE, archived tasks) is excluded. |
| 2026-10-21 | B1/T3 | `packages/cli/src/templates/trellis/scripts/common/layout.json` | added | — | Generated from the TypeScript layout so Python and TS resolve the same root. |
| 2026-10-21 | B1/T4 | `packages/*/package.json`, imports, release scripts, workflows | rewritten | `f089cb32` | npm identity renamed to `@phronia/core`, `@phronia/cli`, `@phronia/testing`; historical notices and migration manifests keep upstream names. |

## Not yet modified

No upstream source file has been deleted or rewritten as of B0. B1 (naming) and
B3 (context core) will produce the first large entries:

- B1: `.trellis/**` → `.phronia/**`; `packages/cli/src/templates/trellis/**` →
  `templates/workflow/**`; upstream migration manifests moved to
  `migrations/upstream/`.
- B3: shared Python hooks and duplicated JS/TS extensions removed after their
  logic moves into `packages/core/src/context`.

Each of those batches must add its rows here before merging, with the upstream
path and the reason.

## Attribution

- Upstream copyright and license notices are retained in every file that
  originated upstream.
- New files carry the project's copyright header where the repository
  convention requires one.
- `NOTICE.md` records the fork base, pin commit, and license notice.
