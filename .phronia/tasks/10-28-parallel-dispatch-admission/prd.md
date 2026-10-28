# 并行执行准入控制：子代理派发前的工作区、租约与父子任务守卫

> 关联现场：`/Volumes/MagicWork/xp-non-aosp-codes/bedrock`，2026-10-28。
> 前置任务：`.phronia/tasks/archive/2026-10/10-28-parallel-task-execution/`（B11 / 范围 G）。
> 关联契约：`.phronia/spec/cli/backend/parallel-tasks.md`。

## Problem

用户要求"并行推进积压任务"，下游在一个 ZCode 会话里启动了**父任务** `10-28-backlog-batch`，没有声明 footprint、没有执行 `workspace ensure`、没有租约，然后用 ZCode 原生 Agent 工具在同一 checkout 里并发派发两个 `phronia-implement` 子代理。结果是 11 个文件混在同一个工作树/index 里，`git add -A` 会把多个任务的改动合成一个提交。

Phronia 的并行原语本身是存在的，也没有写错：

- `decideWorkspace` 能正确判断 `reuse-current / attach / create / refuse`；
- planner 在未知 footprint 时正确退化为串行；
- `parallel dispatch` 在 ZCode 上正确返回 `COORDINATOR_UNSUPPORTED`（`subagentWorkspace: inherited`）；
- `phronia doctor` 的 `task.worktree` 为 ok。

真正的结构缺口是：**这些约束全部是 pull-based 的，只在主动调用某个命令时生效；而真正制造并发的地方——harness 原生子代理派发——只有一个"注入上下文"的 hook，没有任何准入判定。**

用分层的语言说，系统已有三个纯决策函数：

| 决策 | 函数 | 回答的问题 |
|---|---|---|
| 工作区 | `decideWorkspace` | 这个任务**应该在哪里**工作 |
| 波次 | `planParallel` | 哪些任务**可以同批** |
| 平台 | `canRunCoordinator` | 这个 harness **能否自动派发** |

缺的是第四个：**这次派发现在是否满足前置条件**。`buildSubagentSpawn` 只解析活动任务并注入 PRD/design/jsonl，它不读 claim、不读 lease、不读 worktree registry，也不检查父子关系、任务状态或当前 checkout 身份。因此：

- 父任务可以作为实现目标被派发；
- `planning` 状态的子任务可以被实现；
- 已经有 worktree 的任务可以在 main checkout 里被实现；
- main checkout 可以被另一个任务占用后继续被派发；
- 子代理 prompt 没有 `Active task:` 时静默回落到父任务上下文。

### 现场核对（2026-10-28 读取）

- 父任务 `10-28-backlog-batch`：`status=in_progress`，`children=6`，`meta.parallel` 为空。
- 6 个子任务：全部 `status=planning`，`touches/depends_on` 为空。
- `git worktree list`：只有主 checkout，没有任务 worktree。
- `.git/phronia/`：`leases/` 与 `logs/` 为空；`worktrees.json` 只有一条 `taskRef=""` 的 platform 占位记录；没有 `workspace.claim.json`。
- 工作树有 11 个修改文件，横跨 join-code 与 reports 两条执行线。

### 与既有任务的关系

仓库里已有两棵与"会话身份"相关的在途任务树，本任务必须与它们划清边界：

| 任务 | 状态 | 与本任务的关系 |
|---|---|---|
| `08-05-session-identity-propagation` | in_progress，4 个 children | 研究"session id 能否到达 shell child"；其 PRD 明确记录"仓库里没有任何 hook deny，工作流强制是建议性的，那是另一个关注点"。本任务正是那个关注点。 |
| `08-05-shell-ticket-bridge` | in_progress | 把 Cursor 的 30s ticket 桥泛化到 7 个 hook 平台，覆盖 `task.py start/current/finish`。它不覆盖 `phronia task workspace ...`。本任务的 R7 是它的**下游扩展**，不是替代。 |
| `08-05-session-identity-hardening` / `08-05-purge-fake-env-names` | in_progress | 清理伪造的 `<PLATFORM>_SESSION_ID` 表。ZCode 的 `CLAUDE_CODE_SESSION_ID` 目前是 `provenance: reasoned`；如果它不是真的，R7 的 ticket 桥就是唯一可靠通道。 |

顺序约束：

- R7 与 `08-05-shell-ticket-bridge` 编辑同一批函数（`extractTaskSubcommands` / `pendingTicketMatchesArgs`）。**必须在那个任务合入之后，或与它同一变更窗口内实施**，并复用它"单一命令提取路径、无平台分支"的约束；不得新增第二套 matcher。
- R1–R6、R8–R12 不依赖上述任务，可以先做。
- 如果 `08-05-shell-ticket-bridge` 未合入而本任务的准入控制先上线，`workspace ensure` 的错误信息必须至少给出可直接复制的 `--session-key` 命令（R7 的降级要求），不能把用户引到死路。

### 为什么不能只补 hook

单独在 hook 里加几条判断会留下四个问题：

1. **不可降级**：ZCode 能 deny，Codex 的 `SubagentStart` 不能；不把"能否阻断"变成能力维度，就只能写平台分支。
2. **不可复用**：`parallel dispatch`、`task.py start`、planner、breadcrumb 需要同一套事实和同一套判定；散落在 hook 里会产生第二套规则。
3. **不可观测**：模型看不到 `workspace: none`，即使被 deny 也不知道该执行什么。
4. **不可补救**：deny 的下一步是 `workspace ensure`，但该命令在 ZCode 上因为拿不到 session key 会直接失败（见 R7）。

因此本任务补齐的是**决策层 + 事实层 + 渲染能力层**，而不是一个 hook 补丁。

## Goal

在不改变三阶段主流程、不自动创建 worktree、不引入守护进程的前提下，让并行执行的前置条件在**派发边界**被统一判定、可解释、可执行、可降级：

1. 一个纯函数 `evaluateDispatch(facts)` 回答"这次实现/检查派发是否允许"。
2. 一个只读事实层从 task.json、共享运行时和 git 读取判定所需事实。
3. 一个能力维度决定"阻断 / 注入守卫 / 不可用"，由现有 shim 渲染。
4. breadcrumb 持续显示真实 `workspace / claim / lease / parallel` 状态。
5. planner 把父任务当容器，不再当作可调度单元。
6. `task.py start` 不再允许把父任务当作实现目标。
7. `phronia task workspace ensure` 在 ZCode 上能自动拿到会话身份。

## Requirements

### Must Have

**R1 派发准入判定（纯函数）**

新增 `evaluateDispatch(facts): DispatchVerdict`，位于 `packages/core/src/task/dispatch/`。输入是纯数据（平台能力、代理类型、活动任务、有效任务、checkout 身份、worktree 绑定、claim、lease、兄弟任务状态），输出是 `allow | block`，带稳定错误码、人类可读原因、可执行的 `next` 命令序列。函数不读文件、不跑进程、不打印。

**R2 事实层（只读）**

新增只读事实读取：`<git-common-dir>/phronia/` 下的 `workspace.claim.json`、`worktrees.json`、`leases/*.json`，当前 checkout 是 main 还是 linked worktree、其分支与所属任务，以及活动任务的父子/兄弟状态。必须复用 `sharedRuntimePaths` / `taskLeasePath` / `mainWorktreeRoot`，git 调用通过可注入的 `GitExec`，缺失或损坏的文件降级为 `null` 并产生诊断，不抛异常。

**R3 阻断语义（窄而硬）**

只有结构性错误才 block：

| 码 | 条件 |
|---|---|
| `DISPATCH_PARENT_TASK` | 有效任务是父任务（`children.length > 0`），且派发是 implement/check |
| `DISPATCH_TASK_NOT_IN_PROGRESS` | 有效任务状态不是 `in_progress`（planning / blocked / completed） |
| `DISPATCH_TASK_NOT_CHILD` | 显式 `Active task:` 指向的任务既不是活动任务本身、也不是其子任务 |
| `DISPATCH_WRONG_CHECKOUT` | 有效任务已有 worktree，但当前 cwd 不是该 worktree |
| `DISPATCH_CHECKOUT_OWNED_BY_OTHER` | 当前 cwd 是某个 worktree，但它登记在另一个任务名下 |
| `DISPATCH_ISOLATION_REQUIRED` | 有效任务要求隔离（`meta.parallel.worktree=always`、`exclusive`、或父任务有 ≥2 个 `in_progress` 子任务），但当前 cwd 是 main checkout |
| `DISPATCH_MAIN_CLAIMED` | 当前 cwd 是 main checkout，且 `workspace.claim.json` 属于另一个任务或另一个未过期会话 |
| `DISPATCH_STALE_CLAIM_DIRTY` | main 的 claim 已过期，但 main 有未提交改动；沿用"绝不自动回收"的规则 |

允许但必须带守卫块（不阻断）：

| 码 | 条件 |
|---|---|
| `DISPATCH_NO_CLAIM` | main checkout 没有被有效任务认领（单任务串行路径，必须保持可用） |
| `DISPATCH_LEASE_OTHER_OWNER` | 有效任务的 lease 属于另一个仍在活动的会话（同一任务多会话按设计允许，只警告） |
| `DISPATCH_NO_ACTIVE_TASK` | 无法解析任何任务：allow + 诊断，不注入守卫（保持现有 pull-based 降级；没有任务就没有可违反的工作区契约） |
| `DISPATCH_PLATFORM_CANNOT_BLOCK` | 平台只能注入、不能阻断（把 block 降级为守卫块并显式说明） |

**R4 平台能力维度**

在能力矩阵新增 `hookPolicy: "block" | "inject" | "unknown"`（命名可调整，语义固定）：

- `block`：hook 能阻止工具调用，且已在本机/文档验证；
- `inject`：只能注入上下文，不能阻止；
- `unknown`：未验证，按 `inject` 处理（fail-closed，不假设能阻断）。

`validateCapabilities` 必须覆盖新维度。`phronia platforms --json` 与 `phronia doctor` 必须能看到它。

**R5 渲染契约**

`ContextResponse.mutations` 增加中立的 `deny` 变更（`{op:"deny", code, reason, next}`）。shim 负责映射：

- ZCode / Claude Code：`hookSpecificOutput.permissionDecision = "deny"` + `permissionDecisionReason`；ZCode 实测会把 deny 作为 Agent 工具的错误结果交付（不创建子会话），因此 reason 必须自包含并以 "Do not retry; report this exactly." 结尾；
- OpenCode：`tool.execute.before` 抛错；
- Codex `SubagentStart`：不能阻断，改为在 `additionalContext` 顶部注入 `WORKSPACE_GUARD`；
- 其它未验证平台：只注入，不伪装成阻断。

`updatedInput` 与现有 `permissionDecision: "allow"` 行为必须保持兼容；deny 时不得同时改写 prompt。

**R6 breadcrumb 实时状态**

`<current-state>` 与每轮 `[workflow-state:*]` 必须显示：

```text
workspace: none | main | worktree(<path>)
claim: <taskRef|owner> | none
lease: <owner> | none
parallel: serial | N in_progress children (planning M)
```

父任务活动时必须明确显示 `children: N; start a child before dispatching implement/check`。读取失败时显示 `workspace: unknown (read failed)`，不得静默省略。

**R7 workspace 会话身份桥**

`phronia task workspace ensure|prepare|release|reclaim` 与 `phronia task lease ...` 必须能像 `task.py start` 一样从 pre-shell ticket 解析 `context_key`：

- 复用 `08-05-shell-ticket-bridge` 建立的单一命令提取路径，把 `phronia task <verb>` / `python3 .../task.py <verb>` 纳入同一个提取函数，不新增平台分支；
- ticket 匹配器接受 `phronia` / `trellis` 可执行文件；
- CLI 的 `openState` 必须传入 `argv`，否则 ticket 通道永远不会被查找。

仍然无法解析时，错误信息必须给出当前 checkout 可用的 session key（存在且唯一时）或可直接复制的 `--session-key` / `PHRONIA_CONTEXT_ID` 命令，不能只说"no session identity"。

> 本地证据：本机 ZCode 3.16.3 (8992, a82dd43e) 的 Bash 里没有 `PHRONIA_CONTEXT_ID`，也没有 `CLAUDE_CODE_SESSION_ID`；而 `workspace` 服务的 `openState` 没有传 `argv`，ticket 通道不可达。因此 `phronia task workspace ensure` 在 ZCode 上确实会返回 `WORKSPACE_SESSION_UNKNOWN`。见 `research/prior-art.md` §6.2。

**R8 planner 容器语义**

`PlannerTask` 增加容器标记。父任务（`children.length > 0`）不进入任何 wave；`--explain` 输出 `container (children: N)` 并说明"父任务是协调容器，不是执行单元"。显式 `--refs <parent>` 时给出明确提示和子任务启动命令，而不是把它排进 wave。

**R9 `task.py start` 父任务门禁**

`task.py start <parent>` 默认拒绝，打印子任务列表和逐条 `start` 命令；`--coordinator` 才允许把父任务设为活动任务。启动子任务不受影响。父任务即使被启动，也必须被 R1 的 `DISPATCH_PARENT_TASK` 继续拦住实现派发。

**R10 守卫块内容**

守卫块（注入路径）与 deny 原因必须包含：有效任务、当前 workspace 事实、缺失的前置条件、按顺序可直接执行的命令、以及平台限制说明（ZCode 走多会话、Codex 只能注入）。不得只给抽象建议。

**R11 工作流与技能同步**

更新 `phronia-coordinator` skill、`workflow.md`、`parallel-tasks.md` spec：

- ZCode/Codex 分支明确"禁止在同一 checkout 并发 implement/check"，给出多会话四步；
- 派发前检查清单与 R1 的错误码一一对应；
- 模板与 dogfood skill 内容保持同步。

**R13 单任务复用 main 的 ensure 语义（dogfood 发现的缺陷）**

`task.py start` 会把当前分支（通常是 `main`）写进 `task.branch`。`workspace ensure` 目前会把它当成 worktree 分支，先撞上 `WORKSPACE_TARGET_EXISTS`（`branch main is already checked out`），导致单任务无法通过 `ensure` 复用主 checkout。期望：

- 当 `task.branch === integrationBranch` 且当前 checkout 是 main、无其他任务占用时，`ensure` 直接返回 `reuse-current` 并建立 claim，不创建 worktree；
- 只有需要隔离（并行/always/exclusive）时才创建 worktree；
- 增加集成测试覆盖 `branch=main` 的 `ensure`。

这是 `DISPATCH_NO_CLAIM` 的 `next` 命令能真正跑通的前置条件。

**R12 配置逃生口**

新增 `parallel.dispatch.enforce: "block" | "warn" | "off"`，默认 `block`。`warn` 把所有 block 降级为守卫块；`off` 完全关闭判定但仍写 breadcrumb 诊断。配置非法时回落到 `block` 并产生诊断。该开关必须出现在 `phronia doctor` 的输出里。

### Nice to Have

- **N1** `parallel plan --json` 输出每个任务的 `workspace`、`claim`、`lease` 事实，便于外部 orchestrator 复用。
- **N2** `phronia task parallel preflight <ref> --agent implement --json`：把 R1 暴露为可脚本化命令，便于没有 subagent hook 的平台和 CI 使用。
- **N3** deny 时在 shared runtime `logs/` 写一行审计（task、agent、code、cwd、时间），便于事后复盘。

## Non-Goals

- **不自动创建 worktree，也不在 hook 里改变会话环境。** 会话 cwd 固定，`SessionStart` 保持只读（沿用前置设计 §15 的否决）。
- **不接管 harness 原生 agent。** 只对 `phronia-implement` / `phronia-check` 强制执行；`Explore`、`general-purpose` 等原生代理不在 Phronia 契约内。
- **不实现跨机器锁。** 共享运行时只协调同一仓库的 worktree。
- **不解决运行时隔离。** 端口、数据库、Docker、dev server 不在 worktree 的隔离范围内，文档必须说明。
- **不新增守护进程、不调度 agent 进程。** 判定是同步的、单次的。
- **不改变 `integrate` 的单车道语义。** 本任务只保证"进入执行"的前置条件，不重做合入。

## Constraints

- `packages/core` 保持纯：不打印、不 `process.exit`、不读 `process.cwd()`、不引入运行时依赖。git 通过 `GitExec` 注入。
- 判定必须确定性：同样的输入产生同样的 verdict 和同样的 `next` 顺序。
- hook 路径有超时预算（ZCode `PreToolUse` 30s，Python shim 30s）。事实读取只允许 1 次 git 调用 + 3 类小文件读取；必须在 `bench/hook-bench.mjs` 上有基线。
- 所有 block 都必须可以用 `parallel.dispatch.enforce: warn|off` 解除，避免误伤。
- 新增文本（错误码、next、守卫块）必须有中英文一致性；项目现有面向用户的输出以中文为主，错误码保持英文。
- 不改变现有 `workspace ensure` 的决策矩阵和 `integrate` 的锁顺序。

## Acceptance Criteria

### A. 派发准入（核心）

- [ ] 父任务 `in_progress`、6 个子任务 `planning`：派发 `phronia-implement`（prompt 无 `Active task:`）返回 deny，码为 `DISPATCH_PARENT_TASK`，原因包含 `6 children`，next 包含逐条 `task.py start`。
- [ ] 同上但 prompt 首行 `Active task: <child>`：返回 deny，码为 `DISPATCH_TASK_NOT_IN_PROGRESS`。
- [ ] 子任务 `in_progress`、main checkout 无 claim：返回 allow，并注入 `DISPATCH_NO_CLAIM` 守卫块，块内含 `phronia task workspace ensure <ref>`。
- [ ] 子任务 `in_progress`、已有 worktree、cwd 是 main：返回 deny，码为 `DISPATCH_WRONG_CHECKOUT`，next 给出 worktree 路径。
- [ ] cwd 是任务 A 的 worktree、有效任务为 B：返回 deny，码为 `DISPATCH_CHECKOUT_OWNED_BY_OTHER`。
- [ ] 父任务有 2 个 `in_progress` 子任务、子任务无 worktree、cwd 为 main：返回 deny，码为 `DISPATCH_ISOLATION_REQUIRED`，next 为多会话四步。
- [ ] main checkout 被任务 A 认领、有效任务为 B：返回 deny，码为 `DISPATCH_MAIN_CLAIMED`。
- [ ] claim 已过期但 main 有未提交改动：返回 deny，码为 `DISPATCH_STALE_CLAIM_DIRTY`，next 给出提交/暂存与 `workspace reclaim --force`。
- [ ] `phronia-research` 在以上任何状态都 allow（只读）。
- [ ] `parallel.dispatch.enforce: warn` 时所有 deny 变为 allow + 守卫块；`off` 时 allow 且无守卫块，但 breadcrumb 仍显示事实。

### B. 平台渲染

- [x] ZCode：真实运行已验证（2026-10-28，3.16.3）。`Agent` 工具返回 `state.status=error`，`session.parent_id` 无子会话，模型未重试。deny 以工具错误结果交付，不弹权限层。证据见 `research/prior-art.md` §3.1。
- [ ] Claude Code：同一 payload 形状；hook 未设置 `async`（异步 hook 无法阻断，见调研记录）。
- [ ] Codex：`SubagentStart` 不能阻断，输出 `additionalContext` 中的 `WORKSPACE_GUARD`，不输出 deny；守卫首行是 `STOP: do not edit ...`。
- [ ] OpenCode：`tool.execute.before` 抛错，派发被阻止。
- [ ] 未知平台：`hookPolicy=unknown` 时不输出 deny，只注入守卫，并在 `platforms --json` 中显式标记。

### C. 可观测性

- [ ] 每轮 breadcrumb 显示 `workspace / claim / lease / parallel`，无 claim 时显示 `none`。
- [ ] 父任务活动时显示 `children: N (planning M, in_progress K)` 与下一步命令。
- [ ] `phronia doctor` 显示 `task.dispatchAdmission`（能力、enforce 模式、可阻断性）。
- [ ] 事实文件缺失/损坏时显示 `unknown` 并带诊断，不崩溃、不静默。

### D. 规划与启动

- [ ] `parallel plan` 不再把父任务排进 wave；`--explain` 显示 `container (children: N)`。
- [ ] `parallel plan --refs <parent>` 给出"先启动子任务"的提示和命令。
- [ ] `task.py start <parent>` 默认失败且列出子任务；`--coordinator` 成功；`task.py start <child>` 不受影响。

### E. 会话身份

- [ ] 在 ZCode shell 中直接运行 `phronia task workspace ensure <ref>`，无需 `--session-key` 即可解析身份。
- [ ] 同一 shell 中同时存在两个新鲜 ticket 时，解析降级为 null 并给出可复制的 `--session-key`，不猜测。

### F. 回归

- [ ] 单任务、干净 main checkout、无 claim 的常规流程仍然允许 implement（只是带守卫块）。
- [ ] `pnpm verify` 通过：layout、typecheck、shims、lint、build、test。
- [ ] `bench/hook-bench.mjs` 的 subagent-spawn 路径增量不超过 30ms（本机基线）。
- [ ] 现有 `workspace` / `parallel` / `integrate` / `lease` 集成测试全部通过。

### G. 文档与 spec

- [ ] `.phronia/spec/cli/backend/parallel-tasks.md` 新增"派发准入"章节，与错误码表一致。
- [ ] `workflow-state-contract.md` 记录 breadcrumb 新增字段。
- [ ] `docs/migrations/user-visible-changes.md` 记录用户可见变化（deny 行为、新 breadcrumb、start 门禁）。
- [ ] `phronia-coordinator` skill 的模板与 dogfood 副本内容一致。

## Open Questions

1. `DISPATCH_ISOLATION_REQUIRED` 用"父任务有 ≥2 个 in_progress 子任务"作为并行意图信号是否足够？是否需要显式 `meta.parallel.parallel: true` 才触发？（倾向：两者都算，显式信号优先。）
2. Claude Code 的 deny 对 Agent 工具存在历史 bug（文档说 2.1.90 修复，社区 issue 曾报告不生效）。是否需要在 doctor 里检查 harness 版本？
3. ~~ZCode deny 是否真实生效~~ **已解决（2026-10-28）**：3.16.3 真实运行确认不创建子会话，`hookPolicy=block` 成立；deny 以 Agent 工具错误结果交付，reason 必须自包含并写 "Do not retry"。
4. 同一任务多会话（lease 属于另一个会话）只警告是否足够？是否应该在 `parallel.dispatch.strict_same_task: true` 时才 block？
5. 派发准入是否要写入 shared runtime 审计日志（N3）？会引入额外 IO 和并发写。
