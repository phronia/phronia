# ADR-0005: Capability matrix, harness version axis, and quality model

- Status: accepted
- Date: 2026-10-21
- Deciders: architecture
- Supersedes: none

## Context

`AI_TOOLS` answers platform questions with three booleans: `agentCapable`,
`hasHooks`, `hasPythonHooks` (`packages/cli/src/types/ai-tools.ts:118-127`).
They cannot express:

- which mechanism implements each runtime behaviour (hook, plugin, extension,
  config, prelude, env file, tool prefix);
- that a platform has a session hook but no per-turn hook (Cursor) or a
  per-turn hook but no session hook (Codex);
- environment capabilities (`gitRepo`, `gitRemote`, symlinks);
- loop control (`none | hooks | full`), which gates dsh-style `loopControl:
  full` enforcement;
- harness version: `collectOpenCodeTemplates()` is a static file set, and no
  version probe exists anywhere in the repository.

## Decision

1. Replace the booleans with an explicit matrix:
   ```ts
   behavior: {
     sessionStart, subagentContext, workflowState, shellIdentity, agentDefinitions
   }
   environment: { gitRepo, gitRemote, symlinks }
   loopControl: "none" | "hooks" | "full"
   ```
   Every platform declares all five behaviours; `none` must carry a reason.
2. Collapse `AITool`, `TemplateDir`, and `CliFlag` into one `PLATFORM_IDS`
   constant with derived types.
3. Adapter identity is `(platform, harnessVersion, adapterId, shimVersion)`.
   Version detection is a pipeline: config pin → CLI probe → runtime
   handshake → recorded manifest → unknown. Unknown never guesses; it degrades
   to a labelled fallback.
4. `phronia platforms --matrix` prints the matrix; `--check` enforces
   invariants in CI.
5. Quality gates:
   - unit tests;
   - contract fixtures per platform × harness version;
   - golden parity between legacy Python and new TS;
   - idempotent dogfood regeneration;
   - hook cold-start budget;
   - per-rule verdicts (B9).

## Consequences

- Adding a platform becomes: add `PLATFORM_IDS`, add registry entry, add
  template directory; everything else is derived.
- An unknown harness version is explicitly `degraded` and visible in `doctor`,
  never a silent no-op.
- The matrix is the single place where "does this platform support X" is
  answered; features declare their capability requirements
  (`packages/core/src/platform/features.ts`).

## Alternatives rejected

- **Keep booleans and add more**: every new dimension multiplies flags, and
  semantics stay implicit.
- **Probe only at runtime**: users discover breakage in a session instead of
  during `init`/`update`/`doctor`.
- **Pin adapters to exact versions**: harness patch releases would force
  Phronia releases; semver ranges plus a handshake are enough.
