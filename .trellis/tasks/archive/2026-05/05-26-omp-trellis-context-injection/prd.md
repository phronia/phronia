# OMP Trellis Extension: 补齐上下文注入和 SubAgent 精确注入

## Goal

升级 `.omp/extensions/trellis/index.ts`，补齐两个核心能力：
1. Session Start 富注入 — 提供项目全局地图（git/spec/task/identity）
2. SubAgent 精确注入 — 根据 agent 类型选择性注入 task context，减少 token 浪费

保留 OMP 原生 Extension API 的架构优势（进程内执行、类型安全、`context` 事件）。

## Requirements

### R1: Session Start 富注入

在 `session_start` 事件中通过 `pi.sendMessage()` 注入以下静态上下文（`display: false`）：

| 内容 | 来源 | 预估大小 |
|------|------|----------|
| Git branch + dirty count + 最近 3 commits | `spawnSync("git", ...)` | ~300B |
| Spec 索引 | `readdirSync(".trellis/spec/")` 递归一层 | ~500B |
| Active task 摘要 | 复用现有 `resolveActiveTaskStatus()` | ~100B |
| Developer identity | 读取 `.trellis/workspace/*/index.md` 匹配 git user | ~50B |

总计 ~1-2KB，格式为 `<session-context>` XML tag。

**不注入**：workflow.md 内容、task context 详情、spec 文件正文（这些由 `before_agent_start` 每轮负责）。

**Compaction 后不重新注入** — `before_agent_start` 的 workflow state 已足够保底，session start 信息在 compaction 后可能已过时。

### R2: SubAgent 精确注入

Sub-agent session 会重新加载 extension。利用 `PI_BLOCKED_AGENT` env var 区分 agent 类型：

| Agent 类型 | `PI_BLOCKED_AGENT` 值 | 注入内容 |
|-----------|----------------------|----------|
| `trellis-implement` | `"trellis-implement"` | `prd.md` + `info.md` + `implement.jsonl` 引用的文件 |
| `trellis-check` | `"trellis-check"` | `prd.md` + `info.md` + `check.jsonl` 引用的文件 |
| `trellis-research` | `"trellis-research"` | 仅 `prd.md` + `info.md` |
| 其他 / 主 session | 未设置或不匹配 | 全量注入（当前行为） |

**注入时机分工（方案 C）**：
- `session_start` → 重量级 task context 文件注入（一次性）
- `before_agent_start` → 仅 workflow state 刷新（轻量，每轮）

## Decision (ADR-lite)

**Context**: 当前 extension 对主 session 和 sub-agent 使用完全相同的注入逻辑，导致 sub-agent 收到冗余信息（如 check agent 收到 implement.jsonl 的文件），且 session start 缺乏全局视图。

**Decision**: 
- Session start 做"全局地图"（静态信息，一次性）
- before_agent_start 做"当前导航"（workflow state，轻量刷新）
- Sub-agent 中 session_start 做精确 task context 注入
- 不引入配置层（OMP 已有 `disabledExtensions` 机制）
- Compaction 后不重新注入（before_agent_start 保底）

**Consequences**: 
- Sub-agent token 消耗降低（仅注入相关 jsonl）
- AI 首轮即有项目全局认知
- 无新配置文件/新依赖
- 若未来需要更细粒度控制，可通过 env var 扩展

## Acceptance Criteria

- [ ] 主 session 首轮 AI 回复前，session context 已注入（含 git branch/dirty/commits + spec 索引 + task 摘要 + developer name）
- [ ] `trellis-implement` sub-agent 只收到 implement.jsonl 引用的文件，不含 check.jsonl
- [ ] `trellis-check` sub-agent 只收到 check.jsonl 引用的文件，不含 implement.jsonl
- [ ] `trellis-research` sub-agent 只收到 prd.md + info.md
- [ ] 主 session 的 before_agent_start 行为不变（backward compatible）
- [ ] 无 TypeScript 编译错误
- [ ] session_start 中的 git/spec 操作耗时 <500ms
- [ ] `pnpm test` 通过（含更新后的 omp.test.ts marker 断言）

## Definition of Done

- TypeScript 编译通过
- `pnpm test` 通过
- 手动验证三类 sub-agent 的 context 差异
- 代码风格与现有 extension 一致
- 不引入外部依赖（仅 Node.js stdlib + OMP Extension API）

## Out of Scope

- 配置层 / settings.json（不需要，平台已有 disable 机制）
- Windows 路径规范化
- 多平台检测
- 新增 commands / skills
- 修改 agent `.md` 文件（增厚 prompt 为独立任务）
- 修改 `.trellis/scripts/` Python 脚本
- `context` 事件裁剪优化（作为后续迭代）
- Compaction 后重新注入

## Technical Notes

### 文件影响范围（3 个文件）

| 文件 | 性质 |
|------|------|
| `.omp/extensions/trellis/index.ts` | 主改动 |
| `packages/cli/src/templates/omp/extensions/trellis/index.ts.txt` | 模板同步（内容 = 上面文件） |
| `packages/cli/test/templates/omp.test.ts` | 补充 marker 断言 |

### 不需要改动的文件

- `configurators/omp.ts` — 通过 `getExtensionTemplate()` 自动获得新内容
- `templates/omp/index.ts` — 导出函数签名不变
- `types/ai-tools.ts` — 平台注册信息不变
- `.trellis/scripts/common/cli_adapter.py` — 路径解析不变
- `.trellis/scripts/common/task_store.py` — subagent config 不变
- `regression.test.ts` — 现有断言测平台注册，不受内容变化影响

### 实现要点

1. **Session start 信息获取**:
   - `spawnSync("git", ["branch", "--show-current"])` → branch name
   - `spawnSync("git", ["status", "--porcelain"])` → dirty count
   - `spawnSync("git", ["log", "--oneline", "-3"])` → recent commits
   - `readdirSync(".trellis/spec/")` → spec package list, 每个 package 下一层列 layers
   - 复用 `resolveActiveTaskStatus()` → task title + status
   - 读取 `.trellis/workspace/` 下与 `git config user.name` 匹配的目录

2. **Sub-agent 检测**:
   - `process.env.PI_BLOCKED_AGENT` → agent name（子 session 中自动设置）
   - 存在此 env var → 当前是 sub-agent session

3. **Task context 拆分**:
   - 重构 `buildTaskContext()` 为 `buildTaskContext(projectRoot, taskDir, agentType?)`
   - `agentType` 未传时保持全量行为（backward compatible）
   - `agentType` 传入时只读取对应 jsonl

4. **注入方式**:
   - session_start: `pi.sendMessage({ customType: "trellis-session-context", content, display: false })`
   - sub-agent task context: 同样在 session_start 中注入（一次性）
   - before_agent_start: 保持仅 workflow state 注入（sub-agent 中也生效）

5. **模板同步规则**:
   - `.omp/extensions/trellis/index.ts` 与 `packages/cli/src/templates/omp/extensions/trellis/index.ts.txt` 内容完全相同
   - `replacePythonCommandLiterals()` 由 configurator 在 `trellis init --omp` 时自动应用
   - 模板源文件中直接写 `python3`
