# brainstorm: Trellis plugin 机制 + memory/trace 插件设计

## Goal

为 Trellis 设计一套**可选插件机制**，让用户按需启用附加能力（记忆系统、对话/代码 trace），而不把这些能力硬编码到 Trellis 核心 init/update 流程。

首批要落地的两个插件：
1. **Memory plugin** — 类 Serena/Supermemory 的 AI 记忆能力
2. **Trace plugin** — 对接 Cursor Agent Trace 开放规范 + 底层对话日志

## Research References

所有详细调研沉淀在 `research/` 目录（9 份）：

**规范与生态**：
- [`research/agent-trace-spec.md`](research/agent-trace-spec.md) — Cursor Agent Trace RFC 0.1.0 规范解读（schema / 参考实现 / hook 事件表）
- [`research/agent-trace-ecosystem.md`](research/agent-trace-ecosystem.md) — Agent Trace 生态现状（RFC 停滞 / 签字方实现情况 / opentraces.ai / git-ai 竞争方案 / OTel GenAI）
- [`research/memory-systems-landscape.md`](research/memory-systems-landscape.md) — Memory 系统全景（Anthropic 原生 Memory Tool GA / mem0 / Letta / Zep / Basic Memory / Obsidian MCP 等 10 个产品对比）

**平台能力**：
- [`research/claude-code-hook-api.md`](research/claude-code-hook-api.md) — Claude Code 24 个 hook 事件完整 payload schema + transcript 存储实测 + 环境变量
- [`research/opencode-plugin-api.md`](research/opencode-plugin-api.md) — OpenCode 15 个 hook + 1.2.x factory function 约定 + Claude Code 映射表 + 能力缺口
- [`research/cursor-chat-storage.md`](research/cursor-chat-storage.md) — Cursor state.vscdb 聊天存储（事后 scraper 路径）

**参考产品**：
- [`research/serena-memory.md`](research/serena-memory.md) — Serena 的 memory 设计（本地 md + 5 tools + agent 主动召回）
- [`research/supermemory.md`](research/supermemory.md) — Supermemory SaaS 形态
- [`research/karpathy-llm-wiki.md`](research/karpathy-llm-wiki.md) — Karpathy Wiki LLM 4 原则 + 社区 12 天落地方案（llm_wiki / obsidian-ai-orange-book / wiki9 / Rowboat 等）

**Trellis 现状**：
- [`research/trellis-existing-extension-points.md`](research/trellis-existing-extension-points.md) — Trellis 现有 5 种 plugin-like 机制盘点

## What I already know

**核心架构认知**：

- **Trellis 本质是配置生成器**（init/update 后退场），真正的 runtime 在各 AI CLI 里。所以"Trellis 插件"的抽象是：**Capability Bundle，声明需要的 skill/hook/storage/plugin.js，由 Trellis 在 init 阶段分发到各平台的原生扩展点**。
- **Trellis 已有 5 种扩展点**（Platform Registry / Shared Templates / Migration / OpenCode Plugins / Spec Marketplace），plugin 机制应**复用**而非新建子系统。

**Memory 方向（调研后确认）**：

- Anthropic **2026-04 GA 的原生 Memory Tool** (`memory_20250818`) 路线与 Serena/Trellis 哲学一致：本地文件 + 6 命令（`view/create/str_replace/insert/delete/rename`）+ agent 主动调用
- 业界主流（Basic Memory / Obsidian MCP / Letta MemFS / ByteRover 2.0）都在这个象限收敛 —— **Trellis 不是赌方向，是踩中共识**
- **关键决策**：Memory plugin 的 tool schema **对齐 Claude 官方的 6 命令**，使 handler 可同时充当 MCP server + Claude Memory Tool handler（一套代码两个 channel）
- **值得借鉴**：`_index.md` 路由表（省 token）、memory 文件进 git（Letta MemFS 思路）
- **不做**：vector / graph 栈（反 Trellis 气质）、SaaS、跨线做 agent 运行时

**Trace 方向（调研后重大调整）**：

- ⚠️ **Agent Trace RFC 0.1.0 发布 5 个月零迭代**（2026-04 仍 0.1.0），实际落地的仅 Cursor 参考实现 + 1-2 个社区 fork
- **8/10 signatory 仅承诺未实现**（Amp / Cline / Cloudflare / Cognition / Jules / OpenCode / Vercel / Amplitude）
- **事实标准浮现**：`.opentraces.ai v0.3.0`（2026-04-16 发布，schema 比 agent-trace 更丰富，带 Steps/ToolCalls/Attribution/GitLink evidence tiers）+ git-ai（Git Notes + `.git/ai/*` checkpoints，schema 与 agent-trace 不兼容）
- **事实标准优先级**：Claude Code session JSONL > Cursor hooks > OTel GenAI > agent-trace RFC > git-ai checkpoints
- **可观测性生态通用模式**：Langfuse / Braintrust / LangSmith / Datadog 都走"Claude Code hooks + env var opt-in"
- **OpenTelemetry GenAI semantic conventions** 仍是 Development 状态，但 2026-03-09 刚加 `invoke_workflow` span

**Trace 架构决策调整**：

Trellis 应该用**内部形态（对齐 OTel GenAI）做 source of truth**，把 agent-trace / opentraces / git-ai 作为**可插拔 exporter**，不 1:1 绑定任何规范。

建议存储：`.trellis/tasks/{task}/traces/session-{uuid}.jsonl`（per-session JSONL）

**Claude Code / OpenCode 平台能力**：

- **Claude Code**：24 hook 事件，PostToolUse/UserPromptSubmit/SessionStart/SessionEnd payload 都有实测 schema；transcript 存 `~/.claude/projects/<normalized>/<session_id>.jsonl`，subagents 嵌在 `<sessionId>/subagents/` 下
- **OpenCode**：15 hook，`async (PluginInput) => Hooks` factory 形态（1.2.x breaking），transcript 存 `~/.local/share/opencode/storage/`（session/message/part 三级分目录）
- **能力差异**：OpenCode 缺 `Stop` / `SubagentStop` / agent-hook；Claude Code 缺 `shell.env` / `permission.ask`
- **陷阱**：OpenCode `chat.message` 改动会持久化，`experimental.chat.system.transform` 不会（memory recall 要看是否想显示在历史）

## Assumptions (temporary)

- A1: 插件是 **opt-in** 的，`trellis init` 不默认启用任何插件
- A2: 插件资源在 `trellis plugin add <name>` 或 `trellis update` 时写入目标平台
- A3: 存储默认本地（`.trellis/memory/` / `.agent-trace/`），云端后端作为可选配置
- A4: Code Attribution（Agent Trace 规范）和 Conversation Transcript 是**两个不同插件**，前者引用后者
- A5: 首批仅支持 Claude Code + OpenCode（真 hook 平台），Cursor 等 IDE 平台走降级或留空
- A6: Plugin 分发复用 Spec Marketplace 的 `--registry` 机制，不引入 npm 依赖

## Open Questions

（Blocking / Preference 问题，每次只问一个）

- Q1（当前待答）：MVP 范围 — 聚焦 Trace / 聚焦 Memory / 均分 / 只做机制 / 其他？

## Requirements (evolving)

### Plugin 机制本身
- [ ] 定义 Plugin Manifest schema（声明依赖 capability、平台适配、资源清单）
- [ ] `trellis plugin add/remove/list` 命令
- [ ] `.trellis/plugins/` 目录约定 + registry 远程拉取
- [ ] 插件资源写入/清理生命周期（复用 `writeMode` / migration manifest 机制）
- [ ] 插件启用状态持久化（`.trellis/config.json` 或类似）

### Memory Plugin（Claude Memory Tool 对齐版）
- [ ] 本地存储 `.trellis/memory/*.md`（Serena 风格，含项目 scope + 全局 `global/` 前缀）
- [ ] Tool schema **对齐 Claude API Memory Tool `memory_20250818`** 的 6 命令：`view` / `create` / `str_replace` / `insert` / `delete` / `rename`
- [ ] Skill 分发到 Claude Code / OpenCode（agent 主动调用模式）
- [ ] Handler 双通道：同一份核心逻辑同时充当 MCP server tool handler + Claude API Memory Tool handler
- [ ] `_index.md` 路由表约定（Reddit + Obsidian MCP 验证的省 token 最佳实践）
- [ ] 可选云端后端（Supermemory API）— MVP 不做

### Trace Plugin（架构重构：OTel 为内核 + 可插拔 exporter）
- [ ] **内部 source of truth**：`.trellis/tasks/{task}/traces/session-{uuid}.jsonl`
  - Schema 对齐 OpenTelemetry GenAI semantic conventions（span 基础 + `invoke_workflow` span）
  - Per-session JSONL，append-only
- [ ] **Conversation Transcript 归集**：
  - Claude Code：复制 `~/.claude/projects/<normalized>/<session>.jsonl` 增量到 trace 目录
  - OpenCode：plugin 订阅 event firehose，主动 dump 对话到 trace 目录
- [ ] **Pluggable Exporters**（可选启用）：
  - `agent-trace`：按 Cursor RFC 0.1.0 schema 导出到 `.agent-trace/traces.jsonl`（生态兼容）
  - `opentraces`：按 opentraces.ai v0.3.0 schema 导出（如采用）
  - `git-ai`：写 Git Notes（可选）
  - `langfuse` / `otel-otlp`：通过 OTLP 上报（后期）
- [ ] Hook 订阅（双平台）：
  - Claude Code：PostToolUse (Write/Edit/Bash) + UserPromptSubmit + SessionStart/End + Stop + SubagentStop
  - OpenCode：tool.execute.after + chat.message + session.idle（Stop 的降级替代）+ event firehose

## Acceptance Criteria (evolving)

- [ ] 用户能 `trellis plugin add memory` 启用记忆，AI 对话能写入 `.trellis/memory/`
- [ ] 用户能 `trellis plugin add trace` 启用追踪，对话过程写入 `.trellis/trace/transcripts/`，commit 时生成 `.agent-trace/traces.jsonl`
- [ ] 插件在 Claude Code / OpenCode 双平台有差异化实现，且不破坏 Trellis 核心流程
- [ ] `trellis plugin remove` 可清理，残留文件不影响平台运行
- [ ] Manifest schema 可被第三方理解和编写

## Definition of Done

- 测试：unit 测 manifest 解析、adapter 分发；integration 测 add/remove 生命周期
- Lint / typecheck / CI 绿
- 文档：插件开发指南 + 首批两个插件的使用文档
- Migration：如果改 `.trellis/` 结构，提供 migration manifest
- 向后兼容：现有用户 `trellis update` 不受影响

## Out of Scope (explicit)

- **首批不做**：Cursor/VSCode 等 IDE 平台的 trace 降级（事后扒 SQLite）
- **首批不做**：Memory plugin 的云端后端（Supermemory / 自建）
- **首批不做**：Plugin marketplace UI / 索引服务
- **首批不做**：插件间依赖解析（A 依赖 B）
- **首批不做**：插件沙箱 / 权限系统

## Technical Notes

### 初步架构方向

```
.trellis/plugins/<plugin-name>/
  manifest.json          # capability 声明
  skills/*.md            # → 复用 template 共享层
  hooks/*.py             # → 复用 shared-hooks 机制
  adapters/
    claude-code/         # → 复用 Configurator 注册
    opencode/            # → 复用 OpenCode plugin 范式
  migration/             # → 复用 migration manifest
```

### Capability 候选枚举

- `skill` — 注入 SKILL.md 到平台
- `hook:user-prompt-submit` / `hook:stop` / `hook:post-tool-use` — 订阅事件
- `storage:local` / `storage:remote` — 存储偏好
- `mcp-server` — 声明外部 MCP 依赖

### 可复用的 Trellis 已有资源

详见 `research/trellis-existing-extension-points.md`。核心：
- Shared Templates → skill/hook 分发
- OpenCode Plugins → hook 运行时范例
- Migration Manifests → 插件升级路径
- Spec Marketplace → registry 拉取机制
