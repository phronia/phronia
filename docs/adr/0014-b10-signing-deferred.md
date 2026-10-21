# ADR-0014: B10 signing/publishing is deferred pending credentials

- Status: proposed (requires maintainer confirmation)
- Date: 2026-10-21
- Deciders: maintainer
- Supersedes: none

## Context

B10 is code-complete in this repository:

- `packages/runtime` embeds templates/migrations, self-extracts them, and
  imports the CLI.
- Bun cross-compiles all five targets on this machine:
  `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win-x64`.
- The darwin-arm64 binary runs `--version` and `context session-start`.
- `package-npm` stages `@phronia/cli` plus five platform packages with
  `optionalDependencies` populated.
- The release workflow builds all targets and uploads the staging tree.

The remaining steps cannot be performed from the repository:

- macOS signing and notarization need an Apple Developer membership, a
  Developer ID certificate, and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/
  `APPLE_TEAM_ID`.
- Windows Authenticode needs a code-signing certificate and timestamp server.
- npm publishing needs the `@phronia` org and an `NPM_TOKEN`.

No set of code changes substitutes for those credentials. Shipping unsigned
binaries under the release names would be worse than not shipping: users would
see Gatekeeper/SmartScreen failures without an explanation.

## Decision

Defer B10's signing, notarization, and npm publish until the credentials in
`docs/release/b10-external-inputs.md` are supplied. Do not delete the runtime
package, the staging script, or the release workflow; they are the tested
implementation waiting for credentials.

## Consequences

- B0–B9 and B11–B13 are complete; B10 is complete except for release signing
  and publishing.
- The JS fallback and the five unsigned binaries can be built and smoke-tested
  locally by anyone with Bun.
- On credential availability: run the release workflow, import the
  certificates, then publish the staged tree. No source changes are expected.

## Alternatives rejected

- **Publish unsigned binaries**: breaks Gatekeeper/SmartScreen and violates
  the "explicit degradation, no silent failure" rule.
- **Ad-hoc sign only**: `codesign -s -` does not satisfy Gatekeeper.
- **Delete B10 scaffolding**: loses the tested asset-extraction and staging
  work; re-doing it later is pure cost.
