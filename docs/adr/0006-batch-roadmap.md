# ADR-0006: Batch roadmap and gates

- Status: accepted
- Date: 2026-10-21
- Deciders: project owner
- Supersedes: none

## Context

The refactor spans fourteen areas (A–L plus naming/baseline) and roughly
130–180 person-days. Doing it in one branch is unreviewable; doing it without
gates means regressions surface only at the end.

## Decision

Ship in fourteen batches, each with its own document and gate:

| Batch | Scope | Gate |
|---|---|---|
| B0 | baseline + guards | G0: reproducible baseline, fixture/parity/idempotence tools |
| B1 | naming + adopt | G1: no `.trellis` literals, adopt fixture passes, dogfood idempotent |
| B2 | TS state core (read-only) | G2: parity whitelist empty |
| B3 | `phronia context` (A) | G3: 12-platform parity, Kiro fixed, ≥8,000 lines removed |
| B4 | capability matrix (C) | G2: `platforms --check` passes |
| B5 | adapter thinning + version axis (B) | G4: unknown versions explicit, no silent shim |
| B6 | shim artifacts + contract fixtures (D) | G4: fixture matrix 100% |
| B7 | ZCode (I) | G5: three paths, bridge ≤30 lines, real 3.8 fixture |
| B8 | mem floor (F) | G6: floor recall works with empty harness stores |
| B9 | rule ledger (L) | G6: dogfood ledger round trip |
| B10 | binary (E) | G7: five targets, Python removed, cold-start budget |
| B11 | worktree (G) | G8: add/list/remove, no cross-worktree bleed |
| B12 | spec bootstrap + docs (J+K) | G8: requirements deterministic, decision links valid |
| B13 | gateway research (H) | G9: decision + trigger conditions |

Ordering constraints:

- B1 before B2: new contracts must not encode old names.
- B2 before B3: otherwise the context core contains a third state
  implementation.
- B4 before B5: the version axis needs a place to express per-version
  capabilities.
- B5/B6 before B7: ZCode consumes the version axis and fixture harness.
- B10 after B2/B3/B5/B6: the binary is a packaging step, not a rewrite.

## Consequences

- Every gate is a publishable milestone; G3 already yields a usable product.
- A batch can be rolled back without touching earlier state (except B1, which
  requires backup/reverse adoption).
- The roadmap is revisited only by superseding this ADR.
