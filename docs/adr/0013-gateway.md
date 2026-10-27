# ADR-0013: Gateway — wait, do not implement

- Status: accepted (research phase only)
- Date: 2026-10-21
- Deciders: architecture
- Supersedes: none

## Context

`mem` currently reads seven harness-internal stores. B8 added a floor
(journals/tasks/spec) plus schema checks and per-adapter isolation, so a broken
reader degrades the quality of recall but not to zero. The remaining
structural risk is that internal store formats can change without notice.

A local, read-only HTTP gateway could capture turns at the wire layer, where
the format is more stable. It is also the largest maintenance surface in the
plan: three protocols, streaming, identity inference, redaction, retention,
and a process that must be running for capture to work.

## Decision

1. Do **not** ship a gateway runtime now. The floor and hook-based injection
   already cover the required behaviour; the gateway is a ceiling, not a
   foundation.
2. Keep the research artifacts:
   - `docs/research/gateway-protocols.md`
   - `docs/research/gateway-identity.md`
   - `docs/research/gateway-cache.md`
   - `docs/research/gateway-recall-gain.md`
3. Revisit only when at least two trigger conditions hold:
   - quantified recall gap: ≥ 3 misses per week and reader failure rate > 10%;
   - two or more harnesses in the same project needing unified recall;
   - no portable session export appearing in mainstream harnesses within 12
     months;
   - a compliance/audit requirement that must observe without changing
     harnesses.
4. If triggered, the first phase is read-only capture only. Any injection at
   the gateway is a separate ADR because it changes the prompt-cache prefix.
5. Reverse triggers: a standard session export/memory protocol lands in
   mainstream harnesses, or protocol maintenance exceeds the benefit.

## Consequences

- No new runtime process, no TLS/CA work, no 0700 storage, no retention
  policy is implemented in this fork yet.
- The gateway remains a candidate `MemSourceKind`; adding it later requires a
  new adapter id and a capture store, not a change to the context pipeline.
- Users who need cross-harness recall today use the floor first
  (`phronia mem floor`) and the enhancers second.
