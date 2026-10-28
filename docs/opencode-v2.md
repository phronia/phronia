# OpenCode v2 支持

Phronia ships two OpenCode adapter shards:

| Adapter | Harness range | Local plugin | Identity |
|---|---|---|---|
| `opencode@v1` | `>=1.0.0 <2.0.0` | `.opencode/plugins/{session-start,inject-workflow-state,inject-subagent-context}.js` | plugin command prefix (`PHRONIA_CONTEXT_ID`) |
| `opencode@v2` | `>=2.0.0 <3.0.0` | `.opencode/plugins/phronia.js` | host `OPENCODE_SESSION_ID` + shell `PHRONIA_HOST` |

Both shards share the same `agents/`, `commands/`, and `skills/` files. Only the
plugin shard and its `package.json` differ.

## How the adapter is chosen

`phronia init` and `phronia update` probe `opencode --version` and select the
matching shard. The precedence is:

1. `platforms.opencode.adapter` in `.phronia/config.yaml`
2. a successful version probe
3. the adapter recorded in `.phronia/manifest.json` (used when this machine has
   no OpenCode binary, so a shared repo is not rewritten)
4. `opencode@v1` fallback

`phronia doctor` reports the selected adapter, the detected version, and the
last runtime handshake. A missing handshake on v2 means the plugin has not run
yet or is disabled — not that the adapter is invalid.

## Upgrade from v1

1. Upgrade the OpenCode CLI to 2.x.
2. Run `phronia update`.
3. Run `phronia doctor` and confirm `opencode@v2` plus a handshake after the
   first OpenCode prompt.

`phronia update` removes the three v1 plugin files and `.opencode/lib/` only
when they still match their tracked hashes. A file you edited is kept and
reported. `.opencode/package.json` is kept on disk (v2 does not need it, but
another local plugin may still resolve through it) and is no longer tracked by
Phronia.

If the update runs on a machine without OpenCode installed, the recorded
adapter is kept, so a v2 shard in a shared repo is not downgraded.

## Rollback to v1

```yaml
# .phronia/config.yaml
platforms:
  opencode:
    adapter: opencode@v1
```

Then run `phronia update` and restart OpenCode. The pin is preserved by every
later update, including `--force`; remove it to follow the installed version
again.

## Mixed harness use

OpenCode v2 and ZCode (or any other configured harness) can coexist in one
project. Each platform has its own config directory, handshake file, adapter
record, and session keys. The shared `.phronia/` state (tasks, spec, journal)
is the same.

Switching harnesses does **not** automatically carry the per-session active
task pointer. In the new harness, run `/phronia:continue` or
`python3 ./.phronia/scripts/task.py start <task>` once. This is the existing
multi-window isolation contract; Phronia does not infer task ownership across
sessions.

Identity lookup is host-scoped: the v2 shim sets `PHRONIA_HOST=opencode` for
shell children, and `OPENCODE_SESSION_ID` is read only when the host is
OpenCode. A ZCode shell launched from an OpenCode shell therefore cannot borrow
the parent's session.

## Known limitation

A single `.opencode/plugins/` directory cannot serve v1 and v2 on different
machines at the same time. If a shared repo is opened by both a v1 machine and
a v2 machine, each update switches the shard to the local version. Pin the
adapter (which then requires that harness generation on every machine) or keep
separate checkouts.
