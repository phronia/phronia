# ADR-0001: Fork baseline and verification harness

- Status: accepted
- Date: 2026-10-21
- Deciders: project owner, implementation agent
- Supersedes: none

## Context

The fork starts at upstream `mindfold-ai/Trellis` commit `f089cb32` (package
version 0.6.17), recorded by the local provenance commit `9a0986f6`. Before
changing behaviour, the repository needs a reproducible baseline and the
guards that make later batches verifiable.

The repository has two git submodules (`docs-site`, `marketplace`). A plain
checkout leaves them empty, and two CLI template tests fail because they read
`marketplace/workflows/**`. CI initializes submodules recursively
(`.github/workflows/ci.yml:36-38`), so the failures are a local-environment
artifact, not a code defect.

`trellis update --dry-run` on the dogfood tree reports known drift: the fork
has intentionally customized `.trellis/config.yaml`, `.trellis/workflow.md`,
and several generated files. Demanding "zero drift" today would be false.

## Baseline

Environment:

| Item | Value |
|---|---|
| Commit | `9a0986f6` (upstream `f089cb32`) |
| Node | v25.9.0 |
| pnpm | 10.32.1 |
| Python | 3.9.23 |
| OS | macOS 24.6.0, arm64 |

Checks:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass (249 packages) |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm build` | pass |
| `pnpm --filter @mindfoldhq/trellis-core test` | 399 passed, 1 skipped |
| `pnpm --filter @mindfoldhq/trellis test` | 1904 passed |
| `pnpm --filter @mindfoldhq/trellis-testing test` | 18 passed |

Hook cold start (20 iterations, macOS arm64, repo dogfood state):

| Case | p50 | p95 |
|---|---:|---:|
| `python3 -c pass` | 16.50 ms | 17.30 ms |
| `session-start.py` | 87.39 ms | 91.75 ms |
| `inject-workflow-state.py` | 38.39 ms | 39.95 ms |
| `inject-subagent-context.py` | 41.05 ms | 41.97 ms |
| `inject-shell-session-context.py` | 38.69 ms | 40.63 ms |

Full data: `bench/baseline-2026-10-21.json`.

Known dogfood drift is recorded in
`packages/testing/baselines/dogfood-drift.json`: 10 modified files and 1
deleted file. The idempotence guard fails on *new* drift or on *unexpected
resolution*; B1 regenerates the tree and must empty this baseline.

## Decision

1. Treat the numbers above as the G0 baseline. Any later regression is
   measured against them.
2. Initialize submodules before running the baseline; otherwise the two
   marketplace tests fail for environmental reasons.
3. Record known dogfood drift explicitly rather than loosening the guard.
4. Keep `packages/testing` private and unbuilt; tests import TypeScript
   directly through Vitest.

## Consequences

- The baseline is reproducible (`pnpm verify` + `pnpm test:idempotence` +
  `pnpm bench:hooks`).
- The drift baseline is a debt record, not an exemption: B1 must drive it to
  empty.
- Node 25 is newer than the declared floor (>=18.17.0). CI uses Node 20; local
  differences must be noted in future baseline updates.

## Reproduction

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm verify
pnpm test:idempotence
pnpm bench:hooks --iterations 20 --out bench/baseline-2026-10-21.json
```
