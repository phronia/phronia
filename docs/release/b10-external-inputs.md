# B10 prerequisites (binary distribution)

B10 is deferred in this round. It cannot be completed from the repository
alone: every remaining task needs credentials, accounts, or signing material
that only the maintainer can supply. This file is the exact checklist.

## A. npm / release channel

| Input | Needed for | Notes |
|---|---|---|
| `@phronia` npm org and publish rights | `@phronia/cli`, platform packages | scope must match `package.json` |
| `NPM_TOKEN` (automation, 2FA-bypass) in CI secrets | `release.yml` publish step | rotate after first publish |
| GitHub organization/repository and Actions release permission | binaries attached to releases | `contents: write` |
| Decision: package names and version cadence | `@phronia/cli-darwin-arm64` etc. | must match `optionalDependencies` |
| Signing key or admin policy for `phronia`/`trellis` bin aliases | single-major legacy aliases | already implemented in source |

## B. macOS

| Input | Needed for |
|---|---|
| Apple Developer Program membership | notarization |
| Developer ID Application certificate + private key (`.p12`) | signing |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in CI secrets | `xcrun notarytool` |
| Decision on hardened runtime entitlements | Gatekeeper acceptance |

## C. Windows

| Input | Needed for |
|---|---|
| Code-signing certificate (EV or standard) + password | Authenticode |
| `signtool.exe` on the CI runner | signing |
| Timestamp server URL | signature validity after cert expiry |
| Decision: ship unsigned with a documented warning if no cert | release fallback |

## D. Build toolchain

| Input | Needed for |
|---|---|
| Bun (pinned version) in CI | cross-compiling the single binary |
| Runners: macOS arm64/x64, Linux x64/arm64, Windows x64 | platform matrix |
| Decision on libc target (glibc vs musl) | Linux package split |
| SHA-256 checksum publication | download verification |
| `SOURCE_DATE_EPOCH` / reproducible-build policy | byte-identical artifacts |

## E. Optional distribution surfaces

- Homebrew tap (`homebrew-phronia`) and a tap-scoped GitHub token.
- Scoop / winget manifests and their review processes.
- A download page under `phronia.dev` (domain/DNS).

## What can proceed without these

- Source-level packaging scripts and CI matrix definitions can be reviewed in
  a draft PR, but cannot be merged as a working release path.
- The "hooks stop invoking Python" half of B10 depends on the binary being
  present; switching hooks to `node` before the binary exists would add a Node
  runtime requirement without removing Python.

## Current decision

**B10 is code-complete and release is deferred by decision (ADR-0014, accepted 2026-10-21).** `bun build
--compile` produces all five targets on this machine; the binary embeds the
templates, extracts them to a cache directory, and runs `--version` and
`context session-start` successfully. `packages/runtime/scripts/package-npm.mjs`
stages the five platform packages and the main package with
`optionalDependencies` populated. What remains is exactly section A and
B/C: credentials to sign, notarize, and publish. Re-open B10 when those are
supplied. Until then the release is explicitly deferred, not silently
incomplete.
