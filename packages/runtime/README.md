# @phronia/runtime

Packaging only: no business logic. The CLI and context pipeline live in
`@phronia/cli` and `@phronia/core`.

## Artifacts

- `dist/phronia.mjs` — JS fallback launcher over the installed `@phronia/cli`
  dist (the CLI reads template files from disk; a true standalone bundle needs
  asset embedding and is part of the deferred binary work).
- `dist/phronia-<platform>` — native binaries (Bun preferred, Deno fallback).
- `bin/phronia.js` — npm launcher resolution order:
  1. `PHRONIA_BINARY`
  2. `@phronia/cli-<platform>/bin/phronia`
  3. `dist/phronia-<platform>`
  4. `dist/phronia.mjs`
  5. explicit error listing the attempted paths

## Local build

```bash
pnpm --filter @phronia/runtime build:bundle # writes the launcher
pnpm --filter @phronia/runtime build:binary # requires Bun or Deno
```

## Release blockers

Binaries and npm publishing need the credentials in
`docs/release/b10-external-inputs.md`: npm org token, Apple notarization
material, a Windows signing certificate, and the cross-compile runner matrix.
The scripts fail loudly when a toolchain is missing rather than producing an
unsigned artifact under the same name.
