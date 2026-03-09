# Journal - taosu (Part 3)

> Continuation from `journal-2.md` (archived at ~2000 lines)
> Started: 2026-03-05

---



## Session 69: docs: improve record-session archive guidance

**Date**: 2026-03-05
**Task**: docs: improve record-session archive guidance

### Summary

(Add summary)

### Main Changes

## Summary

Updated record-session prompt across all platforms to clarify task archive judgment criteria.

## Changes

| Change | Description |
|--------|-------------|
| Archive guidance | Judge by actual work status (code committed, PR created), not task.json status field |
| Coverage | 9 platform templates + 3 dogfooding copies (12 files total) |

## Context

From `/trellis:break-loop` analysis — root cause was implicit assumption that task.json `status` field would be up-to-date. Fix: prompt now explicitly tells AI to archive based on work completion, not status field value.


### Git Commits

| Hash | Message |
|------|---------|
| `b9a475f` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 70: Task lifecycle hooks + Linear sync

**Date**: 2026-03-05
**Task**: Task lifecycle hooks + Linear sync

### Summary

(Add summary)

### Main Changes

## What was done

| Feature | Description |
|---------|-------------|
| YAML parser enhancement | Rewrote `parse_simple_yaml` with recursive `_parse_yaml_block` for nested dict support |
| `get_hooks()` | New config.py function to read lifecycle hook commands from config.yaml |
| `_run_hooks()` | Non-blocking hook execution in task.py with `TASK_JSON_PATH` env var |
| 4 cmd integrations | after_create/start/finish/archive hooks in cmd_create/start/finish/archive |
| Linear sync hook | `linear_sync.py` with create/start/archive/sync actions via linearis CLI |
| Gitignored config | `hooks.local.json` for sensitive config (team, project, assignee map) |
| Spec updates | script-conventions.md + directory-structure.md updated with hooks code-spec |

## Key decisions

- Only pass `TASK_JSON_PATH` env var (not individual fields) — simple, universal
- Hook failures never block main operation (warn only)
- Sensitive config in gitignored `hooks.local.json`, hook script itself is public
- `sync` action for manually pushing prd.md to Linear description (not auto)

## Linear integration

- All active tasks linked to Linear issues (MIN-337~341)
- Parent task auto-linking via `_resolve_parent_linear_issue()`
- Auto-assign via ASSIGNEE_MAP in hooks.local.json

**Updated files**:
- `src/templates/trellis/scripts/common/worktree.py` — nested dict YAML parser
- `src/templates/trellis/scripts/common/config.py` — get_hooks()
- `src/templates/trellis/scripts/task.py` — _run_hooks() + 4 integrations
- `src/templates/trellis/config.yaml` — hooks example (commented)
- `.trellis/scripts/hooks/linear_sync.py` — Linear sync hook
- `.trellis/spec/backend/script-conventions.md` — hooks code-spec
- `.trellis/spec/backend/directory-structure.md` — hooks/ directory


### Git Commits

| Hash | Message |
|------|---------|
| `695a26d` | (see git log) |
| `086483a` | (see git log) |
| `9595d85` | (see git log) |
| `aab2113` | (see git log) |
| `8a5ed63` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 71: Record-session prompt fix: archive before PR

**Date**: 2026-03-05
**Task**: Record-session prompt fix: archive before PR

### Summary

Fixed record-session archive guidance across 12 platform templates — archive when code committed, don't wait for PR

### Main Changes



### Git Commits

| Hash | Message |
|------|---------|
| `44f14af` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 72: feat: --registry flag for custom spec template sources

**Date**: 2026-03-06
**Task**: feat: --registry flag for custom spec template sources

### Summary

(Add summary)

### Main Changes

## Summary

Implemented `--registry` CLI flag allowing users to download spec templates from custom remote repositories (GitHub, GitLab, Bitbucket).

## Changes

| Area | Description |
|------|-------------|
| `--registry` flag | New CLI option accepting giget-style source (e.g., `gh:myorg/myrepo/specs`) |
| `parseRegistrySource()` | Parses provider, repo, subdir, ref; builds raw URL for index.json probe |
| `probeRegistryIndex()` | Distinguishes 404 (no index.json → direct download) from transient errors (abort) |
| Marketplace mode | Custom registry with `index.json` → show picker with templates |
| Direct download mode | Custom registry without `index.json` → download directory to `.trellis/spec/` |
| Custom picker | "custom" option in template picker with back/return support |
| `-y` mode | Probes index.json; aborts if marketplace (requires `--template`); direct download if 404 |
| `--template` path | Uses `probeRegistryIndex` in `downloadTemplateById` to report real errors |
| Spec updates | 5 new patterns/mistakes in error-handling.md, quality-guidelines.md, cross-layer guide |
| Tests | 11 new tests for `parseRegistrySource` (gh/gitlab/bitbucket/refs/errors) |

## Bug Fixes (8 bugs found across 3 code review rounds)

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 1 | P1 | `-y --registry` skipped index.json probe | Added probe in -y path |
| 2 | P1 | `#ref` dropped in giget source | Include `#ref` in constructed URI |
| 3 | P2 | 404 vs transient error indistinguishable | Added `probeRegistryIndex()` |
| 4 | P2 | Custom picker skipped overwrite prompt | Added prompt after marketplace selection |
| 5 | P1 | giget URI `#ref` in wrong position | Build full `provider:repo/path#ref`, pass null to downloadWithStrategy |
| 6 | P2 | Transient errors fell through to direct download | Abort instead of warn+continue |
| 7 | P2 | `fetchedTemplates` not reset on source switch | Reset to `[]` when entering custom path |
| 8 | P2 | `--registry --template` swallowed network errors | `downloadTemplateById` uses `probeRegistryIndex` for registry path |

**Updated Files**:
- `src/utils/template-fetcher.ts` — parseRegistrySource, probeRegistryIndex, downloadTemplateById, downloadRegistryDirect
- `src/commands/init.ts` — registry integration, custom picker, -y mode probe
- `src/cli/index.ts` — --registry option
- `test/utils/template-fetcher.test.ts` — 11 new tests
- `.trellis/spec/backend/error-handling.md` — Pattern 5, Mistakes 3-4
- `.trellis/spec/backend/quality-guidelines.md` — 4 new patterns/conventions
- `.trellis/spec/guides/cross-layer-thinking-guide.md` — Mode-Detection Probe Checklist


### Git Commits

| Hash | Message |
|------|---------|
| `3208d64` | (see git log) |
| `d174493` | (see git log) |
| `ba66fe1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 73: v0.3.6 docs & release prep

**Date**: 2026-03-06
**Task**: v0.3.6 docs & release prep

### Summary

(Add summary)

### Main Changes

## Summary

Prepared v0.3.6 release: migration manifest, README updates, and full docs site documentation for two new features (task lifecycle hooks and custom template registries).

## Changes

| Area | Description |
|------|-------------|
| **Migration manifest** | Created `src/migrations/manifests/0.3.6.json` covering 4 changes: --registry flag, lifecycle hooks, subtask support, record-session improvements |
| **README** | Updated What's New in both `README.md` and `README_CN.md` with v0.3.5 entry; updated changelog links |
| **Docs: v0.3.5 changelog** | Created `changelog/v0.3.5.mdx` (en + zh) — hotfix-only content; updated `docs.json` nav |
| **Docs: lifecycle hooks** | Added section 6.6 to `ch06-task-management.mdx` (en + zh) — config.yaml format, 4 events, env vars, Linear sync example |
| **Docs: remote spec templates** | Added section 2.5 to `ch02-quick-start.mdx` (en + zh) — marketplace, --registry flag, provider table, strategy flags, custom marketplace |
| **Lint fix** | Added `<!-- markdownlint-disable MD024 MD001 -->` to ch02 files (pre-existing issue from Tabs bash comments) |

## Key Decisions

- v0.3.5 is hotfix-only; hooks/registry/subtasks are v0.3.6 features
- Docs task tracked in docs repo (not Trellis repo)
- Archived tmux-support task and cancelled Linear issue MIN-340

## Repos Touched

- **Trellis**: 2 commits (manifest + README)
- **docs**: 3 commits (changelog + ch06 hooks + ch02 registry)


### Git Commits

| Hash | Message |
|------|---------|
| `6d89ee9` | (see git log) |
| `bf9d210` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 74: Hotfix: PreToolUse hook Task→Agent rename

**Date**: 2026-03-06
**Task**: Hotfix: PreToolUse hook Task→Agent rename

### Summary

(Add summary)

### Main Changes

## Summary

发现并修复 CC v2.1.63 将 Task 工具改名为 Agent 导致 Trellis PreToolUse context injection hook 全面失效的问题。

## Root Cause

CC v2.1.63 将内部 Agent 工具从 `Task` 改名为 `Agent`（[anthropics/claude-code#29677](https://github.com/anthropics/claude-code/issues/29677)）。settings.json matcher 做了向后兼容（`"Task"` 仍能匹配），但 hook 脚本收到的 `tool_name` 变成了 `"Agent"`，导致 `if tool_name != "Task": sys.exit(0)` 直接退出。

**影响**：所有 CC v2.1.63+ 的 Trellis 用户，implement/check/debug/research agent 的 code-spec context 注入全部失效。

## Investigation

- 通过 debug log 确认 hook 实际收到 `tool_name=Agent`
- Exa 调研找到 CC issue #29677 精确描述了这个 undocumented breaking change
- 确认 iFlow 未证实有相同改名，settings.json 不改但 hook 脚本做防御性兼容

## Fix

| File | Change |
|------|--------|
| `src/templates/claude/hooks/inject-subagent-context.py` | `"Task"` → `("Task", "Agent")` |
| `src/templates/claude/settings.json` | 新增 `"Agent"` matcher |
| `src/templates/iflow/hooks/inject-subagent-context.py` | `("Task", "Agent")` 防御性兼容 |
| `.claude/` 本地文件 | 同步修复 |

## Verification

- Explore agent: 无 hook error，正常跳过
- research agent: 成功收到注入 context（"Research Agent Task"、"Project Spec Directory Structure" 等）
- 410 tests 全过

## Other Work

- 创建了 v0.3.7 parent task 和 hook-start-equiv 子任务
- 调研了 SessionStart hook vs `/trellis:start` 等效性问题


### Git Commits

| Hash | Message |
|------|---------|
| `8cd1314` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 75: Monorepo Restructuring — CLI to packages/cli + docs submodule

**Date**: 2026-03-09
**Task**: Monorepo Restructuring — CLI to packages/cli + docs submodule

### Summary

(Add summary)

### Main Changes

## Summary

Restructured Trellis repo as a monorepo: moved CLI code to `packages/cli/`, added `mindfold-ai/docs` as git submodule at `docs-site/`.

## Changes

| Area | Change |
|------|--------|
| **Repo structure** | `src/`, `test/`, `bin/`, `scripts/`, configs → `packages/cli/` via `git mv` |
| **Root package.json** | New private workspace root with husky + lint-staged |
| **pnpm-workspace** | `packages: ["packages/*"]` |
| **CI/CD** | `ci.yml` + `publish.yml` adapted for `packages/cli/` paths + path filters |
| **Submodule** | `docs-site/` → `mindfold-ai/docs` |
| **Cleanup** | `docs/` removed (6 md files), `doc/` + `third/` local-only deleted |
| **GitHub** | Issue templates (bug, feature, question) + labels (`pkg:cli`, `pkg:docs`, `infra`) |
| **lint-staged** | Fixed `eslint`/`prettier` spawn issue with `pnpm --filter` |
| **linear_sync.py** | `cmd_start` now auto-calls `cmd_sync` to push PRD to Linear |

## Key Decisions

- `assets/` stays at root (README references)
- `pyrightconfig.json` + `.lintstagedrc` stay at root (cross-package scope)
- `docs-site/` at root, NOT under `packages/` (avoid pnpm workspace conflict)
- git history: `git mv` for rename detection (simple + safe)
- npm publish: `prepublishOnly` copies `README.md` + `LICENSE` from root

## Subtask Created

- `03-09-monorepo-spec-adapt` — Reorganize `.trellis/spec/` by package name (`cli/backend/` instead of flat `backend/`)

## Verification

- 410 tests passed (25 files)
- Build + lint-staged + eslint + prettier all pass
- `pnpm test` from root correctly filters to CLI package


### Git Commits

| Hash | Message |
|------|---------|
| `320c303` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
