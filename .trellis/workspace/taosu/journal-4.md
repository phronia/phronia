# Journal - taosu (Part 4)

> Continuation from `journal-3.md` (archived at ~2000 lines)
> Started: 2026-03-13

---



## Session 102: Publish-Skill Command & Docs-Site Sync

**Date**: 2026-03-13
**Task**: Publish-Skill Command & Docs-Site Sync
**Package**: cli

### Summary

(Add summary)

### Main Changes

| Feature | Description |
|---------|-------------|
| docs-site submodule | Updated submodule ref to include cc-codex-spec-bootstrap skill pages |
| /trellis:publish-skill | New slash command automating marketplace skill → docs-site sync workflow |

**Details**:
- Created `/trellis:publish-skill` command (9-step workflow: identify skill, check existing, create EN/ZH pages, update indexes, update docs.json, commit/push docs, ensure skill on main, confirm)
- Available in both `.claude/commands/trellis/` and `.cursor/commands/`
- Committed docs-site submodule ref update from earlier skill documentation work

**Files Created**:
- `.claude/commands/trellis/publish-skill.md`
- `.cursor/commands/trellis-publish-skill.md`


### Git Commits

| Hash | Message |
|------|---------|
| `d8d7dfb` | (see git log) |
| `b93ef30` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 103: Rename empty templates to from scratch

**Date**: 2026-03-16
**Task**: Rename empty templates to from scratch
**Package**: cli

### Summary

Renamed 'empty templates' label to 'from scratch' in trellis init template picker (3 files: init.ts, create_bootstrap.py, create-bootstrap.sh). Internal value 'blank' unchanged. Onboard templates not affected (different concept).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `57a243d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 104: Decouple .agents/skills as shared layer + Codex .codex support

**Date**: 2026-03-24
**Task**: Decouple .agents/skills as shared layer + Codex .codex support
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

Major architecture change: decoupled .agents/skills/ from Codex platform into shared Agent Skills layer, added full .codex/ directory support with hooks, skills, and agents

### Main Changes

## Changes

| Area | Details |
|------|---------|
| Architecture | `.agents/skills/` decoupled from Codex, now shared (agentskills.io standard) |
| Type System | `extraManagedPaths` → `supportsAgentSkills` flag, codex `configDir` → `.codex` |
| Detection | Platform detection uses `.codex/` only, `.agents/skills/` alone ≠ codex |
| `.codex/` | New: config.toml, agents/*.toml, skills/parallel/, hooks/session-start.py, hooks.json |
| Python CLIAdapter | `config_dir_name` → `.codex`, `requires_agent_definition_file`, `supports_cli_agents` |
| Migration | Legacy Codex auto-upgrade via template-hashes, safe-file-delete for old files |
| Hooks | Codex SessionStart hook injecting full Trellis context (verified working) |
| Agent TOML | Fixed format to `name` + `description` + `developer_instructions`, renamed to convention |
| PR #112 | iFlow --agent regression fixed, workspace artifacts cleaned |
| Cleanup | Removed unused test/scripts/ Python tests |

## Key Decisions
- `.agents/skills/` = shared layer (8+ CLIs use it)
- `.codex/skills/` = Codex-specific skills (e.g. parallel with --platform codex)
- SessionStart hook requires `codex_hooks = true` feature flag
- `suppressOutput` not implemented in Codex TUI (experimental limitation)
- Migration: detect legacy by template-hashes, not directory existence (avoids false positives)

## Tests
- 516 tests pass (26 files)
- 3 rounds of Codex cross-review, all findings addressed
- lint + typecheck clean
- Python copies verified identical

## Next
- Create migration manifest for release
- Update docs-site changelog
- Release 0.4.0-beta.8


### Git Commits

| Hash | Message |
|------|---------|
| `ba75c30` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 105: StatusLine: 集成 Trellis 任务状态到 CC 状态栏

**Date**: 2026-03-26
**Task**: StatusLine: 集成 Trellis 任务状态到 CC 状态栏
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

基于推文灵感，为 Trellis 添加项目级 statusLine。读取 CC stdin JSON + Trellis 任务数据，在状态栏显示当前任务、model/ctx/branch/duration、开发者和活跃任务数。无任务时 1 行，有任务时 2 行。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9e4411c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 106: fix: self-hosted GitLab + docs ABCoder link

**Date**: 2026-03-27
**Task**: fix: self-hosted GitLab + docs ABCoder link
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

(Add summary)

### Main Changes

## What was done

1. **ABCoder link fix** — docs-site 中英文两个 mdx 文件的 ABCoder GitHub 链接从 `nicepkg/abcoder` 改为 `cloudwego/abcoder`；marketplace SKILL.md 中安装命令从 `npm install -g` 改为 `go install`
2. **Self-hosted GitLab support** — `parseRegistrySource()` 现在支持自建 GitLab 的 HTTPS/SSH URL：
   - SSH URL (`git@host:org/repo`) 自动检测公共 vs 自建
   - `ssh://` 协议（带/不带端口）
   - 未知 HTTPS 域名默认映射为 GitLab 格式
   - 公共 SSH URL（`git@github.com`）正确映射到原生 provider
   - `RegistrySource` 新增 `host` 字段，`rawBaseUrl` 和 giget 下载都指向正确 host
3. **FP Review 发现并修复 3 个边界问题** — 公共 SSH 误判为自建、`ssh://` 协议不支持
4. **Spec 更新** — `quality-guidelines.md` 新增 "User Input Parsing: Exhaustive Format Enumeration" 规则

## Key files
- `packages/cli/src/utils/template-fetcher.ts` — 核心解析逻辑
- `packages/cli/test/utils/template-fetcher.test.ts` — 22 个新测试 (534 total)
- `.trellis/spec/cli/backend/quality-guidelines.md` — 新增 spec 规则


### Git Commits

| Hash | Message |
|------|---------|
| `5e2eb10` | (see git log) |
| `ce52f48` | (see git log) |
| `137b8af` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 107: PR triage, issue fixes, marketplace submodule migration

**Date**: 2026-04-06
**Task**: PR triage, issue fixes, marketplace submodule migration
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

(Add summary)

### Main Changes

## Summary

Triaged open PRs and issues, reviewed and merged PRs, fixed bugs, and migrated marketplace to standalone repo.

## PR Reviews

| PR | Title | Action |
|----|-------|--------|
| #137 | feat(windsurf): add workflow support for Windsurf | Reviewed ✅, merged, pulled into branch |
| #143 | feat: add GitHub Copilot platform support | Reviewed, request-changes → author fixed → ready to merge |

## Issue Triage

| Issue | Title | Result |
|-------|-------|--------|
| #141 | git worktree 不支持 | Not a bug — tested worktree, hooks work fine with tracked files |
| #140 | slash commands 失效 | Noted, not investigated this session |
| #139 | memory shared across platforms? | Noted |
| #133 | record-session 不自动提交 | Root cause: Codex sandbox blocks git write. Fixed silent git-add failure |
| #113 | Python 3.9 报错 | Decision: declare min Python 3.10, added version check in init |
| #117 | marketplace 拆仓 | Done — migrated to mindfold-ai/marketplace submodule |

## Code Changes

| File | Change |
|------|--------|
| `packages/cli/src/utils/template-fetcher.ts` | Point TEMPLATE_INDEX_URL and TEMPLATE_REPO to mindfold-ai/marketplace |
| `packages/cli/src/templates/trellis/scripts/add_session.py` | Check git-add return code, show error instead of false "no changes" |
| `.trellis/scripts/add_session.py` | Same fix (dogfooded copy) |
| `packages/cli/src/commands/init.ts` | getPythonCommand() now verifies Python >= 3.10 |
| `README.md` / `README_CN.md` | Added Prerequisites section (Node.js >= 18, Python >= 3.10) |
| `.gitmodules` + `marketplace` | Converted from tracked directory to git submodule |


### Git Commits

| Hash | Message |
|------|---------|
| `4a54d8c` | (see git log) |
| `786cbdf` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 108: Update task next_action template to 6-phase lifecycle

**Date**: 2026-04-07
**Task**: Update task next_action template to 6-phase lifecycle
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

Updated task creation template: 4-phase pipeline (implement→check→finish→create-pr) replaced with 6-phase full lifecycle (brainstorm→research→implement→check→update-spec→record-session). Changed both local scripts and npm package templates.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b930880` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 109: Reply to #154, merge fix PRs, document task start/finish lifecycle

**Date**: 2026-04-09
**Task**: Reply to #154, merge fix PRs, document task start/finish lifecycle
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

(Add summary)

### Main Changes

## Context

External contributor @suyuan2022 filed issue #154 about SessionStart hook output (~30KB) exceeding Claude Code's additionalContext limit (~20KB), silently truncating task state. Plus two unrelated bug PRs (#152 ralph-loop field names, #153 .developer parsing) opened the same day.

## What Was Done

### 1. Answered prior question about copilot + .claude co-existence
Researched whether VSCode Copilot auto-loads `.claude/` when both platforms are installed. **Answer: no.** Copilot's auto-discovered instruction sources are a closed list (`.github/copilot-instructions.md`, `.github/instructions/*`, `AGENTS.md`, `.vscode/settings.json` copilot keys, `.github/skills/`, `.github/chatmodes/`). No documentation or behavior treats `.claude/` as a recognized source. Only impact is `@workspace` indexing can surface `.claude/*.md` as ordinary file content — not as instructions. No Trellis-side mitigation needed.

### 2. Local reproduction of issue #154
Fresh `npx @mindfoldhq/trellis@beta init --claude` in `/tmp`, ran `session-start.py`:

| Section | Bytes | KB | % |
|---|---:|---:|---:|
| `<workflow>` | 11,908 | 11.6 | 39.9% |
| `<instructions>` (start.md) | 11,071 | 10.8 | 37.1% |
| `<guidelines>` | 5,186 | 5.1 | 17.4% |
| `<current-state>` | 1,018 | 1.0 | 3.4% |
| **Total** | **29,847** | **29.1** | 100% |

Matched contributor's numbers within 2KB. **This very session was also truncated** — system reminder showed "Output too large (34.4KB)" with fallback path. Confirmed the two big blocks (workflow + instructions) = 77% of payload.

Simulated Approach B (drop start.md injection) on both projects: vanilla drops to 18.6KB (✓ under 20KB), but Trellis repo drops only to 24.7KB (✗ still truncates). Approach B alone is insufficient — `<guidelines>` keeps growing with spec count. A+B combined: 13.5KB on Trellis repo, ~6.5KB safety margin.

### 3. Merged main into feat/v0.4.0-beta
PRs #152 and #153 landed on main. `git merge origin/main --no-edit` merged cleanly (ort strategy, no conflicts). Touched files: `ralph-loop.py` (both mirrors), `update.ts`. Merge commit: `e0acefb`.

### 4. Replied to issue #154
Posted comprehensive comment at #154 confirming repro, answering contributor's three open questions, and endorsing A+B as the fix direction:
- B first (zero risk, pure cleanup, symmetry with other slash commands)
- A follow-up (addresses workflow.md growth)
- Flagged `<guidelines>` as the third time bomb to watch
- Suggested touching all 4 platform mirrors (claude/codex/iflow/copilot) for PR 1
- Asked for size regression test in PR 2

### 5. Found and fixed orthogonal workflow.md documentation gap
While reviewing `task.py` for the issue, discovered `cmd_start` and `cmd_finish` exist and are wired into argparse, but **workflow.md never mentions them anywhere**. Task Development Flow was 5 steps with no mention of `.current-task` mechanism. This is why `## CURRENT TASK` is perpetually `(none)` — AI agents were never told to call `task.py start`.

Fixed in commit `5139ae6`:
- Commands list (Tasks section): added `task.py start <name>` and `task.py finish` with behavior notes
- Task Development Flow: expanded from 5 → 7 steps, inserted Start as step 2 and Finish as step 7
- Added "Current task mechanism" explanation paragraph tying `.current-task` to SessionStart hook injection
- Mirrored across template (`packages/cli/src/templates/trellis/workflow.md`) and dogfood copy (`.trellis/workflow.md`)

Tradeoff: `<workflow>` block grows by ~0.9KB, which runs counter to #154's direction. Justification: fixes a real bug (transparent mechanism bypass), +0.9KB is trivial vs the -10.8KB Approach B will save, and Approach A (workflow TOC) will fold this into section pointers anyway.

## Updated Files

- `packages/cli/src/templates/trellis/workflow.md` (+17 / -4)
- `.trellis/workflow.md` (+17 / -4)

## Commits

- `e0acefb` — Merge main (brings in #152 ralph-loop field fix, #153 .developer parsing fix)
- `5139ae6` — docs(workflow): document task start/finish lifecycle and .current-task

## Open Items

- Issue #154 is in contributor's court: waiting for him to turn Approach B into a PR
- Two untracked workspace files (eng.md, reddit-harness-engineering-post.md, ai_smell_scan.py) from prior work — left untouched
- Pre-existing `.trellis/.version` and marketplace submodule modifications not committed (not session scope)


### Git Commits

| Hash | Message |
|------|---------|
| `e0acefb` | (see git log) |
| `5139ae6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 110: fix #157: init re-init fast path

**Date**: 2026-04-10
**Task**: fix #157: init re-init fast path
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

Fix bootstrap task re-creation bug and add re-init fast path for trellis init

### Main Changes

**Issue**: [#157](https://github.com/mindfold-ai/Trellis/issues/157) — `trellis init` 重复生成 bootstrap task + 多设备/加平台体验差

**Changes**:

| Commit | Type | Description |
|--------|------|-------------|
| `1b767f2` | fix | 用 `isFirstInit` 标记区分首次/重复 init，只在首次创建 bootstrap task |
| `e988c79` | feat | 新增 `handleReinit()` 快速路径，re-init 时跳过完整交互流程 |

**Re-init fast path behavior**:
- `trellis init --codex` → 只配置 Codex
- `trellis init -u name` → 只初始化 developer identity（新设备场景）
- `trellis init`（裸调用）→ 三选一菜单：加平台 / 加开发者 / 完整重初始化
- `--force` / `--skip-existing` → 跳过快速路径，走完整流程（向后兼容）

**Updated Files**:
- `packages/cli/src/commands/init.ts`

**Quality**: lint ✓ typecheck ✓ 582 tests ✓


### Git Commits

| Hash | Message |
|------|---------|
| `1b767f2` | (see git log) |
| `e988c79` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 111: Fix #154: lazy-load workflow.md in session-start, update spec

**Date**: 2026-04-10
**Task**: Fix #154: lazy-load workflow.md in session-start, update spec
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

(Add summary)

### Main Changes

## Context

Continuation of issue #154 work. User community feedback (2 additional users on social media) confirmed the SessionStart hook size problem is widespread — not just the original reporter. Decided to implement the fix ourselves since the external contributor hadn't submitted a PR after 2 days.

## What Was Done

### 1. Implemented workflow.md lazy-load (commit e7b304b)

Replaced `<workflow>` full content injection (11.6 KB) with a 2-line pointer in session-start.py. start.md Step 1 already tells the AI to `cat .trellis/workflow.md`, so the content is still accessed — just on-demand instead of pre-loaded.

Added annotation in `<instructions>` block noting Steps 2-3 (context + guidelines) are already injected by the hook, directing AI to skip to Step 4.

Updated `<ready>` block to match the new flow: "Start from Step 1, skip Steps 2-3, proceed to Step 4."

**Changed files** (4 session-start.py mirrors):
- `packages/cli/src/templates/claude/hooks/session-start.py`
- `packages/cli/src/templates/codex/hooks/session-start.py`
- `packages/cli/src/templates/iflow/hooks/session-start.py`
- `.claude/hooks/session-start.py` (dogfood)

**Copilot excluded** — has no start.md to replace workflow.md with.

**Result**: vanilla 29.1 KB → 17.9 KB (under 20 KB threshold).

### 2. Fixed `__pycache__` test crash (not committed separately)

Running Python hooks locally left `__pycache__/` inside `src/templates/claude/hooks/`, causing `getAllHooks()` to crash with EISDIR (trying to readFileSync a directory). Cleaned up; documented in spec.

### 3. Updated spec (commit 94c5af5)

Added to `platform-integration.md`:
- **SessionStart Hook: additionalContext Size Constraint** section — 20 KB limit, size budget table, "inject instructions not reference" design decision, guidelines growth risk warning
- **`__pycache__` EISDIR crash** — new Common Mistakes entry

### 4. Design decision rationale

User rejected the "dynamic TOC" approach (Approach A from issue #154) because AI won't proactively read a TOC. Instead adopted "inject start.md, let it tell AI to read workflow.md" — the AI follows an explicit instruction rather than deciding on its own to read a reference.

## Commits

- `e7b304b` — fix(hooks): replace workflow.md full injection with lazy-load via start.md (#154)
- `94c5af5` — docs(spec): add SessionStart size constraint and __pycache__ gotcha

## Open Items

- Issue #154 still open — contributor may submit additional PRs for further optimizations
- `<guidelines>` block (5-11 KB) is the next growth risk — may need similar lazy-load treatment
- Copilot session-start.py not touched (no start.md equivalent)
- Release script `git diff-index --quiet HEAD` without `--cached` is fragile with dirty submodules — noted but not fixed


### Git Commits

| Hash | Message |
|------|---------|
| `e7b304b` | (see git log) |
| `94c5af5` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 112: Factory Droid platform support + Codex shared-layer hint

**Date**: 2026-04-14
**Task**: Factory Droid platform support + Codex shared-layer hint
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

(Add summary)

### Main Changes

| Area | Change |
|---|---|
| New platform | Added Factory Droid (`droid`) at Cursor-level scope: commands-only, no hooks/agents |
| Registry | New entry in `AI_TOOLS` — `configDir: .factory`, `cliFlag: droid`, `defaultChecked: false`, plus AITool/CliFlag/TemplateDir union extensions |
| Templates | 12 generic command md files under `src/templates/droid/commands/trellis/`, each with optional `description` YAML frontmatter (Droid auto-completion shows it). Sourced by stripping `trellis-` prefix from cursor templates and renaming. Files use nested `trellis/` subdirectory like Claude — Droid's docs say nesting is unsupported but actual binary picks them up |
| Configurator | `configureDroid()` mirrors Cursor's filtered copy with `.js` exclusion. New `getDroidTemplatePath()` + deprecated `getDroidSourcePath()` alias in `extract.ts` |
| CLI / init | `--droid` flag in `cli/index.ts`, `droid?: boolean` in `InitOptions` |
| Python runtime | Full `cli_adapter.py` integration (template + live `.trellis/scripts/` byte-identical): Platform literal, `config_dir_name`, `get_trellis_command_path`, `get_non_interactive_env`, `cli_name`, `_ALL_PLATFORM_CONFIG_DIRS`, `detect_platform`, `get_cli_adapter` validation, `TRELLIS_PLATFORM` env list, module docstring. `build_run_command` / `build_resume_command` raise ValueError ("not yet integrated with multi-agent") — same pattern as Copilot/Windsurf |
| Tests | +8 tests across 5 files: dedicated `droid.test.ts` (5), `extract.test.ts` (path + alias), `init.integration.test.ts` (`#3j` + negative assertions in `#1`/`#2`), `platforms.test.ts` (detection + configure + collectTemplates), `regression.test.ts` (registry + cli_adapter branch coverage). All 603 tests pass |
| Docs | `README.md` and `README_CN.md` — added Factory Droid to platform list, flag list, and FAQ |
| Codex UX | Codex option `name` field gains parenthetical: `Codex (also writes .agents/skills/ — read by Cursor, Gemini CLI, GitHub Copilot, Amp, Kimi Code)`. Verified each client's official docs explicitly list `.agents/skills/`. Claude Code intentionally omitted — its docs only list `.claude/skills/` |

**Background — Amp Code investigation**: Originally planned to add Amp as a separate platform but research found Amp uses skills (`.agents/skills/`), not commands. Since Codex already writes `.agents/skills/` and Amp reads from there, no new platform was needed. Surfaced this fact via the Codex name hint instead.

**Discarded approach — standalone `agentskills` platform**: Briefly implemented a separate "Shared Skills (.agents/)" pseudo-platform that would write `.agents/skills/` independent of Codex. Reverted after verifying Claude Code does NOT actually read `.agents/skills/` (contrary to several third-party blog claims), making the standalone option misleading. The simpler Codex parenthetical proved sufficient.

**Updated Files**:
- `packages/cli/src/types/ai-tools.ts`
- `packages/cli/src/configurators/droid.ts` (new)
- `packages/cli/src/configurators/index.ts`
- `packages/cli/src/templates/droid/index.ts` (new)
- `packages/cli/src/templates/droid/commands/trellis/*.md` (12 new)
- `packages/cli/src/templates/extract.ts`
- `packages/cli/src/templates/trellis/scripts/common/cli_adapter.py`
- `.trellis/scripts/common/cli_adapter.py` (live sync)
- `packages/cli/src/cli/index.ts`
- `packages/cli/src/commands/init.ts`
- `packages/cli/test/templates/droid.test.ts` (new)
- `packages/cli/test/templates/extract.test.ts`
- `packages/cli/test/configurators/platforms.test.ts`
- `packages/cli/test/commands/init.integration.test.ts`
- `packages/cli/test/regression.test.ts`
- `README.md`
- `README_CN.md`


### Git Commits

| Hash | Message |
|------|---------|
| `0015246` | (see git log) |
| `d7e9b13` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 113: Skill-First Template Refactor (v0.5.0-beta)

**Date**: 2026-04-16
**Task**: Skill-First Template Refactor (v0.5.0-beta)
**Package**: cli
**Branch**: `feat/v0.5.0-beta`

### Summary

Complete skill-first refactor: placeholder engine, common template source, 14 platform configurators unified, command pruning (13→8), skill output with trellis- prefix, dead code cleanup. Research: GSD/Superpowers/gstack/OpenSpec workflow enforcement patterns, 14 platform hook+agent capability audit. Draft: new workflow.md with Phase structure + continue mechanism + platform tags.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `700e7d3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 114: Platform upgrade + hooks/agent research

**Date**: 2026-04-16
**Task**: Platform upgrade + hooks/agent research
**Package**: cli
**Branch**: `feat/v0.5.0-beta`

### Summary

Upgraded 7 platforms to agent-capable (11/14 total). Researched hook+agent formats for all 7: Cursor/Kiro/Gemini use different event names/config files, Qoder/CodeBuddy/Droid near-identical to Claude Code, Kiro uses pure JSON agents. Created Qoder template draft. Written detailed handoff PRDs for both sub tasks.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2910c09` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 115: v0.5.0: hooks + agents for 7 platforms, major cleanup

**Date**: 2026-04-16
**Task**: v0.5.0: hooks + agents for 7 platforms, major cleanup
**Package**: cli
**Branch**: `feat/v0.5.0-beta`

### Summary

(Add summary)

### Main Changes

## Session Summary

Major architecture changes for v0.5.0-beta: added hooks + agents support for 7 new platforms, removed dead features, and cleaned up stale references.

### Platform Hooks + Agents (7 new platforms)
| Platform | Hook Config | Agent Format | Sub-agent Tool |
|----------|------------|--------------|----------------|
| Qoder | settings.json (PascalCase) | .md | `Task` |
| CodeBuddy | settings.json (PascalCase) | .md | `Task` |
| Droid | settings.json (PascalCase) | droids/*.md | `Task` |
| Cursor | hooks.json (camelCase) | .md | `Task` |
| Gemini CLI | settings.json (BeforeTool regex) | .md | agent name |
| Kiro | embedded in agent JSON | .json | `subagent` |
| Copilot | hooks.json (no matcher) | .agent.md | `task` |

### Shared Infrastructure
- `shared-hooks/` — platform-independent Python hook scripts (inject-subagent-context, session-start, statusline)
- `template-utils.ts` — `createTemplateReader()` factory eliminating boilerplate across 6 template modules
- `shared.ts` — `writeSkills()`, `writeAgents()`, `writeSharedHooks()` helpers

### Removed (dead features)
- **iFlow** platform (CLI dead, not maintained)
- **debug/plan/dispatch** agents (unused)
- **Ralph Loop** (SubagentStop enforcement — not portable)
- **parallel** skill + multi_agent pipeline + worktree.yaml + phase.py + registry.py
- **shell-archive** directory
- Hardcoded JSONL fallbacks (spec.jsonl, research.jsonl, finish.jsonl, cr.jsonl)

### Spec Updates
- `platform-integration.md` — 13-platform architecture, shared hooks pattern, new template patterns
- `directory-structure.md` — updated trees, removed iflow/multi_agent/worktree
- `script-conventions.md` — removed multi_agent bootstrap/phase/registry

### Key Decisions
- Hook scripts read ONLY from task JSONL files (implement.jsonl, check.jsonl) — no hardcoded command/skill path fallbacks
- Multi-format hook output (Claude + Cursor + Gemini formats in one JSON) for cross-platform compatibility
- `_parse_hook_input()` handles different platform stdin formats (Task/Agent, subagent, agent name, toolName)

**Tests**: 527 passed (21 files). TypeCheck + Lint clean.


### Git Commits

| Hash | Message |
|------|---------|
| `efccf6f` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 116: v0.5.0: hooks + agents for 7 platforms, major cleanup (detailed)

**Date**: 2026-04-17
**Task**: v0.5.0: hooks + agents for 7 platforms, major cleanup (detailed)
**Package**: cli
**Branch**: `feat/v0.5.0-beta`

### Summary

(Add summary)

### Main Changes

## Session Summary

v0.5.0-beta 的核心 session：为 7 个新平台添加 hooks + agents 支持，同时大规模清理死代码和过时架构。

---

### 一、完成的工作

#### 1. 全平台 Sub Agent 调研（已完成）

通过 WebSearch + Exa 调研了所有 7 个新平台的 sub-agent hook 机制：

| 平台 | Sub Agent 工具名 | PreToolUse 事件名 | Matcher 类型 |
|------|-----------------|-------------------|-------------|
| Cursor | `Task` | `preToolUse` (camelCase) | 精确匹配 |
| Qoder | `Task` | `PreToolUse` (PascalCase) | 精确匹配 |
| CodeBuddy | `Task` | `PreToolUse` | 精确匹配 |
| Droid | `Task` | `PreToolUse` | 精确匹配（已知 block bug） |
| Copilot CLI | `task` (小写) | `preToolUse` | 无 matcher |
| Gemini CLI | 每个 agent 独立工具 | `BeforeTool` | 正则匹配 |
| Kiro | `subagent` | 嵌入 agent JSON | 精确匹配 |

Hook 语言限制调研：所有平台都支持 Python hooks（shell 子进程），唯一例外是 OpenCode（必须 TypeScript/Bun 插件）。

#### 2. 共享 Hook 脚本（`shared-hooks/`）

创建平台无关的 Python hook 脚本：
- `inject-subagent-context.py` — 多平台 input 解析（`_parse_hook_input`）+ 多格式 output（Claude/Cursor/Gemini 格式合一）
- `session-start.py` — 多平台 env var 检测（`should_skip_injection` + `project_dir` 查找）
- `statusline.py` — 直接共享，无平台相关代码
- `index.ts` — `getSharedHookScripts()` 导出

关键设计：hook 脚本只读 `.trellis/` 路径下的 JSONL 文件（implement.jsonl、check.jsonl），不再有 hardcoded 的 command/skill 路径 fallback。

#### 3. 7 个平台模板创建

每个平台创建了：settings.json/hooks.json（平台特定格式）+ agents/*.md（或 Kiro JSON）+ index.ts

- **Group A**（Qoder/CodeBuddy/Droid）：Claude-like format，`Task` matcher
- **Group B**（Cursor/Gemini）：不同事件名和 matcher 格式
- **Group C**（Kiro）：纯 JSON agent 定义，hooks 嵌入 agent 内

#### 4. 共享模板基础设施

- `template-utils.ts` — `createTemplateReader(import.meta.url)` 工厂函数，消除 6 个模板 index.ts 的重复样板
- `shared.ts` — `writeSkills()`、`writeAgents()`、`writeSharedHooks()` 辅助函数，简化 configurator
- 所有 configurator 重写，从 50-65 行缩减到 15-30 行

#### 5. 大规模移除

| 移除项 | 原因 |
|--------|------|
| iFlow 平台 | CLI 已死，不被官方维护 |
| debug/plan/dispatch agents | 实际无人使用 |
| Ralph Loop（SubagentStop hook） | 跨平台不可移植，实际用不上 |
| parallel skill | 各 CLI/IDE 内置 worktree 支持 |
| multi_agent pipeline（start.py/plan.py/status.py 等） | 同上 |
| worktree.yaml + phase.py + registry.py + worktree.py | multi_agent 依赖，一并删除 |
| scripts-shell-archive/ | 已废弃的 shell 脚本旧版 |
| spec/tasks/ 误放目录 | 清理项目结构 |

#### 6. Stale 引用清理

通过 Simplify review + Codex review + 手动检查，清理了 40+ 处 stale 引用：
- iFlow env vars / docstring / 平台列表
- debug/dispatch agent 的注释、表格行、phase mapping
- spec.jsonl/research.jsonl/finish.jsonl/cr.jsonl 引用
- check-cross-layer 引用
- SubagentStop/Ralph Loop 注释
- skill 数量 7→5 跨 13 个 configurator

#### 7. Spec 更新

- `platform-integration.md` — 全面重写：13 平台架构、共享 hooks 模式、新模板模式、5 skills + 2 commands
- `directory-structure.md` — 目录树更新
- `script-conventions.md` — 移除 multi_agent 相关

#### 8. Bug 修复

- `template-utils.ts` 用 `fileURLToPath` 而非 `new URL().pathname`（Windows + 空格路径 bug，Codex review 发现）
- Gemini settings.json 的 `dispatch` 残留 matcher
- OpenCode 的 `inject-subagent-context.js` 去掉 debug agent 和 hardcoded 路径

---

### 二、未完成 / 后续 Task

#### Task: `04-16-rewrite-workflow-full`（仍 active）
- workflow.md 重写（Phase 1/2/3 + 平台标记）
- /continue 命令 + get_context.py --mode phase
- start/finish-work 调整（有 hook 平台去 start command）
- session-start hook 更新（注入 workflow 概要）

#### 已知技术债（待开 task）
1. **Claude 旧 hooks 迁移** — claude/hooks/ 的 inject-subagent-context.py 和 session-start.py 仍是旧版，未用共享版。包含 debug agent 代码、spec.jsonl/finish.jsonl fallback、check-cross-layer 引用
2. **Copilot/Codex 旧 hooks 迁移** — 同上
3. **Copilot hooks.json 缺 preToolUse**（Codex review P1）— 当前只有 SessionStart，sub-agent 注入不生效
4. **Kiro agentSpawn 输出协议**（Codex review P1）— stdout JSON 可能不被正确解析
5. **OpenCode TS 插件更新** — JS 版仍有 hardcoded 路径和 debug 引用（部分已清理）
6. **Hook 路径解析** — settings.json 用相对路径，CWD 不在项目根时 hook 找不到 .py 文件。`${CLAUDE_PROJECT_DIR:-.}` 方案有 Windows 兼容问题，`git rev-parse` 有 submodule 问题，暂未解决
7. **`trellis update` 不清理已删除模板** — 升级的项目会保留旧文件（如 dispatch.md、parallel skill）

---

### 三、测试状态

- 527 tests passed（21 test files）
- TypeCheck: clean
- Lint: clean（1 个 pre-existing OpenCode JS 警告）


### Git Commits

| Hash | Message |
|------|---------|
| `efccf6f` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 117: Workflow rewrite + pull-based migration + enforcement v2 planning

**Date**: 2026-04-17
**Task**: Workflow rewrite + pull-based migration + enforcement v2 planning
**Package**: cli
**Branch**: `feat/v0.5.0-beta`

### Summary

完成 Trellis v0.5 三条主线：(1) workflow.md 重写为 Phase Index + 每步详情，新 get_context.py --mode phase + /continue 命令 + 分步 start.md；session-start hook 注入 Phase Index。(2) 13 平台 sub-agent 注入分类确认（6 hook-inject / 4 pull-based / 3 agent-less），Claude Code canary 实测通过；gemini/qoder/codex/copilot 迁移到 pull-based（sub-agent definition 里注入 Load Trellis Context First 前缀 + Read 文件），configurator 与 collectPlatformTemplates 共用 transform 避免 update 回滚。(3) Research agent 全平台获得 Write + Bash 能力，强制 persist 到 {TASK_DIR}/research/。归档了可靠性审计 + 规划了 workflow enforcement v2（UserPromptSubmit 每轮注入 + phase 状态机 + /rollback 命令，含完整 FP 分析）。551 测试通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d2c6682` | (see git log) |
| `57d4ae1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 118: workflow-enforcement-v2 + slim workflow.md + SessionStart payload restructure

**Date**: 2026-04-18
**Task**: workflow-enforcement-v2 + slim workflow.md + SessionStart payload restructure
**Package**: cli
**Branch**: `feat/v0.5.0-beta`

### Summary

(Add summary)

### Main Changes

## Scope

Delivered the last P1 blocker for v0.5.0-beta (workflow-enforcement-v2), plus a
cascade of payload / content refactors that came out of reviewing what
SessionStart + UserPromptSubmit actually inject into the AI.

## Major Changes

| Area | Change |
|------|--------|
| Sprint 1 (committed 4476844) | Claude hooks migrated to shared-hooks (deleted 1435 lines of per-platform drift); 0.5.0 migration manifest with 125 `safe-file-delete` entries covering dispatch/debug/plan agents, Ralph Loop, parallel skill, multi-agent pipeline, iFlow |
| workflow-enforcement-v2 | New `inject-workflow-state.py` (shared) + OpenCode JS plugin equivalent. Reads workflow.md `[workflow-state:STATUS]` tag blocks as single source of truth (users customize flow by editing md, not Python). Covers 4 states: no_task / planning / in_progress / completed |
| UserPromptSubmit wiring | 7 platforms auto-wire via collectSharedHooks; Codex gets explicit `configureCodex` integration with feature-flag warning (`features.codex_hooks = true` in ~/.codex/config.toml); Kiro downgraded — agentSpawn has no per-turn main-session equivalent |
| Legacy cleanup (FP round 3) | task_store.py (dual source) stops writing `current_phase`/`next_action`; shared-hooks `inject-subagent-context.py` + OpenCode JS drop `update_current_phase()` — stops re-writing legacy fields on every sub-agent spawn |
| `<guidelines>` block trimmed | 10.9 KB → 4.6 KB. `spec/guides/index.md` stays inlined (cross-package thinking guides, broadly useful); other `spec/<pkg>/<layer>/index.md` emit paths only. Rationale: sub-agents get their specific specs via jsonl injection, main agent doesn't need index content in context |
| `<workflow>` block expanded | 2.7 KB → 9.5 KB. Now includes Phase 1/2/3 step bodies, not just TOC + Phase Index. AI gets full step-level how-to inline, no need to lazy-load via `get_context.py --mode phase --step X.Y` |
| workflow.md slimmed | 17 KB → 14 KB (bilingual → English). Removed `What is Trellis`, File Structure tree, Best Practices (all duplicated elsewhere). Task System expanded from 5 → 16 subcommands per PR #169 pattern. Context Script dropped `--json` and `--mode record` (AI-facing flags only) |
| start.md Step 4 | "No active task" branch now explicitly mentions trellis-brainstorm skill (agent-less platforms match hook platforms' breadcrumb guidance) |
| Next-Action coverage | Was: SessionStart `<task-status>` has Next-Action for 5 states; UserPromptSubmit silent-exit on no_task (gap). Now: no_task breadcrumb in UserPromptSubmit hook emits reminder every turn |

## SessionStart Payload Before vs After

| Block | Was | Now |
|-------|-----|-----|
| `<workflow>` | 2.7 KB (TOC + Phase Index) | 9.5 KB (+ Phase 1/2/3 step bodies) |
| `<guidelines>` | 10.9 KB (all indexes inlined) | 4.6 KB (guides inlined + paths only) |
| **Total** | ~16.6 KB | **~16.7 KB** (slight net shift; quality up) |

## Parent Task Subtasks

- archived: `04-17-update-cleanup-deleted-templates` (0.5.0 manifest shipped)
- archived: `04-17-claude-hooks-migrate-to-shared` (1435 lines deleted, unified with shared-hooks)
- archived: `04-17-workflow-enforcement-v2` (UserPromptSubmit breadcrumb + legacy cleanup done)
- downgraded P2 → P3: `04-17-hook-path-robustness` (minimal fix absorbed by new hook's find_trellis_root upward walk; full Windows coverage still open)
- open P2 (post-beta): Kiro agentSpawn real-env validation; cursor/codebuddy/droid sub-agent hook real-env testing

## Key Files

```
packages/cli/src/templates/shared-hooks/
  inject-workflow-state.py         new — 200-line UserPromptSubmit hook
  session-start.py                 _extract_range + workflow body expansion + guidelines paths-only
  inject-subagent-context.py       removed update_current_phase()

packages/cli/src/templates/opencode/plugins/
  inject-workflow-state.js         new — JS equivalent
  session-start.js                 same restructure
  inject-subagent-context.js       removed updateCurrentPhase()

packages/cli/src/templates/{claude,cursor,qoder,codebuddy,droid,gemini,copilot}/
  settings.json / hooks.json       + UserPromptSubmit (or equivalent camelCase)

packages/cli/src/configurators/codex.ts
  configureCodex now calls writeSharedHooks with excludes; stderr warns about feature_codex_hooks flag

packages/cli/src/templates/codex/
  config.toml                      + feature_codex_hooks explanation comment
  hooks/session-start.py           same restructure (guidelines paths-only + workflow body expansion)
  hooks.json                       + UserPromptSubmit entry

packages/cli/src/templates/copilot/hooks/session-start.py    same restructure

packages/cli/src/migrations/manifests/0.5.0.json             125 safe-file-delete entries

.trellis/workflow.md + packages/cli/src/templates/trellis/workflow.md
  17 KB → 14 KB; English only; task.py 5 → 16 commands; + [workflow-state:STATUS] blocks

.trellis/scripts/common/{task_store.py,workflow_phase.py} + template mirrors
  cmd_create drops legacy fields; get_phase_index returns Phase Index + Phase 1/2/3 bodies

packages/cli/test/regression.test.ts + registry-invariants.test.ts + templates/copilot.test.ts
  +18 new tests (workflow-state 7 cases, no_task coverage, UserPromptSubmit platform wiring 9 invariants, legacy field regression, copilot hook event expansion)
```

## Other Notes

- Vibe Island hooks in ~/.codex/hooks.json caused `exit 127` errors on `codex --yolo` startup — unrelated to Trellis; moved to `~/.codex/hooks.json.backup-vibe-island-20260418`, user config now empty `{"hooks": {}}`. Trellis project's own `.codex/` dogfood is stale (pre-v2 changes) — intentionally left to validate `trellis update --migrate` end-to-end on next test run.
- 567 tests passing, lint + typecheck clean across the chain.
- PRD files for all archived tasks updated with actual execution outcomes + Codex Cross-Review round 3 notes where applicable.


### Git Commits

| Hash | Message |
|------|---------|
| `4476844` | (see git log) |
| `c5387df` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 119: 0.5.0-beta.0 release-prep: breaking-change gate + full command→skill migration

**Date**: 2026-04-20
**Task**: 0.5.0-beta.0 release-prep: breaking-change gate + full command→skill migration
**Package**: cli
**Branch**: `feat/v0.5.0-beta`

### Summary

(Add summary)

### Main Changes

Finalized 0.5.0-beta.0 release readiness by dogfooding the 0.4.x → 0.5.0-beta.0 migration end-to-end in a tmp dir and closing every gap surfaced along the way.

| Area | Change |
|------|--------|
| `update.ts` breaking-change gate | Exits 1 when manifest has `breaking + recommendMigrate` and `--migrate` missing. Previously silently bumped `.version` and left the project half-migrated (stale old paths next to new templates). `--dry-run` bypasses the gate so preview still works. |
| Migration manifest (80 new entries) | +65 rename (13 platforms × 5 commands: before-dev/brainstorm/break-loop/check/update-spec) +3 rename for `finish-work` on skill-only layers (.kiro/.qoder/.agents shared) +10 safe-file-delete for old `start` (replaced by session-start hook) +2 safe-file-delete for legacy `improve-ut` |
| `MigrationItem.reason?` | New field — per-entry version-specific context authored in the manifest instead of hardcoded hints in `update.ts`. Rendered inline in the confirm prompt. Applied to 6 entries where 0.4.0 had a hash-tracking gap. |
| Confirm-prompt redesign | Shows manifest `description` + `reason` + per-option recommendation (Backup/Rename/Skip with consequences). Default changed `skip` → `backup-rename` so Enter never destroys edits or leaves orphan files. |
| Backup worktree exclusion | `BACKUP_EXCLUDE_PATTERNS` adds `/worktrees/` and `/worktree/` — prevents `.claude/worktrees/`, `.cursor/worktrees/`, `.gemini/worktrees/` from bloating backups (could hit 100s of MB once in use). |
| Build clean step | `package.json` build chain: `clean && tsc && copy-templates`. Prevents deleted `src/templates/` files from lingering in `dist/` and shipping to npm — previously caused a safe-file-delete ↔ re-write loop across consecutive `trellis update` runs. |
| `continue.md` i18n | `[必做]` / `[一次]` tags → `[required]` / `[once]` to match `workflow.md`'s English convention. |
| Changelog | 3 places updated (manifest `notes`, `docs-site/changelog/v0.5.0-beta.0.mdx`, zh counterpart). Added migration note: `/trellis:record-session` is gone — its journal-writing job is now Step 3 of `/trellis:finish-work`; users with aliases must swap. |

**Key realizations / traps we hit:**

- `rename` classification uses project-local `.trellis/.template-hashes.json`, NOT the manifest's `allowed_hashes` field (which is only consulted by safe-file-delete). Saved ~1 hour by not collecting 150 historical hashes needlessly.
- 0.4.0 init has a bug: `.kiro/skills/update-spec/SKILL.md`, `.qoder/skills/update-spec/SKILL.md`, `.agents/skills/update-spec/SKILL.md` aren't written to `.template-hashes.json`, so pristine files show as "modified" during migration. Handled via per-entry `reason` field telling the user it's safe to accept.
- The initial `createFullBackup` design bulked everything under managed dirs into a backup. Once the user starts running platform-native worktrees (`.claude/worktrees/feature-x/...`), each update snapshots every nested file. Exclusion pattern fixes this.
- `dist/templates/` was never cleaned between builds — templates removed from `src/` lingered in `dist/` (e.g. `debug.md`, `dispatch.md`, `plan.md`), got init'd into user projects, then safe-file-delete'd on the next update → add/delete churn across consecutive updates.

**Validation:**

- `pnpm test` → 595 passing (23 new this session: 3 gate, 12 backup-exclude, 5 manifest-shape, 3 per-platform-path invariant)
- `pnpm lint` + `pnpm typecheck` clean
- Smoke test in `/tmp/trellis-smoke5` (full 13-platform 0.4.0 → 0.5.0-beta.0 migration): `Migration complete: 68 renamed` / `Cleaned up: 93 deprecated files` / idempotent on subsequent runs (`Already up to date!`)
- Verified `.agents/skills/` and `.kiro/skills/` end up with only `trellis-*` prefixed directories (no 0.4.0 plain-name orphans)

**Updated Files:**
- `packages/cli/package.json` — version bump 0.4.0 → 0.5.0-beta.0 + `clean` script
- `packages/cli/src/commands/update.ts` — gate + prompt redesign + export `shouldExcludeFromBackup`
- `packages/cli/src/migrations/manifests/0.5.0-beta.0.json` — 126 → 206 entries
- `packages/cli/src/types/migration.ts` — `reason?: string` field
- `packages/cli/src/templates/common/commands/continue.md` — English-only tags
- `packages/cli/test/commands/update-internals.test.ts` — 12 backup-exclude tests
- `packages/cli/test/commands/update.integration.test.ts` — 3 gate tests
- `packages/cli/test/regression.test.ts` — manifest shape regression block
- `docs-site/changelog/v0.5.0-beta.0.mdx` + `docs-site/zh/changelog/v0.5.0-beta.0.mdx`


### Git Commits

| Hash | Message |
|------|---------|
| `2374433` | (see git log) |
| `b284d81` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 120: v0.5.0-beta.5/6: trellis- prefix sub-agents, drop model:opus, fix codex read-only

**Date**: 2026-04-20
**Task**: v0.5.0-beta.5/6: trellis- prefix sub-agents, drop model:opus, fix codex read-only
**Branch**: `feat/v0.5.0-beta`

### Summary

(Add summary)

### Main Changes

## Releases

- **beta.5** — Sub-agent rename + `model: opus` purge
- **beta.6** — Codex `trellis-check` workspace-write fix

## beta.5 (commit 79801ed / tag e49975d... wait 66a1ae2)

**Problem 1: agent name collision.** Generic `implement` / `check` / `research` names collided with user-defined agents and got picked up by main agent's description heuristics.

**Problem 2: hardcoded `model: opus` burning Cursor users.** All 18 markdown agent frontmatters + 3 `Task()` examples in `copilot/prompts/start.prompt.md` shipped with `model: opus`. On Cursor this mapped to Claude Opus billing (~5x Sonnet). One tester reported "差点给我跑破产".

**Fix**:
- Renamed all agents to `trellis-implement` / `trellis-check` / `trellis-research` across 10 platforms (claude, cursor, opencode, codex, kiro, gemini, qoder, codebuddy, copilot, droid) — both filename AND `name:` frontmatter field
- Removed `model: opus` from all 18 .md agents + 3 Task() examples
- Updated hook constants (`AGENT_IMPLEMENT` etc.), `workflow.md`, `copilot/prompts/start.prompt.md`, `configurators/shared.ts::detectSubAgentType`
- Tests: updated references in `regression.test.ts`, `platforms.test.ts`, `codex.test.ts`, `init.integration.test.ts`
- 30-entry migration manifest (10 platforms × 3 agents), breaking + recommendMigrate=true (invokes beta.3 `update.skip` bypass)

**Dogfood**: `/tmp/mt-repro` init beta.3 → `tl update --migrate --force` → all platforms migrated cleanly, idempotent on second run.

## beta.6 (commits fe1d1ff + e49975d bump)

**Problem**: `.codex/agents/trellis-check.toml` shipped with `sandbox_mode = "read-only"` and "Read-only Trellis reviewer" framing. Directly contradicts `workflow.md` Phase 2.2 ("Auto-fix issues it finds") and every other platform (Read/Write/Edit tools). Codex users got review findings but couldn't self-fix — broken workflow contract.

**Fix**: `sandbox_mode = workspace-write`, rewrote developer_instructions to self-fix + re-run lint/type-check until green, with `Findings (fixed) / Findings (not fixed) / Verification` report format. Now behaviorally aligned with Claude Code / Cursor check agent.

Pure content fix, no migrations. `trellis update` auto-updates for users who didn't customize; confirm prompt with diff if they did.

## Migration Debug (ran on this repo during session)

User reported `.cursor/agents/trellis-check.md` kept OLD content (`name: check`, `model: opus`) after beta.5 migration. Fresh `/tmp/mt-repro` test worked correctly — confirmed code is sound. This repo's state was half-migrated because:
1. `.claude` + `.cursor` agents renamed OK, hash moved, but first `--migrate` run didn't finish writing new template content (content overwrite happens in "New files" bucket post-rename)
2. `.opencode/agents/` entries had no hashes in `.template-hashes.json` → classified as "modified" → went to confirm bucket → user's prompt flow didn't complete overwrite

Ran `tl update --migrate --force` a second time to complete. All 10 platforms now aligned.

## Other observations

- `grep -rn "^model\s*[:=]\|\"model\"\s*:" packages/cli/src/templates/` — confirmed NO remaining model hardcoding. Only `statusline.py:169` reads CC's `model.display_name` for status line display (not limiting).
- User dogfooded beta.5 → beta.6 live; session ended clean

**Updated Files**:
- `packages/cli/src/templates/{claude,cursor,gemini,qoder,codebuddy,opencode,droid}/agents|droids/trellis-{implement,check,research}.md` (renamed, model: opus removed)
- `packages/cli/src/templates/codex/agents/trellis-{implement,check,research}.toml` (renamed)
- `packages/cli/src/templates/kiro/agents/trellis-{implement,check,research}.json` (renamed)
- `packages/cli/src/templates/codex/agents/trellis-check.toml` (beta.6: workspace-write + self-fix)
- `packages/cli/src/templates/trellis/workflow.md` (Agent type refs)
- `packages/cli/src/templates/copilot/prompts/start.prompt.md` (subagent_type refs + model removed)
- `packages/cli/src/templates/shared-hooks/inject-subagent-context.py` (AGENT_* constants)
- `packages/cli/src/configurators/shared.ts` (detectSubAgentType)
- `packages/cli/src/migrations/manifests/0.5.0-beta.5.json` (30 rename entries)
- `packages/cli/src/migrations/manifests/0.5.0-beta.6.json` (no migrations)
- `packages/cli/test/{regression,configurators/platforms,templates/codex,commands/init.integration}.test.ts`
- `docs-site/{,zh/}changelog/v0.5.0-beta.{5,6}.mdx` + `docs-site/docs.json` (navbar + page lists)


### Git Commits

| Hash | Message |
|------|---------|
| `79801ed` | (see git log) |
| `66a1ae2` | (see git log) |
| `fe1d1ff` | (see git log) |
| `e49975d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
