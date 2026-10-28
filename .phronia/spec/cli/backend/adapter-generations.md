# Adapter Generations

Harness API generations (for example `opencode@v1` → `opencode@v2`) are a
first-class axis. A platform is a product; an adapter is one generation of that
product's plugin/hook API.

## 1. Scope / Trigger

Read this spec when a harness changes its plugin or hook contract, or when
adding a second generation to an existing platform. It covers the core adapter
registry, capability matrix, context contract, template shards, and the
init/update/doctor lifecycle.

OpenCode is the reference implementation: v1 uses
`experimental.chat.messages.transform` and a command-prefix identity; v2 uses
`session.hook("context")`, `tool.hook("execute.before")`, and
`OPENCODE_SESSION_ID`.

## 2. Signatures

Core (`packages/core/src/platform`):

```ts
selectAdapter(input: {
  platform: PlatformId;
  detection: DetectionResult;
  pin?: string | null;
  recorded?: string | null;
}): AdapterSelection;

adapterForRuntime(platform: PlatformId, adapterId?: string | null): HarnessAdapter;
capabilitiesFor(platform: PlatformId, adapterId?: string | null): AdapterCapabilityProfile;
```

CLI (`packages/cli/src`):

```ts
resolveAdapter(cwd: string, platform: PlatformId, options?: { probe?: boolean }): ResolvedAdapter;
collectPlatformTemplates(platformId: AITool, options?: { adapterId?: string }): Map<string, string> | undefined;
collectOpenCodeTemplates(adapterId?: string | OpenCodeTemplateOptions): Map<string, string>;
openCodeShardOwnedPaths(adapterId: OpenCodeAdapterId): readonly string[];
reconcileOpenCodeAdapter(cwd: string, adapterId: OpenCodeAdapterId, desired: ReadonlySet<string>): AdapterReconcileResult;
```

CLI surface: `phronia context --adapter <id>`.

## 3. Contracts

**Adapter identity**

- id: `<platform>@v<major>`; `harnessRange` is a semver range (`>=2.0.0 <3.0.0`).
- `envelopes` names what the shim can emit; `handshake()` reports
  `{ adapterId, apiVersion, supportedEvents }`.
- Capability overrides are keyed by adapter id. A platform without an override
  keeps its historical profile.

**Selection precedence**

```
config pin
  > successful probe + semver match
  > manifest.platforms.<id>.adapterId   (machine-local; only when probe is unavailable)
  > installed shard inferred from .template-hashes.json
  > fallback (opencode: v1, degraded)
```

A successful probe must beat a recorded value; otherwise upgrading the harness
keeps writing the old generation. Recorded/inferred values only exist to keep a
shared repo stable when the harness binary is absent (CI, fresh clone, another
machine).

**Context request**

- `platform.adapterId` drives tool-name normalization and the handshake.
- `hints.toolName`, `hints.agentType`, `hints.prompt`, `hints.sessionId`,
  `hints.taskRef`, `hints.filePath` are the transport-neutral fields shims fill.
- `phronia context` writes the handshake with
  `request.platform.adapterId ?? adapterForRuntime(platform).id`.

**Templates**

```
templates/opencode/
  base/agents/...              # generation-independent
  adapters/v1/{plugins,lib,package.json}
  adapters/v2/plugin.js        # built into _generated/shims/v2/phronia.js
```

A shard declares the project paths it owns. `update` removes a retired shard
file only when it is owned, tracked, and still byte-identical to its hash.
Modified files are kept and reported. `.opencode/package.json` is kept on disk
and unmanaged on v2.

**Identity**

- Shims set `PHRONIA_HOST` for shell children. Identity lookup reads that host's
  env entries only, so a nested harness cannot borrow the parent's session.
- OpenCode v2 shell children have `OPENCODE_SESSION_ID`; v1 has no verified env
  name and uses the shim's command prefix.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| pin names an unknown/wrong-platform adapter | `unsupported`, no silent fallback |
| probe detects a version no adapter matches | `unsupported` |
| probe unavailable, manifest recorded | use recorded adapter, `ok` |
| probe unavailable, no manifest, tracked v2 shard | infer `opencode@v2`, `ok` |
| probe unavailable, no recorded/inferred | fallback v1, `degraded` |
| selected shard artifact missing | throw `run pnpm build:shims` |
| retired shard file user-modified | keep file + warn, keep hash |
| v1 shard present on a v2 host | plugin load fails; `update` is required |

## 5. Good / Base / Bad Cases

- **Good**: a CI runner with no OpenCode binary, a committed v2 shard, and no
  manifest infers `opencode@v2` from the tracked hash; `update --dry-run` is clean.
- **Base**: a v1 project on a v1 machine keeps v1; upgrading the harness to v2
  then running `update` swaps the shard and removes the v1 files.
- **Bad**: `runtimeAdapter()` hard-codes the first shard, so a v2 shim writes a
  v1 handshake; or a blanket directory replace deletes user-modified inline
  plugins.

## 6. Tests Required

- adapter selection precedence: pin, detected, recorded, installed inference,
  fallback (`core/test/platform/adapter.test.ts`, `cli/test/platform/selection.test.ts`).
- capability profile differences (`core/test/platform/capabilities.test.ts`).
- template composition: base appears once, shard paths do not overlap
  (`cli/test/configurators/opencode-adapters.test.ts`).
- reconciliation: unmodified removed, modified kept, idempotent second switch.
- v2 contract replay with `--adapter` (`testing/test/contract.test.ts`).
- dogfood idempotence on a runner without the harness.

## 7. Wrong vs Correct

**Wrong**: silently reusing the v1 shard when the harness reports 2.x.

```ts
const adapter = adaptersFor(platform)[0]; // always v1
```

**Correct**: resolve the generation and make the handshake prove it.

```ts
const adapter = request.platform.adapterId
  ? adapterForRuntime(platform, request.platform.adapterId)
  : adapterForRuntime(platform);
```

**Wrong**: switching shards with `git add -A` / deleting the whole plugin dir.

**Correct**: `reconcileAdapterFiles` with owned paths, tracked hashes, and a
protected-path allowlist.

## Adding a New Generation

1. Add an adapter entry (`harnessRange`, `envelopes`; no `unsupported`).
2. Add a capability override (`behavior`, `toolNames`, `evidence`).
3. Add `adapters/vN/` and a `build-shims.mjs` shard entry.
4. Add owned paths to the configurator.
5. Add a contract fixture and replay it with `--adapter`.
6. Update `docs/platform-matrix.md` and the user-facing upgrade/rollback doc.
7. Test: selection, composition, reconciliation, handshake adapterId, and the
   no-harness CI path.
