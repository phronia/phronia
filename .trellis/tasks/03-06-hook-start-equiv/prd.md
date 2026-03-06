# Hook 注入后 AI 主动执行 start 流程

## Goal

让 SessionStart hook 注入上下文后，AI 的行为与用户手动执行 `/trellis:start` 等效——主动汇报上下文、询问用户要做什么、按任务分类走完整流程。

## Background

当前 hook 会把 workflow.md、spec indexes、get_context.py 输出和 start.md 全部注入 context，但 `<ready>` 标签告诉 AI "等用户消息"，导致 AI 被动等待而不是主动执行 start 流程。用户反馈显示 hook 注入后 AI 经常跳过任务创建、PRD 等步骤直接写代码。

## Root Cause

1. `<ready>` 标签："Context loaded. Wait for user's first message" — 被动指令
2. start.md 的 Steps 1-3 在 hook 场景下冗余（数据已预加载），但没有条件判断跳过
3. start.md 整体语言偏描述性（reference manual），不够 imperative

## Requirements

- [ ] 修改 `<ready>` 标签为主动指令（汇报上下文 + 询问用户）
- [ ] start.md 加条件判断：检测上下文已注入时跳过 Steps 1-3，直接执行 Step 4
- [ ] 确保 Claude Code 和 iFlow 两个平台的 hook + start.md 同步更新
- [ ] 验证：hook 注入后 AI 行为与手动 `/trellis:start` 等效

## Acceptance Criteria

- [ ] Hook 注入后 AI 主动汇报当前上下文（分支、任务、工作区状态）
- [ ] Hook 注入后 AI 主动询问 "What would you like to work on?"
- [ ] 用户描述任务后 AI 走完任务分类 → 创建 task → PRD 流程
- [ ] 手动 `/trellis:start` 行为不受影响（向后兼容）
- [ ] 单测通过

## Technical Notes

### Files to Modify

- `src/templates/claude/hooks/session-start.py` — 修改 `<ready>` 标签
- `src/templates/claude/commands/trellis/start.md` — 加条件判断 + 强化语言
- `src/templates/iflow/hooks/session-start.py` — 同步修改
- `src/templates/iflow/commands/trellis/start.md` — 同步修改

### Key Insight

Hook 和 start.md 共享同一份模板，但服务两种场景：
1. **Hook 注入**：数据已预加载，只需行为指令
2. **手动 /start**：需要先采集数据再执行行为

模板需要能区分这两种场景，或者把行为指令独立出来让两种场景都能正确触发。
