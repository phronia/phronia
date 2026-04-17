# Skill-First 重构

## 目标

将 Trellis 的模板系统从 "slash command 为主" 重构为 "skill-first + 最少 slash command"，降低用户心智负担，提升 AI 自主遵守工作流的能力。

## 已完成

### Phase 0-2：模板引擎 + 14 平台统一
- [x] Placeholder 引擎（`{{CMD_REF:x}}`、`{{#AGENT_CAPABLE}}`、条件块）
- [x] Common 模板目录（2 commands + 6 skills，单一源）
- [x] 14 个平台 configurator 改为从 common/ 读取 + resolve + wrap
- [x] 旧模板目录清理（9 个平台的独立副本删除）
- [x] 模板内容语言无关化（去掉 TS/pnpm 硬编码）

### Phase 3：命令瘦身
- [x] 删除 onboard / create-command / integrate-skill
- [x] record-session 合并进 finish-work
- [x] check-cross-layer 合并进 check
- [x] 模板从 13 → 8（2 commands + 6 skills）

### 平台调研
- [x] 14 个平台 command + skill 支持验证（全部支持）
- [x] 子目录命名空间验证（不支持嵌套，用 trellis- 前缀）
- [x] 各平台 skill 目录路径确认

### 输出策略确定
- [x] "Both" 平台（11 个）：start + finish-work 为 command，其余为 skill（trellis- 前缀）
- [x] "Skill-only" 平台（3 个：Codex/Kiro/Qoder）：全部为 skill
- [x] 有 hook 平台不需要 start command（hook 自动注入）

### 工作流调研
- [x] GSD：hook + 文件状态机 + gate 防护
- [x] Superpowers：反合理化表 + Hard Gate + 强制顺序链
- [x] gstack：路由规则 + PreToolUse freeze + plan mode 安全操作
- [x] OpenSpec：DAG + 文件系统即状态 + continue 机制

## 进行中

### workflow.md 重写
- [ ] 重构为 Phase 1/2/3 结构（Plan → Execute → Finish）
- [ ] 每个 phase 的详细步骤（带 `[必做·一次]` 等标签）
- [ ] agent-capable vs non-agent 用 placeholder 区分
- [ ] get_context.py --mode phase --step X.X 支持按步骤加载
- [ ] continue 命令只放索引，详情在 workflow.md

### continue 机制
- [ ] continue-with-agent.md 草稿（已完成 Phase 1/2/3 详情）
- [ ] continue-without-agent.md 草稿（待更新）
- [ ] 合并到 workflow.md

### start 命令调整
- [ ] 有 hook 平台：去掉 start command，hook 注入 workflow 概要
- [ ] 无 hook 平台：保留 start command

## 待做

- [ ] 新版 workflow.md 编写
- [ ] get_context.py --mode phase 实现
- [ ] session-start.py hook 更新（注入 workflow 概要而非 start.md）
- [ ] start.md 按平台有无 hook 分别处理
- [ ] finish-work.md 更新
- [ ] research agent 定义更新（产出持久化到 task 目录）
- [ ] 路由规则 + 反合理化表写入 workflow.md
- [ ] 测试更新
- [ ] platform-integration.md spec 文档更新

