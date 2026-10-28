# 调研：并行 agent 的准入控制与能力降级

> 目的：确认"派发前准入判定"是否是一个成熟模式，以及各 harness 能否阻断工具调用。
> 采集时间：2026-10-28。

## 1. 结论

1. **派发前 preflight 是业界共识。** 多个并行 agent 编排方案都把"worktree 预检 + 不满足就拒绝派发"作为第一道门，而不是让 agent 自己遵守约定。
2. **只读代理不需要隔离，写代理必须隔离。** 这是多个方案共同的分界线，和 Phronia 的 `research` vs `implement/check` 一致。
3. **能否阻断是平台能力，不是实现细节。** Claude Code / ZCode / OpenCode 能阻断；Codex 的 `SubagentStart` 只能注入。必须显式建模并降级。
4. **准入判定必须是纯函数。** 所有方案都把"检查"和"执行"分开，检查只读事实、输出可解释决定；这与 Phronia 现有 `decideWorkspace` / `planParallel` / `canRunCoordinator` 的分层一致。

## 2. 外部参考

### 2.1 Worktree Preflight（claude-plugins / parallel-agent-dispatch）

来源：<https://github.com/laurigates/claude-plugins/blob/main/agent-patterns-plugin/skills/parallel-agent-dispatch/SKILL.md>

> Before spawning, the orchestrator must verify: main working tree clean; no existing worktree at each planned path; each agent gets a unique branch; target branch not taken.
> **If any check fails, refuse to dispatch and report the blocker. Do not "clean up" uncommitted user work; surface it and ask.**

要点：

- 检查项是"事实 + 冲突"，不是"agent 承诺"。
- 失败时拒绝派发，并报告阻塞项。
- 不做破坏性"清理"。

对本任务的映射：`DISPATCH_WRONG_CHECKOUT / DISPATCH_MAIN_CLAIMED / DISPATCH_ISOLATION_REQUIRED` 就是 refuse-to-dispatch 的具体化。

### 2.2 G-WORKTREE / G-INTERLOCK（fable-it v3 safe parallel spec）

来源：<https://github.com/DevOtts/fable-it/blob/main/docs/04-v3-safe-parallel-spec.md>

> G-WORKTREE — Trigger: before fanning out parallel agents that **write/edit** files. Test: does every mutating agent have its own working tree, or are ≥2 sharing one? Action: each parallel mutating agent runs in its own git worktree; the coordinator alone merges branches back, sequentially. **Read-only fan-out may share the tree.**
>
> G-INTERLOCK — Trigger: run start and before spawning any parallel mutating agent. Test: is another live run/agent/session already operating on this working tree? Evidence: RUNLOCK held by a live owner (pid + heartbeat), in-flight git operation, dirty index mid-merge. Action: acquire RUNLOCK; if held live → do not co-mutate, report BLOCKED or wait. Stale lock may be reclaimed with a logged note.

要点：

- **"mutating" 是触发条件**，只读不强制隔离。
- 互斥用显式锁 + 心跳 + 陈旧回收，和 Phronia 的 lease/claim 模型一致。
- 多个 mutating agent 共享一棵树 = 违规。

对本任务的映射：`agentType` 分 `mutating / read-only`；`DISPATCH_ISOLATION_REQUIRED` 只在 mutating 时触发。

### 2.3 fail-closed isolation（agents-fleet）

来源：<https://docs.agents-fleet.ai/advanced/worktrees>

> Shell-capable or unrestricted-write workers → isolated worktree. Read-only and scoped write-only workers → share the main working directory.
> **Fail-closed isolation — when an effective profile requires isolation and worktree creation fails, the worker fails before provider startup instead of falling back to the shared working tree.**
> Worktrees separate files and branches but not ports, databases, caches, secrets, or background processes.

要点：

- 隔离失败时**在启动前失败**，不回落到共享目录。
- worktree 不隔离运行时资源（端口/DB）。这句话应该原样进入 Phronia 文档的 Non-Goals。

对本任务的映射：平台不能阻断时不能静默放行；必须注入守卫并显式标注 `DISPATCH_PLATFORM_CANNOT_BLOCK`。

### 2.4 其它一致信号

- Warden（<https://github.com/Gentoflakes/warden>）：每个工作单元独立 worktree，结果经过确定性 verify + 独立 audit，失败即 fail-closed。
- OpenSpawn（<https://docs.openspawn.ai/architecture/worktree-isolation/>）：per-agent worktree 自动创建，并把 worktree 路径通过环境变量传给子进程。
- agentpatterns.ai（<https://agentpatterns.ai/workflows/worktree-isolation/>）：明确列出 worktree 的代价（每个 worktree 重新安装依赖、磁盘压力、orchestrator 复杂度）和"只读 agent 不需要隔离"。

## 3. 平台阻断能力证据

### 3.1 ZCode 3.16.3 (8992, a82dd43e)：支持 `permissionDecision: "deny"`

在 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` 中：

- PreToolUse 的 hook 输出 schema 包含：

  ```text
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: enum(["allow","ask","deny"]),
    permissionDecisionReason?: string,
    updatedInput?: unknown,
    additionalContext?: string
  }
  ```

- 内部逻辑把 hook 的决定写回：`permissionDecision?.decision === "deny" ? "deny" : "allow"`。
- 另有一条路径把 `hookEventName: PreToolUse` 的 deny 转成 `{continue:false, reason, permissionDecision:"deny"}`。

**真实运行验证（2026-10-28，ZCode 3.16.3 (8992, a82dd43e)，本机）**

bundle 只能证明代码路径存在，因此做了一次端到端探针：

1. 在独立项目 `/Users/magicdian/Documents/personal_project/aaa-zcode-deny-probe` 安装一个只对 token 生效的插件：
   - `PreToolUse` matcher `Agent|Task`；
   - prompt 含 `ZCODE_DENY_PROBE` 时输出 `permissionDecision:"deny"` + `permissionDecisionReason`；
   - 其它 prompt 原样放行；
   - 每次触发写 `/tmp/zcode-deny-probe/probe.log`。
2. 用 ZCode 新建会话，发送一条明确要求"只调用一次 Agent（`general-purpose`），prompt 以 `ZCODE_DENY_PROBE` 开头"的请求。
3. 结果（来自 `~/.zcode/cli/db/db.sqlite` 的 `part` 表，探针会话 `session_c5fc40067adefae0d0e9380914a3ab27`）：

```json
{
  "type": "tool",
  "tool": "Agent",
  "state": {
    "status": "error",
    "input": { "subagent_type": "general-purpose", "prompt": "ZCODE_DENY_PROBE ..." },
    "error": "ZCODE_DENY_PROBE: subagent dispatch blocked by the deny-probe plugin. Do not retry; report this exact message."
  }
}
```

4. `session` 表中 `parent_id = session_c5fc40067...` 的子会话数量为 **0**；最近的子会话仍是 21:38 的事故会话。
5. 父模型收到的是 tool `error`，没有收到 `PROBE_RAN`，也没有重试。

结论：

- **ZCode 确实阻止了子代理派发**：没有创建子会话，子代理没有运行。
- 但 deny 的**交付通道是工具错误结果**，不是权限层拒绝（UI 仍会先画出子代理卡片，这是工具调用的可视化，不代表子代理已运行）。
- 因此 `hookPolicy = "block"` 成立；渲染时 `permissionDecisionReason` 必须自包含，并明确写 "Do not retry"，因为父模型看到的是 tool error，不是权限弹窗。
- 这也解释了为什么 UI 里会出现"正在执行 TPS 脚本"：那是**父会话自己的** TPS hook，不是子代理；权限提示里的 `ZCODE_SESSION_ID` 是父会话 id。

### 3.2 Claude Code：可以阻断，但有历史坑

来源：<https://code.claude.com/docs/en/hooks>

- `PreToolUse` 可以阻断：exit 2 或 `permissionDecision: "deny"`。
- **异步 hook（`async: true`）不能阻断**，因为决定返回时工具已经执行。
- 社区 issue（#26923、#44534、#83195）记录过 Agent/Task 工具的 deny 不生效，维护者称在 2.1.90 修复；复现条件是 hook 被注册为 async。

对本任务的约束：Phronia 的 hook 配置不得设置 async；doctor 或文档应提示最低版本。

### 3.3 Codex：`SubagentStart` 不能阻断

Claude Code 的事件表明确列出 `SubagentStart` 不可阻断（exit 2 只把 stderr 给用户）。Codex 的 native `SubagentStart` 同理只能注入 developer context。

对本任务的映射：Codex 的 `hookPolicy = "inject"`，guard 走 `additionalContext`。

### 3.4 OpenCode：插件可以抛错阻断

`tool.execute.before` 插件在抛异常时会中止工具执行。Phronia 现有 `inject-subagent-context.js` 已经在该 hook 中原地改写 prompt，因此 deny 只需要抛出带原因的 Error。

## 4. 对设计的直接影响

| 调研结论 | 设计决定 |
|---|---|
| preflight 失败应拒绝派发 | 引入 `evaluateDispatch`，结构性错误 block |
| 只读不隔离 | `research` 永远 allow；`implement/check` 才判定 |
| fail-closed | 平台不能阻断时不能当 allow，必须注入守卫并标注能力 |
| 阻断是平台能力 | 新增 `hookPolicy` 维度，不写平台分支 |
| 锁需要心跳与陈旧回收 | 复用现有 claim/lease 的 TTL 语义，不新增锁 |
| worktree 不隔离运行时 | 写入 Non-Goals 和用户文档 |
| 异步 hook 不能阻断 | hook 配置保持同步；验收检查 async 标志 |

## 5. 本地代码事实（核对用）

| 事实 | 位置 |
|---|---|
| 子代理派发只注入上下文，无准入 | `packages/core/src/context/subagent/index.ts:59` `buildSubagentSpawn` |
| 工作区决策是纯函数 | `packages/core/src/task/workspace/policy.ts:25` `decideWorkspace` |
| 协调者门控是纯函数 | `packages/core/src/task/coordinator/policy.ts:35` `canRunCoordinator` |
| 能力矩阵没有"能否阻断" | `packages/core/src/platform/capabilities.ts:63` `PlatformCapabilities` |
| 渲染只支持 set-prompt / allow | `packages/core/src/context/index.ts:118` `renderContext` |
| Python shim 把 mutation 渲染成 allow | `packages/cli/src/templates/shared-hooks/phronia-hook.py` `_render_mutation` |
| planner 没有容器概念 | `packages/core/src/task/parallel/types.ts:24` `PlannerTask` |
| breadcrumb 只有静态文字 | `packages/core/src/context/user-prompt.ts:79` |
| `task.py start` 不检查 children | `.phronia/scripts/task.py:171` `cmd_start` |
| shell ticket 只匹配 `task.py` | `packages/core/src/state/session/tickets.ts:169` `pendingTicketMatchesArgs` |
| workspace 服务不传 argv | `packages/cli/src/services/workspace.ts:2189` `resolveSessionKey` → `openState({root, env})` |

## 6. 本地复现证据

### 6.1 planner 把父任务当执行单元

```text
$ python3 -c "import json; d=json.load(open('.phronia/tasks/08-05-session-identity-propagation/task.json')); print(d['status'], d['children'])"
in_progress ['08-05-opencode-shell-env', '08-05-session-identity-hardening', '08-05-purge-fake-env-names', '08-05-shell-ticket-bridge']

$ node packages/cli/bin/phronia.js task parallel plan --include-planning --explain | grep -A3 08-05-session-identity-propagation
Wave 8 (1 task(s))
  .phronia/tasks/08-05-session-identity-propagation — Investigate session identity propagation gaps
    reason: independent
    footprint: package: packages/cli/**
```

父任务有 4 个子任务，却作为 wave 成员出现。这是 R8 的活证据。

### 6.2 ZCode shell 没有会话身份变量

在本机 ZCode 3.16.3 (8992, a82dd43e) 的 Bash 工具中：

```text
$ env | grep -iE 'session|phronia|claude'
ZCODE_APP_VERSION=<set>
ZCODE_ENV=<set>
ZCODE_RUNTIME_ENV=<set>
...（没有任何 session id / PHRONIA_CONTEXT_ID）

$ echo "PHRONIA_CONTEXT_ID=${PHRONIA_CONTEXT_ID:-<unset>}"
PHRONIA_CONTEXT_ID=<unset>
```

结合 `services/workspace.ts` 的 `resolveSessionKey`（`openState` 不传 `argv`，ticket 通道不可达），ZCode 上 `phronia task workspace ensure` 会落到 `WORKSPACE_SESSION_UNKNOWN`。直接调用解析器复现：

```text
$ node --input-type=module -e "
    import { openState } from './packages/core/dist/state/index.js';
    const s = openState({ root: process.cwd() });
    console.log(JSON.stringify(s.sessions.resolveKey(undefined, { allowEnvironmentContext: true })));
  "
{"key":null,"source":"none","platform":"session"}
```

这与"deny 的 next 第一条就是 workspace ensure"直接冲突，所以 R7 是准入控制的前置修复，不是可选项。

同时说明 `env-tables.ts` 里 zcode 的 `CLAUDE_CODE_SESSION_ID`（`provenance: "reasoned"`）在本机不存在；`08-05-purge-fake-env-names` 的怀疑方向是对的。
