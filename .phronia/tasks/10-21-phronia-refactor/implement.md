# Implement — B0 baseline and guards

Batch document (authoritative task detail):
`/Volumes/MagicStorage_TB3/xpeng-work/working_project/phronia_重构计划/BATCH/01-baseline.md`

## Status

| Task | Status | Evidence |
|---|---|---|
| T1 install + baseline | done | core 399 pass / 1 skip; cli 1904 pass; testing 18 pass |
| T2 ADR directory + decisions | done | `docs/adr/0001`–`0006` |
| T3 fixture tool skeleton | done | `packages/testing/src/{redact,fixtures}.ts` + tests |
| T4 parity tool skeleton | done | `packages/testing/src/parity.ts` + tests |
| T5 idempotence test | done | `packages/testing/src/idempotence.ts` + baseline JSON |
| T6 hook perf baseline | done | `bench/baseline-2026-10-21.json` |
| T7 CI paths + guardrails | done | `.github/workflows/ci.yml` |
| T8 NOTICE / compliance log | done | `docs/legal/modification-log.md` |

## G0 exit checklist

- [x] `pnpm install --frozen-lockfile` works after `git submodule update --init --recursive`.
- [x] `pnpm verify` covers typecheck + lint + build + all tests.
- [x] `pnpm test:idempotence` runs and records known drift.
- [x] `pnpm bench:hooks` produces a comparable JSON baseline.
- [x] CI triggers on `.trellis/**`, `docs/**`, `packages/testing/**`, `bench/**`.
- [x] Decisions D-01–D-20 have accepted ADRs.
- [x] AGPL modification log exists; B0 made no upstream deletions.

## Notes

- Submodules are required locally; without them two marketplace template tests
  fail. CI already initializes them.
- `packages/testing` is private and unbuilt; Vitest compiles its TypeScript
  directly.
- The idempotence guard compares against
  `packages/testing/baselines/dogfood-drift.json` (10 modified, 1 deleted).
  B1 must drive that baseline to empty.
- The bench currently picks the first task directory in sorted order. That is
  deterministic, but B3 should add a dedicated fixture project so the numbers
  do not depend on repository state.

## Next batch

B1 (`02-naming.md`): introduce `WorkspaceLayout`, flip values, implement
`phronia adopt`, archive upstream manifests, regenerate dogfood.
