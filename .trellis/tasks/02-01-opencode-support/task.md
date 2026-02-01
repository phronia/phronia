# OpenCode 适配任务清单

基于 PRD 中的 28 个设计决策，整理需要实现的具体任务。

---

## Phase 1: CLI Adapter (P0)

### 1.1 创建 CLI Adapter 模块
- [ ] 创建 `.trellis/scripts/common/cli_adapter.py`
- [ ] 实现 `get_ai_cli_command(platform, agent, session_id, prompt)` 函数
- [ ] 实现 `get_agent_name(agent, platform)` 函数（plan → trellis-plan）
- [ ] 实现 `get_verbose_flags(platform)` 函数
- [ ] 实现 `get_skip_permissions_flag(platform)` 函数

### 1.2 参数映射表

| 功能 | Claude Code | OpenCode |
|-----|-------------|----------|
| 非交互模式 | `-p` | `run` |
| 指定 agent | `--agent <name>` | `--agent <name>` |
| Session ID | `--session-id <uuid>` | 不支持创建时指定 |
| 恢复会话 | `--resume <id>` | `--session <id>` |
| 跳过权限 | `--dangerously-skip-permissions` | `--yolo` |
| JSON 输出 | `--output-format stream-json` | `--format json` |
| 详细日志 | `--verbose` | `--log-level DEBUG --print-logs` |

---

## Phase 2: Multi-Session 脚本适配 (P1)

### 2.1 修改 `start.py`
- [ ] 添加 `--platform` 参数
- [ ] 使用 CLI adapter 构建命令
- [ ] 根据平台设置环境变量（OpenCode 不需要 `CLAUDE_NON_INTERACTIVE`）
- [ ] 保存 platform 到 `registry.json`
- [ ] OpenCode 分支：启动后从日志获取 session ID

### 2.2 修改 `plan.py`
- [ ] 添加 `--platform` 参数
- [ ] 使用 CLI adapter 构建命令
- [ ] 验证 agent 存在（各平台路径不同）
- [ ] Agent 名称映射：`plan` → `trellis-plan`（OpenCode）

### 2.3 修改 `status.py`
- [ ] 从 registry 读取 platform 字段
- [ ] 根据 platform 输出正确的恢复命令
- [ ] 根据 platform 解析不同的日志格式

### 2.4 修改 `create_pr.py`
- [ ] 无需改动（纯 git 操作，平台无关）

### 2.5 修改 `cleanup.py`
- [ ] 无需改动（纯文件系统操作）

---

## Phase 3: Hooks → Plugins (P1)

### 3.1 创建 OpenCode Plugin 目录结构
```
.opencode/
├── plugins/
│   ├── trellis-session.js      # session.created
│   ├── trellis-context.js      # tool.execute.before (Task)
│   └── trellis-ralph.js        # stop hook
└── commands/
    └── trellis/
        ├── start.md
        ├── parallel.md
        └── ...
```

### 3.2 Session Start Plugin
- [ ] 创建 `trellis-session.js`
- [ ] 实现 `session.created` 事件处理
- [ ] 调用 `get_context.py` 获取上下文
- [ ] 注入 workflow 和 guidelines

### 3.3 Context Injection Plugin
- [ ] 创建 `trellis-context.js`
- [ ] 实现 `tool.execute.before` 事件处理
- [ ] 检测 Task 工具调用
- [ ] 读取 `.current-task` 和 JSONL 文件
- [ ] 修改 input.prompt 注入上下文

### 3.4 Ralph Loop Plugin
- [ ] 创建 `trellis-ralph.js`
- [ ] 实现 `stop` hook
- [ ] 读取 `worktree.yaml` 的 verify 配置
- [ ] 执行验证命令
- [ ] 管理 `.ralph-state.json` 状态

---

## Phase 4: Agent 定义 (P1)

### 4.1 创建 OpenCode Agent 配置

在 `opencode.json` 中添加：

```json
{
  "agent": {
    "dispatch": { ... },
    "trellis-plan": { ... },
    "implement": { ... },
    "check": { ... },
    "research": { ... },
    "debug": { ... }
  }
}
```

### 4.2 各 Agent 配置
- [ ] `dispatch` - 纯调度器，调用其他 subagent
- [ ] `trellis-plan` - 评估需求，创建 PRD（避开内置 plan）
- [ ] `implement` - 实现代码
- [ ] `check` - 检查和自修复
- [ ] `research` - 只读研究
- [ ] `debug` - 修复问题

### 4.3 Agent Prompt 差异
- [ ] Dispatch Agent 需要两个版本（Claude Code / OpenCode）
- [ ] Task 工具调用语法可能不同
- [ ] TaskOutput 轮询机制需要验证

---

## Phase 5: Commands 迁移 (P2)

### 5.1 复制 Commands 到 OpenCode 目录
```bash
cp -r .claude/commands/trellis/ .opencode/commands/trellis/
```

### 5.2 调整命名
- Claude Code: `/trellis:start`
- OpenCode: `/project:trellis:start`

### 5.3 验证 Commands 格式兼容性
- [ ] YAML frontmatter 格式
- [ ] `$ARGUMENTS` 变量
- [ ] 可选：利用 OpenCode 的 `agent:` 和 `subtask:` 增强功能

---

## Phase 6: Init 流程适配 (P2)

### 6.1 修改 `trellis init`
- [ ] 添加 OpenCode 平台选项
- [ ] 选择 OpenCode 时生成：
  - `.opencode/plugins/` 下的 plugin 文件
  - `.opencode/commands/` 下的 command 文件
  - `opencode.json` 基础配置模板

---

## Phase 7: 日志解析适配 (P2)

### 7.1 修改 `status.py` 日志解析

Claude Code 格式：
```json
{"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read"}]}}
```

OpenCode 格式：
```json
{"type": "tool_use", "tool": "bash", "state": {"status": "completed"}}
```

- [ ] 实现 `get_last_tool(log_file, platform)`
- [ ] 实现 `get_last_message(log_file, platform)`

---

## 验收标准

### 基础功能
- [ ] `opencode run --agent implement` 能正确注入上下文
- [ ] `opencode run --agent check` 能正确执行检查
- [ ] Multi-Session 脚本能在 OpenCode 下启动 agent
- [ ] Session Start 能注入 workflow 和 guidelines

### 完整流程
- [ ] `/trellis:parallel` 能在 OpenCode 下完整运行
- [ ] Plan → Implement → Check → Create PR 流程正常
- [ ] Ralph Loop 能正确阻止未通过验证的 agent
- [ ] `status.py` 能正确显示 OpenCode agent 状态

### 混合使用
- [ ] 同一项目可以同时使用 Claude Code 和 OpenCode
- [ ] Registry 能区分不同平台的 agent
- [ ] 恢复命令能正确输出对应平台的命令

---

## 已知限制

1. OpenCode 无法在创建时指定 session ID，需要启动后获取
2. OpenCode `plan` agent 名称被占用，需要用 `trellis-plan`
3. OpenCode `opencode run` 可能在 API 错误时挂住（Issue #8203）
4. OpenCode 没有内置 retry 机制（Issue #3011）

---

## 参考文档

- PRD: `prd.md`
- Claude Code Hooks: `.claude/hooks/`
- Multi-Session Scripts: `.trellis/scripts/multi_agent/`
- Agent Definitions: `.claude/agents/`
