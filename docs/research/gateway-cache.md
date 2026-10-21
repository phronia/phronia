# Gateway prompt-cache impact (research)

Status: design analysis only; no measurements yet.

## Phase 1: read-only capture

A transparent proxy that forwards bytes unchanged has zero effect on cache
keys. The only requirement is that the gateway does not normalize JSON
(key order, whitespace) before forwarding; forward the original body.

Expected hit-rate delta: **0**.

## Phase 2: tail injection (not approved)

Appending a turn at the end of the conversation changes the cacheable prefix
only if the provider caches on the full request. Anthropic caches on explicit
`cache_control` breakpoints; a tail append after the last breakpoint does not
invalidate earlier blocks but does prevent the previous full request from
being a prefix of the next one. The cost must be measured per provider.

## Measurement plan

1. Run one harness against the provider directly and record
   `usage.cache_read_input_tokens` / `cache_creation_input_tokens`.
2. Repeat through a read-only gateway; assert the usage fields are identical.
3. For a simulated tail injection, compute the hit-rate delta over 50 turns
   and reject the feature if the loss exceeds 5 percentage points.

## Decision rule

- Read-only capture: allowed if experiments 1–2 show byte-identical usage.
- Any write path: requires a separate ADR and a measured cache budget.
