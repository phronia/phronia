# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-fork-baseline.md) | Fork baseline and verification harness | accepted |
| [0002](0002-naming-and-migration.md) | Naming migration and upstream adoption | accepted |
| [0003](0003-layered-architecture.md) | Layered architecture: core / cli / shims | accepted |
| [0004](0004-contract-and-failure-policy.md) | Context contract and failure policy | accepted |
| [0005](0005-platform-model-and-quality.md) | Capability matrix, version axis, quality model | accepted |
| [0006](0006-batch-roadmap.md) | Batch roadmap and gates | accepted |

## Template

```markdown
# ADR-NNNN: <title>

- Status: proposed | accepted | superseded
- Date: YYYY-MM-DD
- Deciders: <names>
- Supersedes: <ADR id>

## Context

## Options

## Decision

## Consequences
```

## Rules

- One decision per ADR. Do not append new decisions to an accepted ADR; supersede it.
- Every ADR cites source evidence (file:line) when it describes existing behaviour.
- Accepted ADRs are binding for implementation. Deviating requires a new ADR.
