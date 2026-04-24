# brainstorm: Session start hook injection proof

## Goal

修复 GitHub issue #190：Windows 上 Codex `SessionStart` hook 因 stdout 编码不是 UTF-8，导致包含中文的 Trellis context JSON 输出失败，进而阻断 session-start context 注入。

## What I already know

* 最新 GitHub issue 是 `mindfold-ai/Trellis#190`：`win上编码问题导致codex session start hook失败`，版本 `0.5.0-beta.13`，环境 Windows 11 + Node.js v25.2.1。
* 用户定位到 `.codex/hooks/session-start.py` 编码问题，手动修改后 Windows 成功注入上下文，并在 Linux 测试可用。
* `packages/cli/src/templates/shared-hooks/session-start.py` 已经在 Windows 上重配 `sys.stdout` 为 UTF-8。
* `packages/cli/src/templates/codex/hooks/session-start.py` 是 Codex 专用副本，当前没有同等 stdout UTF-8 重配。
* `packages/cli/src/templates/copilot/hooks/session-start.py` 与 Codex hook 结构相同，也存在同类输出风险。

## Requirements

* Codex session-start hook 在 Windows 控制台编码不是 UTF-8 时，也必须能输出包含中文的 JSON hook payload。
* Copilot 专用 session-start hook 应同步应用同类 stdout UTF-8 保护，避免重复平台副本继续漂移。
* 现有 hook JSON shape 必须保持不变：`hookSpecificOutput.hookEventName = "SessionStart"`，`additionalContext` 继续承载 Trellis context。
* 不改变 Codex `hooks.json` command、timeout、`statusMessage` 行为。
* Agent-capable 平台的 session-start / workflow-state 注入必须把 Phase 2 主路径表述成硬约束：dispatch `trellis-implement`，不要在 main session 写代码，再 dispatch `trellis-check`。
* READY task-status 应输出单一下一步动作，而不是模糊的 “continue with implement or check”。
* Agent-capable 注入文案中不再出现 “if you stay in the main session, load trellis-before-dev” 这种 fallback 诱导；`trellis-before-dev` 只保留在 agent-less 平台路径。
* 后续可见 UI 提示必须按 Claude `session_id` 或 `transcript_path` 做 session-scoped 状态，不能写单个项目级 “最近一次注入成功” 文件，否则多开窗口会互相覆盖。
* Claude Code 的可见提示优先走官方 `statusLine`：`SessionStart` 写当前 session 的注入状态，`statusline.py` 用 stdin 里的 `session_id` / `transcript_path` 读取同一 session 的状态并显示 `Trellis ✓ Start injected` / `Trellis ? Start not confirmed`。
* SessionStart injected context should also include a one-shot instruction for the AI's first visible reply: before answering the user's first prompt, briefly state that Trellis SessionStart context was injected and summarize the injected blocks. This is a fallback for platforms without a native persistent UI surface.
* The first-reply notice must be concise and must not repeat after the first assistant response in the session. It should not override urgent user intent; it should prepend one short sentence, then continue with the requested work.

## UI Strategy Decision

Preferred hierarchy:

1. Native persistent UI when available: Claude Code `statusLine`.
2. Native transient UI when available: Codex `statusMessage` / `systemMessage`.
3. AI first-reply notice: a SessionStart instruction that makes the first assistant response explicitly acknowledge Trellis context injection.
4. Diagnostic-only fallback: local per-session state/logs for platforms whose host ignores `SessionStart` output.

The first-reply notice is intentionally a fallback, not the primary Claude Code solution. It proves that the model saw the injected context, but it is not a host-level proof that the hook ran; native UI/status and debug logs remain the stronger signal.

## Acceptance Criteria

* [x] Codex hook template includes Windows stdout UTF-8 reconfiguration before printing JSON.
* [x] Copilot hook template includes the same Windows stdout UTF-8 reconfiguration.
* [x] Regression tests cover both platform-specific hook templates so this class of drift does not return.
* [x] Session-start READY guidance tells agent-capable platforms to dispatch `trellis-implement` / `trellis-check` and not edit in main session.
* [x] Workflow-state in-progress guidance carries the same hard constraint.
* [x] Test suite passes.
* [x] Lint and typecheck pass.

## Definition of Done

* Tests added or updated for the bug fix.
* Lint and typecheck pass.
* Spec/docs updated if this reveals a reusable platform-template convention.

## Out of Scope

* No changes to official Codex hook feature-flag requirements.
* No new hook registration mechanism.
* No change to Copilot's official behavior where `sessionStart` output may be ignored by the host.

## Technical Notes

* GitHub issue: https://github.com/mindfold-ai/Trellis/issues/190
* Relevant templates:
  * `packages/cli/src/templates/codex/hooks/session-start.py`
  * `packages/cli/src/templates/copilot/hooks/session-start.py`
  * `packages/cli/src/templates/shared-hooks/session-start.py`
* Relevant tests:
  * `packages/cli/test/regression.test.ts`
  * `packages/cli/test/templates/codex.test.ts`
