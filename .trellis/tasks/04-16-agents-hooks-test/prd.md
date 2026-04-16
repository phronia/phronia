# Sub Task: 更新 agents/hooks + 测试 + 文档

## 当前状态

### 已完成
- [x] ai-tools.ts 的 agentCapable/hasHooks flags 已更新（11 个 agent-capable，3 个 agent-less）
- [x] 各平台 hook + agent 格式调研完成（结果见下方）
- [x] Qoder 的 hooks/agents/settings.json 模板文件已创建（但需要验证 matcher 名）

### 进行中
- [ ] 7 个新平台的 hooks + agents 模板创建
- [ ] configurator 更新（让 init 写入 hooks + agents）
- [ ] workflow-draft.md 平台标记更新（从 4 个 → 11 个 agent-capable）

### 阻塞项
**各平台 sub agent 工具名未确认**——PreToolUse matcher 需要知道平台用什么名字 spawn sub agent（Claude Code 是 `Task`/`Agent`，其它平台可能不同）。需要针对每个平台调研。

## 平台分组

### Agent-capable（11 个）
Claude Code, iFlow, OpenCode, Codex, **Cursor, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid**（后 7 个新增）

### Agent-less（3 个）
Kilo, Antigravity, Windsurf

## 各平台 Hook + Agent 格式速查

### Group A — 和 Claude Code 格式几乎一样（改路径前缀就行）

**Qoder**
- Hooks: `.qoder/settings.json`，PascalCase 事件名，`command` handler
- Agents: `.qoder/agents/{name}.md`，MD + YAML frontmatter
- 环境变量前缀: `QODER_`
- 差异: 多了 `PostToolUseFailure`、`SubagentStart`、`PermissionRequest` 事件

**CodeBuddy**
- Hooks: `.codebuddy/settings.json`，PascalCase 事件名
- Agents: plugin 内 `agents/{name}.md`，MD + YAML frontmatter
- 环境变量前缀: `CODEBUDDY_`
- 差异: 独有 `prompt` handler 类型（LLM 判断）；agent 嵌在 Plugin 系统

**Factory Droid**
- Hooks: `.factory/settings.json`，PascalCase 事件名
- Agents: `.factory/droids/{name}.md`，MD + YAML frontmatter（注意叫 "droids" 不叫 "agents"）
- 环境变量前缀: `FACTORY_`/`DROID_`
- 差异: 工具名不同（`Execute` vs `Bash`，`Create` vs `Write`）；agent 多 `model`/`reasoningEffort` 字段

### Group B — 结构相似但细节不同

**Cursor**
- Hooks: `.cursor/hooks.json`（独立文件，不在 settings.json 里），camelCase 事件名（`preToolUse`）
- Agents: `.cursor/agents/{name}.md`，MD + YAML frontmatter
- 差异: 18+ 事件；多 `failClosed`/`loop_limit`/`readonly`/`is_background` 字段

**GitHub Copilot**
- Hooks: `.github/hooks/hooks.json`，camelCase 事件名
- Agents: `.github/agents/{name}.agent.md`（注意 `.agent.md` 后缀！）
- 差异: 区分 `bash`/`powershell` 双平台命令；无 matcher 过滤；必须在默认分支

**Gemini CLI**
- Hooks: `.gemini/settings.json`，PascalCase 但事件名不同（`BeforeTool` vs `PreToolUse`）
- Agents: `.gemini/agents/{name}.md`，MD + YAML frontmatter
- 差异: timeout 毫秒（默认 60000）；用 `@name` 调用 agent；不支持 agent 间互调

### Group C — 架构不同

**Kiro CLI**
- Hooks: **嵌入 agent JSON 内**（不是全局配置）
- Agents: `.kiro/agents/{name}.json`，**纯 JSON**（不是 Markdown）
- 差异: 每个 agent 可有不同 hooks；工具名用内部名（`fs_read`/`execute_bash`）；不支持 sub-agent 嵌套 spawn

## 待写的模板文件清单

每个平台需要：
1. hooks 目录（Python 脚本——直接复制 Claude Code 的，内容一致）
2. agents 目录（需要适配格式）
3. settings/hooks 配置文件（平台特定格式）
4. configurator 更新（让 init 写入这些文件）
5. index.ts 更新（collectTemplates 包含 hooks + agents）

### 建议实施顺序
1. Group A（Qoder → CodeBuddy → Droid）——格式最接近，改前缀即可
2. Group B（Cursor → Copilot → Gemini）——需要适配事件名和配置格式
3. Group C（Kiro）——架构完全不同，最后做

## 文件位置

### 已创建（需要验证）
```
packages/cli/src/templates/qoder-new/
├── hooks/
│   ├── session-start.py
│   ├── inject-subagent-context.py
│   ├── ralph-loop.py
│   └── statusline.py
├── agents/
│   ├── check.md
│   ├── debug.md
│   ├── dispatch.md
│   ├── implement.md
│   ├── plan.md
│   └── research.md
└── settings.json
```

注意：`qoder-new/` 是临时目录名，最终需要和现有 qoder configurator 合并。

### Git 分支
`feat/v0.5.0-beta`

### 相关文件
- `packages/cli/src/types/ai-tools.ts` — flags 已更新
- `packages/cli/src/configurators/qoder.ts` — 需要更新，加入 hooks + agents 写入逻辑
- `.trellis/tasks/04-16-skill-first-refactor/prd.md` — 主 task PRD（已被 archive，需要重建或从 git 恢复）
