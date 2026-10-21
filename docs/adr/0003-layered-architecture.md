# ADR-0003: Layered architecture — core / cli / shims

- Status: accepted
- Date: 2026-10-21
- Deciders: architecture
- Supersedes: none

## Context

Context assembly exists in three technologies and has already drifted:

- Python hooks: `templates/shared-hooks/*.py` (~2,945 lines).
- OpenCode JS plugins and libraries: ~2,565 lines.
- Platform extensions: Pi (2,124 lines), OMP (1,105 lines), Snow (644 lines).
- Project-root discovery alone has eight independent implementations.

The same behaviours differ today: the JS side lacks `task_error`, the `Present:`
line, and JSONL warnings; Kiro sub-agents receive JSON instead of text; Codex
ships a `session-start.py` that is never registered.

## Decision

Three layers, enforced by CI:

```
L2 shims   harness input -> L0 event; L0 response -> harness envelope
           one file per (platform, harness major), <=120 lines, no business logic

L1 cli     argument parsing, output formatting, exit codes

L0 core    contract, context assembly, state, platform registry, mem, rules
           zero runtime dependencies, no process.cwd(), no harness SDK
```

Rules:

1. `packages/core` never imports `packages/cli` or a harness SDK.
2. `packages/cli` contains no decision logic.
3. Shims do not decide task state, select specs, compute budgets, or build
   prompts; they only translate shapes.
4. Any module that needs a project root receives it explicitly. Directory
   walking is allowed only in interactive CLI commands, never in hook paths.
5. One source produces three artifacts: npm package, single-file ESM bundle,
   native binary (B10). The bundle is what JS hosts import; the binary removes
   the runtime dependency later.

## Consequences

- Roughly 9,000 lines of duplicated implementation are deleted or reduced to
  shims.
- Hook latency becomes a first-class budget: the Python `session-start` p50 is
  87 ms today; B3 targets <120 ms through node, B10 <60 ms.
- Behaviour changes on Codex/Copilot/Kiro must be listed in
  `docs/migrations/user-visible-changes.md`.
- The layering makes contract fixtures the only cross-language source of truth.

## Alternatives rejected

- **Keep per-platform implementations**: every new platform multiplies drift.
- **Rewrite in Rust**: no additional memory-safety benefit over V8/JSC, and it
  discards the existing TypeScript assets.
- **Make Python the single core**: cannot eliminate the Python runtime and
  leaves JS hosts spawning `python3` on every model request.
