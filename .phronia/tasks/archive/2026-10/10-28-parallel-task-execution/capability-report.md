# Phase 0 能力验证报告（W0）

- 任务：`.phronia/tasks/10-28-parallel-task-execution`
- 日期：2026-10-28
- 角色：research subagent（W0）
- 范围：验证 coordinator 模式所需的 5 项 harness 能力：并行子代理、每任务 cwd/worktree、显式 `task_ref` 转发、嵌套子代理、会话身份隔离。
- 约束：未修改任何生产代码；本文件是本次唯一写入。
- 证据等级：
  - **runtime-verified**：本机真实运行，有命令和观察到的输出。
  - **schema-verified**：本机安装的 harness 二进制/配置中包含可复现的 schema 或源码片段，命令和输出可复现，但未端到端跑子代理。
  - **docs-verified**：官方文档明确陈述，未在本机运行。
  - **unknown**：没有足够证据，附验证计划。

> 结论先行：**在当前三款主力 harness 中，只有 Claude Code 具备“单会话 coordinator + 每任务 workspace”的完整原语；ZCode 和 Codex 都能并行跑子代理，但子代理继承父会话 cwd，因此只能降级为多会话或串行。**

---

## 1. 环境

| 项 | 值 |
|---|---|
| OS | macOS 15.7.7 (24G720), arm64 |
| 当前 harness | ZCode 3.16.3（本会话即由 ZCode 主会话派发） |
| Node | v25.9.0 |
| pnpm | 10.32.1 |
| Python | 3.9.23 |
| git | 2.50.1 (Apple Git-155) |
| Claude Code | 2.1.217（`~/.local/share/claude/versions/2.1.217`） |
| Codex CLI | 0.149.1 |
| OpenCode | 2.0.32 |
| ZCode CLI | 无独立 `zcode` CLI；应用在 `/Applications/ZCode.app`，插件/会话状态在 `~/.zcode/cli` |

注：`claude` 无 `ANTHROPIC_API_KEY`，本次未做端到端的 Claude 子代理运行；Claude 的结论来自官方文档 + 本机二进制 schema。ZCode 的结论来自真实运行元数据。

---

## 2. 能力矩阵

`subagentContext` 来自现有 `packages/core/src/platform/capabilities.ts`；其余列是本次新增维度。

| Platform | subagentContext | execution | workspace | identity | task_ref 转发 | verdict | evidence |
|---|---|---|---|---|---|---|---|
| **ZCode 3.16.3** | hook `PreToolUse:Agent\|Task` | **parallel** | **inherited** | **isolated** | **none**（无字段；prompt hint 未被 hook 解析） | **multi-session** | runtime-verified |
| **Claude Code 2.1.217** | hook `PreToolUse:Task\|Agent` | **nested**（含 parallel） | **per-task**（`cwd` 或 `isolation:"worktree"`） | **shared**（父 `session_id`；有 `agent_id`） | 无字段；prompt-only；`cwd` 可隐式映射任务 | **coordinator**（schema+docs，端到端待跑） | schema-verified + docs-verified |
| **Codex 0.149.1** | hook `SubagentStart` | **parallel** | **inherited** | **isolated**（每 agent 一个 thread） | 无字段；prompt-only | **multi-session** | docs-verified + source/config-verified |
| OpenCode 2.0.32 | plugin `tool.execute.before` | unknown | unknown | unknown | unknown | **unknown** | 未评估，验证计划见 §10 |
| Cursor / Kiro / CodeBuddy / Droid / Pi / OMP / Snow | hook/extension（class-1） | unknown | unknown | unknown | unknown | **unknown** | 不在 W0 范围；沿用设计 §22.2 的 unknown |
| Gemini / Copilot / Qoder / Trae / Grok / Kimi / DSH / Kilo / Antigravity / Devin / Reasonix | none（class-2） | none | none | none | none | **unsupported** | 现有 B1 审计 |

> `execution="nested"` 视为 `parallel` 的超集；coordinator 门控条件仍是“至少 parallel + per-task workspace”。

---

## 3. ZCode（当前 harness）

### 3.1 结论

| 维度 | 值 | 证据等级 |
|---|---|---|
| 并行子代理 | 支持 | runtime-verified |
| 每子代理 cwd/worktree | **不支持**（继承父 cwd） | runtime-verified + schema |
| 显式 task_ref 字段 | **不支持**（Agent 工具没有该字段） | schema-verified |
| 嵌套子代理 | **不支持/被 runtime 收回 Agent 工具** | runtime-observed |
| 会话身份 | **isolated**（每个子代理有独立 `childSessionId`） | runtime-verified |
| 适用模式 | **multi-session**（每任务一个窗口/worktree），或串行 | — |

### 3.2 Agent 工具 schema：只有 4 个参数

从 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` 提取：

```js
wit = V.object({
  description: V.string().describe("A short (3-5 word) description of the task"),
  prompt: V.string().describe("The task for the agent to perform"),
  subagent_type: V.string().optional()
    .describe("The type of specialized agent to use for this task"),
  run_in_background: V.boolean().optional()
    .describe("Set to true to run this agent in the background. ...")
})
```

- **没有 `cwd`**，**没有 `isolation`**，**没有 `task_ref`**。
- 工具描述明确支持并行：*“Reach for this when ... you have independent work to run in parallel”*。
- 工具元数据：`concurrentSafe: true`、`sideEffectScope: "session"`。

### 3.3 子代理继承父 cwd（runtime-verified）

Agent handler 把父级 `workingDirectory` / `workspaceRoot` 原样传给子运行时：

```js
i = {
  sessionId: t.sessionId,
  ...
  workingDirectory: t.workingDirectory,
  workspaceRoot: t.workspaceRoot,
  ...
}
t.subagentPort.launch({ ...i, runInBackground: n.run_in_background === !0 }, ...)
```

实际观察：本会话（W0）与 W1 子代理的 `metadata.json`：

```json
{
  "agentId": "agent_0c952095-...",
  "childSessionId": "sess_subagent_agent_0c952095-...",
  "createdAt": "2026-10-28T08:34:56.365Z",
  "cwd": "/Users/magicdian/Documents/personal_project/phronia",
  "parentSessionId": "session_927ca545b98d51c8072d37407cdffef1",
  "workspaceRoot": "/Users/magicdian/Documents/personal_project/phronia",
  "profileId": "general-purpose"
}
```

W1 的 `createdAt` 是 `08:34:56.408Z`，与 W0 相差 43ms；两个子代理 `cwd` 完全相同，且当时两条记录都是 `status: "running"`。这证明了**并发派发**（parallel dispatch）和 **workspace=inherited**；单个子代理内部是否真正并行执行由 harness 调度决定，但两条记录同时存在已足以否定“single only”。

### 3.4 Workflow agent 的 `isolation:"worktree"` 是“声明了但没实现”

workflow agent 的 schema 有 `isolation: enum(["worktree"])`，但运行时直接抛错：

```js
if (o.opts?.isolation === "worktree")
  throw new Error("workflow agent isolation 'worktree' is not implemented yet.")
```

因此不能把 dynamic workflow 当作每任务 worktree 的替代路径。

### 3.5 嵌套子代理：子代理拿不到 Agent 工具

- `profileSnapshot.tools = ["*"]`，但本子代理会话实际可用的工具列表中**没有 `Agent`/`Task`**。
- bundle 中存在 `isSubagentChildRuntime` 分支，说明子运行时是独立类型；但未找到显式的 depth 配置。
- 结论：**nested 不支持（至少默认运行时不授予 Agent 工具）**。如果要提高置信度，做 §10 的受控实验。

### 3.6 task_ref 转发：核心代码支持，但 ZCode 没有入口

`buildSubagentSpawn` 的 `readTaskRef` 按以下顺序读取：

1. `hints.taskRef`（CLI 显式传入）
2. `input.task_ref` / `input.taskRef` / `input.active_task` / `input.activeTask`
3. `input.tool_input.task_ref` / `input.tool_input.taskRef`

ZCode 的 hook payload 是原始 `{session_id, tool_name, tool_input:{description,prompt,subagent_type,run_in_background}}`，上述字段都不存在。用真实 CLI 复现：

| 输入 | 观察输出 | 含义 |
|---|---|---|
| `subagent_type:"general-purpose"` | `diagnostics:[context.subagent.unknown_agent]`，`mutations:[]` | Phronia hook 不注入任何上下文 |
| `subagent_type:"phronia-research"` + `tool_input.task_ref:"..."` | `session.taskSource:"hint"`，`mutations:["set-prompt"]` | 核心逻辑**能**处理 task_ref，但 ZCode 工具不会产生该字段 |
| `subagent_type:"phronia-research"` + prompt 里写 `task_ref=...` | `session.task:null`，仅通用 research prompt | prompt 中的 task_ref **不被解析** |

> 关键缺口：当前 ZCode 路径是 `phronia hook` → `.zcode/hooks/phronia-hook.py` → `phronia context`，Python shim 原样转发 payload，不解析 `Active task:`。生成物 `packages/cli/src/templates/_generated/shims/v1|v2` 里有 `ACTIVE_TASK_HINT_RE`，但 ZCode 当前使用的 Python shim 路径没有。结果是：**同一 coordinator 会话派发多个任务时，hook 注入只能看到父会话的活动任务（或单会话 fallback），无法区分 A/B 任务。**

### 3.7 角色代理缺失（当前 checkout）

- 模板存在：`packages/cli/src/templates/zcode/agents/{phronia-implement,phronia-check,phronia-research}.md`。
- 但本 checkout 的 `.zcode/agents/` **不存在**；`git ls-files .zcode` 只有 `.zcode/.gitignore` 和 `.zcode/plans/...`。
- 后果：`subagent_type: "phronia-implement"` 等类型当前不可用；只能派发内置 `general-purpose`，而 `general-purpose` 会让 Phronia hook 走 `unknown_agent` 分支，完全不注入上下文。
- 这是仓库/初始化状态问题，不是 ZCode 的固有限制；但 W5 若要在 ZCode 上演示 coordinator，必须先 `phronia update` 生成 `.zcode/agents/`。

### 3.8 ZCode 降级建议

- **不要**在同一个 checkout 内并行派发多个任务：所有子代理共享 cwd，会互相覆盖文件。
- `dispatch` 在 ZCode 上应返回 `COORDINATOR_UNSUPPORTED`（或 `DEGRADED_MULTI_SESSION`），并输出多会话计划：
  - 每个任务：`git worktree add` 路径 + 新开一个 ZCode 窗口/工作区 + `Active task:` 提示。
- 串行子代理可行：同一时间只派发一个任务，仍有 hook 注入和任务隔离。

---

## 4. Claude Code

### 4.1 结论

| 维度 | 值 | 证据等级 |
|---|---|---|
| 并行子代理 | 支持（单条消息多个 Agent 调用） | docs-verified + schema |
| 每子代理 cwd/worktree | **支持**：`cwd`（绝对路径）或 `isolation:"worktree"` | schema-verified + docs-verified |
| 显式 task_ref 字段 | 无；但 `cwd` 可作为隐式任务映射 | schema-verified |
| 嵌套子代理 | 支持，默认最多 3 层（可配） | docs-verified |
| 会话身份 | **shared**（父 `session_id`；子代理有独立 `agent_id`） | docs-verified |
| 适用模式 | **coordinator**（端到端待跑） | — |

### 4.2 Agent 工具 schema（本机 2.1.217 二进制提取）

```js
RR_ = v.object({
  description, prompt, subagent_type, model, run_in_background
})
xR_ = RR_().merge(v.object({
  name, team_name, mode
})).extend({
  isolation: v.enum(["worktree","remote"]).optional()
    .describe('"worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.'),
  cwd: v.string().optional()
    .describe('Absolute path to run the agent in. Overrides the working directory for all filesystem and shell operations within this agent. Mutually exclusive with isolation: "worktree".')
})
```

- `cwd` 是 coordinator 最需要的原语：Phronia 可以先 `workspace prepare` 出 worktree，再把绝对路径传给 Agent。
- `isolation:"worktree"` 由 Claude 自己建临时 worktree，路径/branch 由它决定并在结果中返回；如果 Phronia 需要自己拥有 task↔worktree 映射，优先用 `cwd`。
- 二者互斥。

### 4.3 官方文档要点

- 子代理默认从主会话 cwd 启动；`isolation: worktree` 让 Bash/PowerShell 在独立 worktree 内运行，并阻止编辑主 checkout。
- 并行：*“If the user specifies that they want you to run agents in parallel, you MUST send a single message with multiple tool use content blocks.”*
- 并发上限：`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`（二进制内错误文案：*“Concurrent subagent limit reached. You can run N subagents at once.”*）。
- 嵌套：默认子代理可以继续派发，最多主会话下 3 层；`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 可调，`1` 关闭嵌套。
- Hook：子代理内工具调用会触发同样的 `PreToolUse`/`PostToolUse`，payload 带 `agent_id` 和 `agent_type`；`session_id` 仍是父会话。
- 与 ZCode 相同的注入口缺口：`.claude/hooks/phronia-hook.py` 也是原样转发 payload，不解析 prompt 里的 `Active task:`。因此 prompt-only 的 task_ref 只对“角色代理自己的 fallback”有效，不会改变 hook 注入的任务。W5 应扩展 `readTaskRef` 解析 prompt，或利用 `tool_input.cwd` 做 workspace→task 映射。

### 4.4 Claude Code 降级/门控建议

- 原生 coordinator 可行，但要求：
  1. `dispatch` manifest 里每个任务带 `workspace` 绝对路径；
  2. 派发 prompt 首行写 `Active task: <path>`；
  3. 调用 Agent 时带 `cwd: <workspace>`；
  4. 所有 Phronia 命令显式 `--task`（identity=shared，不能依赖活动任务指针）。
- 如果 live 验证发现 `cwd` 不被模型/运行时接受（或仅在 teammate 模式不可用），降级为多会话：每个任务 `claude --worktree <name>`。

---

## 5. Codex

### 5.1 结论

| 维度 | 值 | 证据等级 |
|---|---|---|
| 并行子代理 | 支持（`agents.max_threads` 默认 6） | docs-verified + config |
| 每子代理 cwd/worktree | **不支持**（继承父 environments/cwd） | source-verified |
| 显式 task_ref 字段 | 无 | source-verified |
| 嵌套子代理 | 默认 `max_depth=1`，只允许根会话派发直接子代理；本仓库显式 pin 1 | docs-verified + config |
| 会话身份 | **isolated**（每次 spawn 新 thread，带 `parent_thread_id`） | source-verified |
| 适用模式 | **multi-session**（`codex exec -C <worktree>`） | — |

### 5.2 证据

`codex features list`：

```
multi_agent        stable   true
multi_agent_v2     stable   false   # 默认未启用
```

`codex-rs/core/src/tools/handlers/multi_agents/spawn.rs`：

```rust
struct SpawnAgentArgs {
    message: Option<String>,
    items: Option<Vec<...>>,
    agent_type: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<...>,
    #[serde(default)]
    fork_context: bool,
}
...
options: SpawnAgentOptions {
    environments: Some(step_context.inherited_environments.clone()),
    ...
}
```

- **没有 cwd 参数**；子代理继承父 turn 的 environments（含工作目录）。
- `agent_control.spawn` 创建新 thread，`parent_thread_id` 记录父级 → 身份 isolated。
- 本仓库 `.codex/config.toml`：

```toml
[agents]
max_depth = 1
```

官方文档：`agents.max_depth` 默认 1，根会话可以派发直接子代理，但不允许更深嵌套；`agents.max_threads` 默认 6。仓库显式 pin 1 是为了关闭递归派发（注释引用 #240/#241）。

### 5.3 Codex 降级建议

- 原生子代理不能做每任务 workspace，因此 **不要**用 `spawn_agent` 并行跑不同任务（会全部改父 checkout）。
- 多会话：每个任务在 Phronia 准备好的 worktree 里跑 `codex exec -C <workspace>`；`-C/--cd` 是真实的 CLI 参数（`codex exec --help` 已确认）。
- 串行：同一 checkout 内一次只派发一个子代理。
- `.codex/hooks/phronia-hook.py` 同样不解析 prompt 中的 `Active task:`；如果 coordinator 用 Codex 原生子代理，必须扩展 `readTaskRef`，否则注入的任务来自父会话。

---

## 6. 降级矩阵（可直接用于 W5 policy）

| Platform | coordinator | multi-session | serial | 备注 |
|---|---|---|---|---|
| Claude Code | ✅ 原生（`cwd`） | ✅ `claude --worktree` | ✅ | identity=shared，必须显式 `--task` |
| Codex | ❌ | ✅ `codex exec -C <dir>` | ✅ | 子代理继承 cwd |
| ZCode | ❌ | ✅ 每任务一个窗口/worktree | ✅ | 子代理继承 cwd；workflow worktree 未实现 |
| class-2（Gemini 等） | ❌ | ✅（人工） | ✅ | 无子代理面 |
| class-1 未验证 | unknown | ✅ | ✅ | 在 Phase 0 补齐前不得 coordinator |

COORD-03 的返回建议：

```json
{
  "code": "COORDINATOR_UNSUPPORTED",
  "reason": "subagentWorkspace=inherited",
  "fallback": "multi-session",
  "next": "phronia task workspace prepare --task <ref> && open a new session in <path>"
}
```

---

## 7. capabilities.ts / features.ts 草稿（不要应用）

### 7.1 类型扩展

设计 §22.1 的三元类型没有 `unknown`，但 §22.2 要求“Phase 0 之前一律 unknown”。建议补上 `unknown`，否则无法表达“未验证”，会被默认为某个值。

```ts
// Draft only — do not apply in W0.
export type SubagentExecution = "unknown" | "none" | "single" | "parallel" | "nested";
export type SubagentWorkspace = "unknown" | "inherited" | "per-task";
export type SubagentIdentity = "unknown" | "shared" | "isolated";

/** How a task reference reaches the harness, if at all. */
export type SubagentTaskRef = "native" | "prompt-only" | "none";

export interface SubagentCapabilities {
  execution: SubagentExecution;
  workspace: SubagentWorkspace;
  identity: SubagentIdentity;
  taskRef: SubagentTaskRef;
}
```

在 `PlatformCapabilities` 增加：

```ts
subagent: SubagentCapabilities;
```

### 7.2 平台值

| Platform | subagentExecution | subagentWorkspace | subagentIdentity | subagentTaskRef |
|---|---|---|---|---|
| `claude-code` | `nested` | `per-task` | `shared` | `prompt-only` |
| `codex` | `parallel` | `inherited` | `isolated` | `prompt-only` |
| `zcode` | `parallel` | `inherited` | `isolated` | `none` |
| 其余 19 个 | `unknown` | `unknown` | `unknown` | `none` |

```ts
const SUBAGENT: Record<PlatformId, SubagentCapabilities> = {
  "claude-code": {
    // docs + shipped schema; live subagent run pending (no API key in W0)
    execution: "nested",
    workspace: "per-task",
    identity: "shared",
    taskRef: "prompt-only",
  },
  codex: {
    // docs + spawn.rs + .codex/config.toml
    execution: "parallel",
    workspace: "inherited",
    identity: "isolated",
    taskRef: "prompt-only",
  },
  zcode: {
    // runtime-verified on 3.16.3: two agents, same cwd, distinct child sessions
    execution: "parallel",
    workspace: "inherited",
    identity: "isolated",
    taskRef: "none",
  },
  // ...all other platforms: unknown/unknown/unknown/none until Phase 0 covers them
};
```

### 7.3 `features.ts` 门控草稿

新增 `FeatureId = "coordinator.mode"`，并 fail-closed：

```ts
case "coordinator.mode": {
  const sub = capabilities.subagent;
  if (sub.execution === "unknown" || sub.workspace === "unknown") {
    return "subagent capabilities are unknown; Phase 0 verification is required";
  }
  if (sub.execution === "none" || sub.execution === "single") {
    return `subagentExecution: ${sub.execution}`;
  }
  if (sub.workspace !== "per-task") {
    return "subagentWorkspace: inherited; use multi-session instead";
  }
  return null;
}
```

注意：`execution === "nested"` 必须通过“至少 parallel”的门控；不要写成 `!== "parallel"`。

---

## 8. 完整命令与裁剪输出

### 8.1 环境

```bash
$ sw_vers
ProductName:    macOS
ProductVersion: 15.7.7
BuildVersion:   24G720

$ uname -m
arm64

$ claude --version
2.1.217 (Claude Code)

$ codex --version
codex-cli 0.149.1

$ opencode --version
opencode v2.0.32

$ /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/ZCode.app/Contents/Info.plist
3.16.3
```

### 8.2 ZCode：并行的真实元数据

```bash
$ python3 - <<'PY'
import json, glob
pat = '/Users/magicdian/.zcode/cli/agents/session_927ca545b98d51c8072d37407cdffef1/agent_*/metadata.json'
for f in sorted(glob.glob(pat)):
    d = json.load(open(f))
    print(d['agentId'], d['createdAt'], d['cwd'], d['childSessionId'], d['status'])
PY
agent_0c952095-... 2026-10-28T08:34:56.365Z /Users/.../phronia sess_subagent_agent_0c952095-... running
agent_23a4666f-... 2026-10-28T08:34:56.408Z /Users/.../phronia sess_subagent_agent_23a4666f-... running
```

（`metadata.json` 的 `parentSessionId` 均为 `session_927ca545b98d51c8072d37407cdffef1`，即本 W0/W1 的主会话。）

### 8.3 ZCode：Agent schema 与继承 cwd

```bash
$ rg -o 'subagent_type:V.string...' /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
subagent_type:V.string().optional().describe("The type of specialized agent ...")

$ rg -o 'workingDirectory:t.workingDirectory.{0,60}' zcode.cjs
workingDirectory:t.workingDirectory,workspaceRoot:t.workspaceRoot

$ rg -o "workflow agent isolation 'worktree' is no.{0,40}" zcode.cjs
workflow agent isolation 'worktree' is not implemented yet.
```

### 8.4 ZCode：task_ref 探针

```bash
# general-purpose：不注入
$ echo '{"session_id":"probe-zcode-1","tool_name":"Agent","tool_input":{"subagent_type":"general-purpose","prompt":"do work"}}' \
  | node packages/cli/dist/cli/index.js context --event subagent-spawn --platform zcode --project-root "$PWD" --input - --json
{ "session": { "task": null, "taskSource": "none" },
  "mutations": [],
  "diagnostics": [ { "code": "context.subagent.unknown_agent" } ] }

# phronia-research + tool_input.task_ref：核心逻辑接受（但 ZCode 不会产生该字段）
$ echo '{"session_id":"probe-zcode-2","tool_name":"Agent","tool_input":{"subagent_type":"phronia-research","prompt":"research","task_ref":".phronia/tasks/10-28-parallel-task-execution"}}' \
  | node packages/cli/dist/cli/index.js context --event subagent-spawn --platform zcode --project-root "$PWD" --input - --json
{ "session": { "task": ".phronia/tasks/10-28-parallel-task-execution", "taskSource": "hint" },
  "mutations": [ "set-prompt" ] }

# 只在 prompt 里写 task_ref：不被解析
$ echo '{"session_id":"probe-zcode-3","tool_name":"Agent","tool_input":{"subagent_type":"phronia-research","prompt":"task_ref=.phronia/tasks/10-28-parallel-task-execution"}}' \
  | node packages/cli/dist/cli/index.js context --event subagent-spawn --platform zcode --project-root "$PWD" --input - --json
{ "session": { "task": null, "taskSource": "none" }, "mutations": 1 }
```

### 8.5 Claude Code：schema 与文档

```bash
$ rg -a -o 'isolation:v.enum\(\["worktree","remote"\]\).{0,400}' ~/.local/share/claude/versions/2.1.217
isolation:v.enum(["worktree","remote"]).optional().describe('Isolation mode. ...')
cwd:v.string().optional().describe('Absolute path to run the agent in. ... Mutually exclusive with isolation: "worktree".')
```

文档（`code.claude.com/docs/en/sub-agents`、`/en/worktrees`、`/en/agents`、`/en/hooks`）明确：

- 子代理默认从主会话 cwd 启动；`isolation: worktree` 提供隔离副本。
- 并行：单条消息多个 tool call。
- 嵌套：默认最多 3 层，`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 可调。
- 子代理内 hook payload 带 `agent_id` / `agent_type`，`session_id` 仍为父会话。

### 8.6 Codex：特性、spawn 参数、配置

```bash
$ codex features list | rg 'multi_agent'
multi_agent      stable  true
multi_agent_v2   stable  false

$ codex exec --help | rg -A1 -- '-C, --cd'
-C, --cd <DIR>
    Tell the agent to use the specified directory as its working root
```

`spawn.rs` 的 `SpawnAgentArgs` 只有 `message/items/agent_type/model/reasoning_effort/fork_context`，并传入 `environments: inherited_environments`。

`.codex/config.toml`：

```toml
[agents]
max_depth = 1
```

---

## 9. 对 W5（coordinator）的直接建议

1. **能力门控 fail-closed**：`unknown` 一律视为不可用；只有 `execution ∈ {parallel, nested}` 且 `workspace === "per-task"` 才允许 `coordinator.mode`。
2. **不要依赖 `tool_input.task_ref`**：ZCode / Claude Code / Codex 的 Agent 工具都不暴露该字段。要么在 `readTaskRef` 里解析 prompt 的 `Active task:` 行，要么在 manifest 里把完整任务路径写进 prompt，让角色代理的 fallback 读取。推荐前者，因为 hook 注入也需要正确的任务。
3. **ZCode 必须降级**：`dispatch` 返回 `COORDINATOR_UNSUPPORTED` + 多会话命令；不要在同一 checkout 并行。
4. **Codex 必须降级**：用 `codex exec -C <worktree>` 多会话，不要用原生 `spawn_agent` 并行不同任务。
5. **Claude Code 是唯一原生 coordinator 候选**：manifest 带 `workspace`，Agent 调用带 `cwd`，prompt 首行 `Active task:`，所有命令显式 `--task`。
6. **ZCode 角色代理是前置条件**：当前 checkout 没有 `.zcode/agents/`；W5 dogfood 前需生成 `phronia-implement/check/research`，否则 hook 永远走 `unknown_agent`。
7. **COORD-03 的行为要区分三种**：`unsupported`（class-2）、`degraded-multi-session`（ZCode/Codex）、`available`（Claude Code）；不要静默 no-op。

---

## 10. 未决问题与真机验证计划

| # | 问题 | 影响 | 验证计划 |
|---|---|---|---|
| 1 | Claude Code 的模型/运行时是否在所有上下文中接受 `cwd`（`Wws` schema 在某些模式下 omit 了 `cwd`） | 决定 Claude coordinator 是否可用 | 在有 API key 的环境跑：`claude -p` + 一个带 `cwd:/tmp/probe` 的 Agent 调用，子代理执行 `pwd` 并回报；同时用 PreToolUse hook 记录 `tool_input.cwd` |
| 2 | ZCode 子代理执行 Bash 时，PreToolUse payload 的 `session_id` 是父会话还是 `childSessionId` | 决定 identity 在 Phronia 层是 shared 还是 isolated | 临时 hook 记录 stdin；在子代理里跑 `phronia task current`；检查 session 文件 key 是否 `claude_sess_subagent_...` |
| 3 | Codex `SubagentStart` payload 是否包含初始 prompt 与子 thread id | 决定能否在 spawn 时解析 `Active task:` | 写一个只记录 stdin 的 `.codex/hooks` 脚本，跑 `codex exec` 要求 spawn 一个子代理，检查 key 集合 |
| 4 | ZCode 是否对所有子代理都收回 `Agent` 工具，还是仅此 profile/会话 | 决定 nested 的最终值 | 创建一个 `tools:["*"]` 的 `.zcode/agents/probe.md`，从主会话派发，要求它再派发一个子代理，观察是否报 `agent_subagent_unavailable` |
| 5 | ZCode workflow agent 的 `isolation:"worktree"` 是否会在未来版本实现 | 决定是否需要保留“workflow 作为 per-task”备选 | 每个 ZCode 版本升级后重跑 `zcode.cjs` 的 `not implemented yet` 检查 |
| 6 | Claude Code 的 `session_id` 在子代理 hook 中是否确实不变 | identity 列从 docs 推断变为实测 | 同 #1 的 hook 日志，比较父子 payload 的 `session_id` 和 `agent_id` |
| 7 | OpenCode 2.0.32 的 `subagent` 工具是否有 cwd/目录参数 | 第四个候选平台 | 读 `opencode` 安装包的 tool schema；跑一个 `subagent` 调用让它 `pwd` |

---

## 11. 证据文件索引

| 证据 | 路径 |
|---|---|
| ZCode 主 bundle | `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` |
| ZCode 并行子代理元数据 | `~/.zcode/cli/agents/session_927ca545b98d51c8072d37407cdffef1/agent_*/metadata.json` |
| ZCode hook 配置 | `.zcode/plugins/phronia/hooks/hooks.json`、`.zcode/hooks/phronia-hook.py` |
| ZCode 角色代理模板 | `packages/cli/src/templates/zcode/agents/*.md` |
| ZCode hook 入口 | `packages/cli/src/commands/hook.ts` |
| task_ref 解析 | `packages/core/src/context/subagent/index.ts`（`readTaskRef`） |
| 会话 key 解析 | `packages/core/src/state/session/key.ts` |
| Claude Code 二进制 | `~/.local/share/claude/versions/2.1.217` |
| Claude Code 官方文档 | <https://code.claude.com/docs/en/sub-agents>、<https://code.claude.com/docs/en/worktrees>、<https://code.claude.com/docs/en/agents>、<https://code.claude.com/docs/en/hooks> |
| Codex spawn 源码 | <https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs> |
| Codex 官方文档 | <https://developers.openai.com/codex/subagents>（归档：<https://web.archive.org/web/20260524042439/https:/developers.openai.com/codex/subagents>） |
| Codex 项目配置 | `.codex/config.toml` |
| 现有能力矩阵 | `docs/platform-matrix.md`、`packages/core/src/platform/capabilities.ts` |
