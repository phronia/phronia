# Design: Event-driven spec-injection reset

## Decision

Reuse the existing `inject-spec-context.py` hook for two inputs:

1. `PostToolUse(Read|Edit|Write|MultiEdit)` keeps the current match, decision,
   rendering, and emission flow.
2. `SessionStart(clear|compact)` appends one reset marker and exits without
   stdout.

This is the smallest root-cause fix: Claude tells us when context was reset, so
the feature records that fact instead of reconstructing it from undocumented
transcript records. No new hook file, event abstraction, dependency, or
provider layer is required.

## Hook registration

The existing settings shape becomes:

```text
SessionStart(startup)
  └─ session-start.py

SessionStart(clear)
  ├─ session-start.py
  └─ inject-spec-context.py

SessionStart(compact)
  ├─ session-start.py
  └─ inject-spec-context.py
```

`SessionStart(source=compact)` is used instead of `PreCompact`: it reports a
completed reset, while `PreCompact` runs before compaction. `PostCompact` is
not additionally registered because the existing `SessionStart(compact)`
surface already represents the same successful transition; two event sources
would only add duplicate reset markers.

## Event dispatch

`inject-spec-context.py` parses stdin once, then dispatches before requiring
tool fields:

```python
if hook_event_name == "SessionStart":
    if source in ("clear", "compact"):
        record_reset(...)
    return 0

handle_post_tool_use(...)
```

The reset path applies the same kill switches, repository discovery, spec
directory check, and `spec_injection.enabled` gate as the injection path. It
never matches specs or renders context.

## Identity

Resolve the base identity once, then append the existing subagent suffix only
for emission history:

```python
resolve_base_identity(root, payload) -> tuple[str, bool]
identity = base_identity + optional_agent_suffix
```

The base identity uses the current shared context-key resolver and current
payload-only fallbacks. The existing sanitized `+a-<agent_id>` suffix applies
to emission history only.

Consequences:

- Parent state: `<base>.jsonl`
- Subagent state: `<base>+a-<agent>.jsonl`
- Reset state: a reset record in `<base>.jsonl`

This keeps histories separate without creating another file type. A subagent
reads the latest reset marker from the base shard before reading its own shard.
A newly created subagent has no history and therefore emits FULL normally.

## State schema

Keep `STATE_VERSION = 2`.

Reset record:

```json
{"v":2,"reset":"<uuid4 hex>","ts":123.0}
```

Emission record:

```json
{
  "v": 2,
  "spec": ".trellis/spec/cli/backend/example.md",
  "sha256": "<64 hex>",
  "mode": "full",
  "ts": 123.0,
  "reset": "<latest uuid4 hex>"
}
```

`complete: false` keeps its existing optional behavior for a truncated FULL.
`reset` may be absent when no reset has been recorded or when reading an old
version-2 line.

`load_state` returns both the newest emission per spec and the last valid reset
identifier encountered in append order. A read error is distinguishable from a
valid empty shard so the caller can enter stateless mode. Malformed and
foreign-version lines remain skippable.

The base shard is reused because it already has append-only writes, best-effort
locking, safe filenames, per-project isolation, garbage collection, and a
circuit breaker. UUID comparison avoids wall-clock ordering and filesystem
timestamp precision issues.

## Injection flow and locking

Parent event:

1. Open and lock `<base>.jsonl`.
2. Load emission state and latest reset identifier.
3. Decide, emit, and append records with that reset identifier.
4. Unlock and close.

Subagent event:

1. Open and lock `<base>.jsonl`; read the latest reset identifier; unlock and
   close.
2. Open and lock `<base>+a-<agent>.jsonl`.
3. Load subagent emission state, decide, emit, and append records with the base
   reset identifier.
4. Unlock and close.

Reset event:

1. Open and lock `<base>.jsonl`.
2. Append one reset record with a new UUID.
3. Unlock and close.

The reset shard is always locked before an emission shard and is released
before a distinct subagent shard is opened, so there is no two-lock deadlock.
If a reset races after a subagent snapshot, the emission carries the older
identifier and the next touch sees the mismatch and reinjects FULL. Lifecycle
hooks are normally ordered, and the race still fails toward reinjection.

If the base shard cannot be opened or read, the tool event uses the existing
stateless ticket-only path; it does not consult a potentially stale subagent
history.

## Decision engine

Delete transcript scanning, beat selection, boundary counting, and the
turn-based window. The per-spec decision order becomes:

```text
stateless                         → TICKET
no prior emission                → FULL
content hash changed             → FULL
current reset != emission reset  → FULL
inside refresh_window_seconds    → SILENT
prior FULL was incomplete        → FULL
otherwise                        → TICKET
```

The current timestamp is the only clock input. A negative wall-clock delta
remains past-window, preserving the existing safe-side behavior.

Emission records store the reset identifier used by the decision. A FULL after
a reset therefore consumes that reset for that spec; later touches return to
the ordinary time window.

## Removed surface

- `TRANSCRIPT_MAX_BYTES`
- transcript JSON prefilters and parsers
- `scan_transcript`
- `select_beats`
- `clock_transcript_path`
- undocumented subagent transcript-path validation
- `refresh_window_turns`
- `turns` and `boundaries` state fields
- transcript-specific tests and current documentation claims

The `transcript_path` payload string remains only in the existing identity
fallback. The hook never opens it.

## Compatibility

- Version-2 emission records remain valid. Before any reset they use the
  wall-clock window exactly like new records.
- After a reset, a legacy line has no matching reset identifier and emits FULL.
- Unknown old config key `refresh_window_turns` becomes inert when the parser
  stops reading it. PR #468 is not released, so no migration warning is added.
- Payload XML, hashes, character budgets, matching order, and state directory
  layout remain unchanged.

## Failure behavior

| Failure | Behavior |
|---|---|
| Reset event lacks stable identity | Exit zero, warn on stderr, record nothing |
| Base shard unavailable on reset | Exit zero, warn on stderr |
| Base shard unavailable on tool event | Stateless ticket-only |
| Malformed reset/state line | Ignore line; never suppress an injection |
| Duplicate reset event | New marker; possible extra FULL, never missed FULL |
| Hook exception | Top-level exit zero |

## Alternatives rejected

- **Keep transcript parsing as fallback:** retains the unsupported dependency
  this task removes.
- **Use `PreCompact`:** can record a reset before a compaction that does not
  complete.
- **Register `PostCompact` too:** duplicates the already registered
  post-compaction `SessionStart(compact)` signal.
- **Add a dedicated reset hook:** duplicates identity, state, locking, config,
  and failure handling already present in `inject-spec-context.py`.
- **Use timestamps as reset generations:** sensitive to clock skew and
  timestamp precision; UUID equality is equally small and more reliable.
