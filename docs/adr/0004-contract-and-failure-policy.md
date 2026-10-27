# ADR-0004: Context contract and failure policy

- Status: accepted
- Date: 2026-10-21
- Deciders: architecture
- Supersedes: none

## Context

Hook behaviour today is implicit:

- each hook reads its own set of payload fields;
- response envelopes differ per platform (ZCode must not receive the dual-key
  shape; Kiro consumes plain text; Gemini uses `BeforeAgent`);
- failures are silent: bare `return 0`, `except: pass`, empty `[]`, a Snow hook
  that prints "context unavailable" as normal text;
- `inject-workflow-state.py` reads stdin with a 0.2 s timeout, so a slow
  payload silently drops the per-turn breadcrumb.

Without a contract, every new shim re-implements the same guesses.

## Decision

1. `phronia context` is the only context entrypoint.
2. Requests and responses carry an integer `schemaVersion`; additive changes
   only, breaking changes require a new major and a migration function.
3. Core returns a neutral plan:
   - `blocks[]` ordered text blocks;
   - `mutations[]` semantic changes to tool input/prompt;
   - `effects[]` side effects the shim must perform (marker, env export,
     shell ticket);
   - `envelope` render key;
   - `diagnostics[]` and `degraded`.
4. Core performs no IO side effects; shims execute effects. This keeps the core
   importable by JS hosts without unexpected writes.
5. Every entrypoint declares a failure policy:
   - `degrade`: return a degraded payload plus diagnostics;
   - `silent-ok`: exit 0 with no output, but record a diagnostic;
   - `fail-loud`: non-zero exit and visible stderr;
   - `disabled`: user turned hooks off.
6. Silent failure is forbidden. A missing project root, unknown schema, or
   unsupported adapter must be visible in `phronia doctor`.
7. Root resolution is explicit and single: CLI `--project-root`, then payload
   fields, then platform env, then `PHRONIA_PROJECT_ROOT`. No upward search.

## Envelope table (initial)

| Platform | session-start | user-prompt | subagent |
|---|---|---|---|
| Most hook platforms | dual key (`hookSpecificOutput.additionalContext` + `additional_context`) | `UserPromptSubmit` | PreToolUse with all compatible keys |
| ZCode | nested key only | nested key only | nested key only |
| Kiro | plain text | plain text | plain text |
| Gemini | hook envelope | `BeforeAgent` | — |
| Codex | not registered | `UserPromptSubmit` (`inline` variant) | `SubagentStart` |
| OpenCode | synthetic message part | synthetic message part | in-place `args.prompt` mutation |

## Consequences

- Every shim becomes a translator of at most ~120 lines.
- Contract fixtures can assert both the neutral plan and the rendered envelope.
- The Kiro sub-agent bug is fixed as part of the migration; Codex/Copilot gain
  the first-reply notice and update hint, which must be logged as user-visible
  changes.
- Per-turn latency has a budget: B3 p95 <60 ms for `user-prompt`.

## Alternatives rejected

- **Let each shim produce the final envelope from raw state**: that is the
  current design and the source of the drift.
- **Core writes markers/tickets itself**: makes in-process JS imports unsafe
  and hides IO from the host.
