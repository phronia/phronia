# Sub Task: 重写 workflow + continue + start/finish-work 调整

## 当前状态

### 已完成
- [x] workflow-draft.md 初版已写好（Phase 1/2/3 结构 + 平台标记 + routing + 反合理化表）
- [x] continue-with-agent.md 草稿已完成（Phase 1/2/3 详情）
- [x] continue-without-agent.md 草稿已创建（待更新）
- [x] 设计确认：workflow.md 用 `[平台名列表]` 标记区分不同平台的指引

### 待做
- [ ] workflow-draft.md 更新平台标记（从 4 → 11 个 agent-capable）
- [ ] workflow-draft.md → 正式替换 workflow.md（模板源 + 项目文件）
- [ ] get_context.py --mode phase --step X.X --platform xxx 实现
- [ ] continue 命令模板（只放索引，详情引用 workflow.md）
- [ ] start 命令：有 hook 平台去掉，无 hook 平台保留
- [ ] finish-work 命令更新（精简为收尾记录 + 提醒）
- [ ] session-start hook 更新（注入 workflow 概要而非 start.md）

## 关键设计决策

### workflow.md 结构
```
# Development Workflow
├── Core Principles（3 条）
├── Trellis System（理念、Identity、文件结构、Spec/Task/Workspace 系统、脚本参考）
├── Phase Index（概要 + routing 表 + 反合理化表 + get_context.py 引用）
├── Phase 1: Plan（详细步骤，带 [平台列表] 标记）
├── Phase 2: Execute（详细步骤，带 [平台列表] 标记）
├── Phase 3: Finish（详细步骤）
└── Best Practices（DO/DON'T）
```

### 平台标记语法
```markdown
[Claude Code, iFlow, OpenCode, Codex, Cursor, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid]
agent-capable 版本的内容
[/Claude Code, iFlow, OpenCode, Codex, Cursor, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid]

[Kilo, Antigravity, Windsurf]
agent-less 版本的内容
[/Kilo, Antigravity, Windsurf]
```

### get_context.py --mode phase
- `--step 1.1` — 从 workflow.md 提取 `#### 1.1` 到下一个 `####` 之间的内容
- `--platform cursor` — 过滤只保留包含 "Cursor" 的 `[...]` 块
- 不加 `--platform` — 全部返回

### 用户面命令
- **有 hook 平台**：`/trellis:finish-work` 一个 command
- **无 hook 平台**：`/trellis:start` + `/trellis:finish-work` 两个 command
- **所有平台**：6 个 skills（trellis-brainstorm/before-dev/check/break-loop/update-spec/parallel）

### Phase 流程概要
```
Phase 1: Plan
  1.0 创建 Task [必做·一次]
  1.1 需求探索 [必做·可重复] — load trellis-brainstorm skill
  1.2 调研 [可选·可重复] — spawn research agent 或主会话调研，产出写入 {TASK_DIR}/research/
  1.3 配置上下文 [必做·一次] — 仅 agent-capable 平台，init-context + add-context
  1.4 完成标志 — prd.md 存在 + 用户确认

Phase 2: Execute
  2.1 实现 [必做·可重复] — agent-capable: spawn implement agent / agent-less: load before-dev + 直接写
  2.2 质量检查 [必做·可重复] — agent-capable: spawn check agent + Ralph Loop / agent-less: load trellis-check
  2.3 回退 [按需] — prd 有误/方向错误/需补充调研

Phase 3: Finish
  3.1 质量验证 [必做·可重复] — load trellis-check
  3.2 Debug 复盘 [按需] — load trellis-break-loop
  3.3 规范更新 [必做·一次] — load trellis-update-spec
  3.4 收尾提醒 — 提醒用户跑 /finish-work
```

## 注意事项
- workflow-draft.md 在上次 commit 时被 archive 掉了，需要重新创建或从 git 恢复（内容在 session context 里有完整版）
- research agent 需要同步更新定义（产出持久化到 task 目录）
- plan mode 兼容：不禁止，但强调 prd.md 是持久化入口
