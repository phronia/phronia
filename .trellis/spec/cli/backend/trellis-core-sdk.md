# Trellis Core SDK

> Package boundary and coding rules for `@mindfoldhq/trellis-core` and the CLI.

---

## Overview

Trellis is split into two version-locked packages:

| Package | Responsibility |
|---|---|
| `@mindfoldhq/trellis-core` | Reusable domain logic, storage primitives, reducers, task APIs, channel APIs, and typed contracts. |
| `@mindfoldhq/trellis` | CLI argument parsing, terminal rendering, command wiring, process exit behavior, template installation, migrations, and release scripts. |

The CLI should be a thin shell around core where a capability needs to be shared with other integrations. The core package must stay independent of terminal UX and CLI process control.

---

## Package boundary

Core owns:

- channel storage and event append/read helpers
- channel and thread state reducers
- task record helpers that are useful outside the CLI
- structured types shared by CLI, tests, and future SDK consumers
- pure validation and normalization logic that should not depend on Commander or Chalk

CLI owns:

- command definitions and option parsing
- help text and terminal output
- prompts, confirmations, exit codes, and `process.exit`
- template copying, dogfooding paths, migration manifest application, and update UX
- release scripts and CI-specific package orchestration

When logic starts in the CLI but is needed by another package or embedding app, move the reusable part into core and leave only CLI rendering and option translation in the CLI package.

---

## Import rules

CLI code must import core through public exports:

```ts
import { createChannelStore } from "@mindfoldhq/trellis-core/channel";
```

Do not deep-import core internals:

```ts
// forbidden
import { parseEvent } from "../../core/src/channel/internal/parse-event";
```

Core public exports must be declared explicitly in `packages/core/package.json`. Do not expose wildcard internal paths. Export entries should provide `types`, `import`, and `default` targets.

---

## Core API design

Core APIs return structured values and throw typed, domain-specific errors when callers need to handle failures.

Core APIs must not:

- call `process.exit`
- print terminal output
- depend on Chalk, Commander, Inquirer, or CLI-only helpers
- read CLI argv directly
- assume the current working directory unless the API contract says so

Prefer small composable functions over one function that parses options, mutates storage, and formats output. The CLI can compose the pieces for user-facing commands.

---

## Storage and state

State transitions should have one owner.

For channel and thread work:

- event file format belongs to core
- event append and sequence allocation belong to core
- reducers that compute channel/thread summaries belong to core
- CLI commands call core APIs and render results

Do not duplicate `lastSeq`, event classification, linked context parsing, or thread status rules across command files. Add a core helper instead, then use it from the CLI.

---

## Build and typecheck contract

Fresh checkouts do not have `packages/core/dist`. The root `typecheck` script must build core before checking the CLI so TypeScript can resolve core declarations.

Required order:

```bash
pnpm --filter @mindfoldhq/trellis-core build
pnpm --filter @mindfoldhq/trellis typecheck
```

The release and CI flows must keep this order. A CLI typecheck that only works after a developer has previously built core locally is invalid.

---

## Versioning contract

Core and CLI always publish together with the exact same version.

During development:

- CLI depends on core with `workspace:*`.
- Core and CLI can be tested independently.

During release:

- `bump-versions.js` updates both package versions together.
- `verify-packed-cli` confirms pnpm rewrote `workspace:*` to the exact release version in the packed CLI artifact.
- CI publishes core first, then CLI.
- CI verifies both packages are visible on public npm.

Release/versioning details live in `release-process.md`.

---

## Tests

Core behavior should be tested in `packages/core` when the behavior can run without CLI rendering. CLI tests should cover option parsing, terminal output, command orchestration, and integration with template/migration flows.

If a CLI test duplicates a pure core test, move the pure assertion to core and keep only the CLI-specific behavior in the CLI test.
