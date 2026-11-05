# Design：任务内 fan-out lanes

## 1. 结论

不扩展"隔离单位是任务"这条不变量，而是新增一个**任务内、临时、无分支的写面单位**：lane。

一条 lane 只是"一组互不重叠的路径 + 一个 id"，它不拥有分支、worktree、lease、claim 或提交。任务级状态继续全部以 `taskRef` 为键；lane 只影响两件事：准入是否放行第二个可变子 agent，以及收敛时如何核对写面。

方案分三层，职责单一：

| 层 | 回答的问题 | 时机 | 是否持久 |
|---|---|---|---|
| 规划期声明 | 哪些步骤可以并行、各自写什么 | Phase 1 评审 | 是（`task.json`） |
| 运行期准入 | 这次派发是否落在一个已声明的 lane 上 | 每次子 agent 派发 | 否（纯判定） |
| 收敛期验证 | 实际改动是否越界 | lane 全部返回后 | 否（读 `git status`） |

关键设计选择是**规划期声明、运行期只校验**。运行期不允许模型临时发明 lane，因此并行面在评审时就固定下来，机制只需回答"这次派发是否与已批准的声明一致"。

## 2. 为什么不动隔离模型

`10-28-parallel-task-execution/design.md` 的不变量是"一个任务 = 一条分支 = 至多一个 worktree；并行来自不同任务"。改动它需要给 lease/claim/integrate 都加第二把 key（task + lane），并解决同一分支不能多 worktree 检出、lane 级合并顺序、lane 级 spec-delta 归属等问题。收益不成比例。

本方案的边界因此写死：

- lane 不产生新分支，不产生新 worktree；
- lane 不参与 lease / claim / integration lock；
- lane 不改变 `phronia task commit` / `integrate` 的语义；
- lane 是 `meta.fanout` 的一种声明，生命周期不超过一次 fan-out。

## 3. 领域模型

新增纯策略模块 `packages/core/src/task/fanout/`，与 `task/parallel`、`task/coordinator` 同构。

```ts
// types.ts
export interface LaneSpec {
  readonly id: string;
  readonly writes: readonly string[];   // repo-relative globs
  readonly dependsOn?: readonly string[];
}

export interface FanoutPlan {
  readonly taskRef: string;
  readonly state: "open" | "closed";
  readonly maxLanes: number;
  readonly lanes: readonly LaneSpec[];
}

export interface FanoutFacts {
  readonly plan: FanoutPlan | null;
  readonly laneId: string | null;       // from the `Lane:` header line
  readonly agent: AgentMutation;
}
```

三个纯函数：

```ts
planFanout(task, maxLanes): FanoutDecision
evaluateFanoutLane(facts: FanoutFacts): FanoutVerdict
verifyFanout(plan, changedPaths): FanoutVerification
```

### 3.1 planFanout

按固定顺序返回第一个失败原因（first-match，与 `evaluateDispatch` 同契约）：

| 顺序 | 条件 | 码 |
|---|---|---|
| 1 | 无 `meta.fanout` 或 `state=closed` | `FANOUT_DISABLED` |
| 2 | 任务状态不是 `in_progress` | `FANOUT_TASK_NOT_IN_PROGRESS` |
| 3 | lane 数 < 2 | `FANOUT_LANES_INSUFFICIENT` |
| 4 | lane 数 > `maxLanes` | `FANOUT_MAX_LANES` |
| 5 | id 为空或重复 | `FANOUT_LANE_DUPLICATE` |
| 6 | `writes` 为空 | `FANOUT_EMPTY_WRITES` |
| 7 | 任意两 lane 写面重叠 | `FANOUT_OVERLAP`（details 含路径与两条 lane） |

写面重叠直接复用 `task/parallel/footprint.ts` 的 `footprintOverlap` 与足迹归一化，不新增 glob 实现。未声明的 lane（未知写面）视为 `unknown_footprint`，直接拒绝而不是保守放行。

### 3.2 evaluateFanoutLane

| 条件 | 结果 |
|---|---|
| `plan=null` | `allow`（`FANOUT_OUTSIDE_CONTRACT`，info）：无声明即无契约，保持今天的行为 |
| `state=closed` | `block` `FANOUT_CLOSED` |
| `agent=check` | `block` `FANOUT_OPEN_CHECK` |
| `agent!=mutating` | `allow`（只读派发不受影响） |
| 无 `laneId` | `block` `FANOUT_LANE_REQUIRED` |
| `laneId` 不在 plan | `block` `FANOUT_LANE_UNKNOWN` |
| 该 lane 写面与 plan 内其他 lane 重叠 | 不可能（planFanout 已拒绝），保留断言式 `FANOUT_OVERLAP` 兜底 |
| 合法 | `allow` `FANOUT_OK`，返回该 lane 的契约文本 |

### 3.3 verifyFanout

输入是 `git status --porcelain=v1 -z` 解析出的路径集合（含未跟踪、含删除）。输出：

```ts
interface FanoutVerification {
  readonly lanes: Record<string, { changed: string[]; empty: boolean }>;
  readonly outOfLane: string[];
  readonly doubleWritten: string[];
  readonly parentOwned: string[];   // .phronia/tasks/<ref>/** 等父会话产物
  readonly violations: FanoutViolation[];
}
```

- 路径落在且仅落在一个 lane → 计入该 lane；
- 不落在任何 lane → `outOfLane`（violation）；
- 落在多个 lane → `doubleWritten`（violation，说明声明被破坏或 glob 写错）；
- `.phronia/tasks/<ref>/**` → `parentOwned`（warning，不计 violation）；
- `.phronia/.runtime/**` 被 gitignore，不出现。

## 4. 分层与模块映射

| 层 | 文件 | 变更 | 职责 | 约束 |
|---|---|---|---|---|
| Domain | `packages/core/src/task/fanout/{types,policy,verify}.ts` | 新增 | 声明校验、准入判定、写面核对 | 纯函数，无 IO/进程/打印 |
| Domain 复用 | `packages/core/src/task/parallel/footprint.ts` | 只读引用 | 足迹归一化与重叠判定 | 不复制实现 |
| Facts | `packages/core/src/context/subagent/facts.ts` | 修改 | 读 `meta.fanout`、把 `laneId` 放进 `DispatchFacts` | 唯一知道存储布局的模块 |
| Admission | `packages/core/src/task/dispatch/policy.ts` | 修改 | 在 checkout 规则之后插入 fan-out 分支 | 规则顺序是公开契约 |
| Context | `packages/core/src/context/subagent/index.ts` | 修改 | 解析 `Lane:` 头、把契约并入 prompt | 无平台分支 |
| Prompt | `packages/core/src/context/subagent/prompts.ts` | 修改 | 渲染 lane 契约段落 | 不改四类角色语义 |
| Application | `packages/cli/src/services/fanout.ts` | 新增 | `plan` / `verify` 编排、读 `git status` | 只通过端口访问外部 |
| Command | `packages/cli/src/commands/task.ts`（或 `fanout.ts`） | 修改/新增 | 参数、JSON/文本输出、退出码 | 不写业务规则 |
| Templates | `packages/cli/src/templates/workflow/workflow.md`、`templates/common/skills/coordinator.md`、`templates/workflow/agents/implement.md` | 修改 | 指导分叉与 lane 契约 | 模板是唯一来源 |
| Spec | `.phronia/spec/cli/backend/parallel-tasks.md` | 新增一节 | 规范定义与码表 | 单一规范位置 |

不新增端口：`verify` 复用 GitPort 的 `status`，`plan` 只读 task store。

## 5. 数据流

```
Phase 1 规划
  implement.md 标注可并行步骤 + task.json.meta.fanout.lanes
        │
Phase 2.1 派发
  phronia task fanout plan --json
        │  返回 lane → prompt 前缀（含 Lane: 与写面）
        ▼
  harness Agent × N（每个 lane 一次）
        │  hook → buildSubagentSpawn → buildDispatchFacts(读 meta.fanout + Lane:)
        │       → evaluateDispatch（task 级规则）→ evaluateFanoutLane（新）
        ▼
  子 agent 写代码、不提交、只跑路径限定检查
        │
收敛
  phronia task fanout verify --json   ← 越界/双写/空 lane
  父会话修正或按路径回退 → 全量 check → commit
        │
  fanout close（state=closed）→ 回到单写者模型
```

## 6. 准入集成点与规则顺序

`evaluateDispatch` 现有顺序：outside contract → no active task → lineage → parent → status → checkout → lease → facts unreliable → OK。

fan-out 分支插在 **checkout 之后、lease 之前**：

1. 先让 checkout 规则给出更准确的恢复文案（错 checkout 比缺 lane 更根本）；
2. fan-out 判定依赖"checkout 属于该任务"这一已证明事实；
3. 放在 lease 之前，避免 lane 契约被 lease 的 advisory guard 淹没。

行为差异：`meta.fanout` 打开时，main checkout 的 `DISPATCH_NO_CLAIM` 警告不再出现，由 `FANOUT_OK` 取代。这是有意的优先级提升——`task.json` 里的声明比一条临时警告更强、更可审计。

`applyEnforcement` 不变：ZCode/Claude Code/opencode（`hookPolicy=block`）得到 deny；inject-only 平台得到 `STOP:` 前缀的 guard；`enforce:off` 仍然整体关闭。不新增第二套降级逻辑。

## 7. 提示词与解析契约

子 agent prompt 头部：

```
Active task: .phronia/tasks/10-30-xxx
Lane: a
Writes only: src/a/**
```

解析规则：

- 只扫描第一个非空头部块，到空行为止；
- 第一行必须是 `Active task:`（保持现有 `readTaskRefFromPrompt` 语义，找不到就返回 null）；
- `Lane:` 可缺省；缺省时 `laneId=null`；
- 任意 `Lane:` 出现在正文段落中不被识别（与现有 `Active task:` 的防误判一致）。

注入到子 agent 的契约段落（由 `prompts.ts` 渲染）：

```
## Lane Contract
- Lane: <id>
- Write only: <globs>
- Do not run git add / commit / stash / checkout.
- Run path-scoped checks against your write set only.
- Report the changed files; the parent session commits.
```

这段契约与 `prompts.ts` 现有的 "Do NOT execute git commit" 约束方向一致，只是把它显式化到 lane 场景。

## 8. 验证与恢复语义

- 子 agent 从不提交 → 越界改动仍在工作树里，父会话可 `git checkout -- <path>` 精确回退单条 lane 的越界部分；已提交的历史不会被污染。
- `verify` 只读，不自动修复；违例是否阻断由父会话决定（默认阻断提交）。
- `doubleWritten` 说明声明本身有误或 glob 过宽，处理方式是修 `task.json` 后重跑，而不是自动猜归属。
- `emptyLanes` 是 warning：某 lane 没产出可能意味着步骤不值得并行，但不构成失败。
- `close` 只是把 `meta.fanout.state` 置为 `closed`（一次 `task.json` 写入，branch-local），不删除 lane 声明，保留审计信息。

## 9. 备选方案与取舍

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A 仅指导（拆 child task + 多会话） | 不改机制，Phase 2.1 教模型拆任务 | 零风险、立刻可做 | 需要多窗口；不满足"同会话两子 agent"；child task 有独立 worktree/集成/归档开销 | 保留为降级路径，不是主方案 |
| B per-lane worktree | 每条 lane 一个 worktree | 物理隔离最彻底 | ZCode 子 agent 拿不到 cwd，目标平台不可用；引入第二套 lease/合并语义 | 不做 |
| C 运行期启发式 | 模型自行判断何时 fan-out | 无规划负担 | 不可验证、易把共享文件并行；事故模式正是 `10-28` 记录的现场 | 明确禁止 |
| D 规划期声明 + 运行期准入 + 收敛验证 | 本文方案 | 可评审、可校验、可回滚；默认关闭零迁移 | 越界只能事后发现；语义冲突靠人 | 采用 |

## 10. 风险登记册

| 风险 | 可能性 | 影响 | 缓解 | 残余 |
|---|---|---|---|---|
| 子 agent 写到 lane 之外 | 中 | 中 | 子 agent 不提交；`verify` 检出；父会话按路径回退 | 已浪费的计算，不污染历史 |
| 两条 lane 语义冲突（不同文件、接口不一致） | 中 | 高 | 规划期冻结接口；`FANOUT_CONTRACT_UNFROZEN` warning；implement.md 必填"契约"小节 | 机制无法验证，依赖评审 |
| 并发全量 lint/typecheck 互相看到半成品 | 高 | 低 | 契约要求路径限定检查；收敛后跑全量 | 子 agent 可能误报，父会话以全量结果为准 |
| 某条 lane 中途失败留下部分改动 | 中 | 中 | lane 写面不相交，按路径回退；无 lane 级原子回滚 | 需要人工判断 |
| prompt 缺 `Lane:` 行 | 中 | 低 | plan 是 open 时 deny，并给出可复制的修复行 | 无 |
| 重复派发同一 lane | 低 | 中 | 不做运行期占用状态；文档写明"父会话每个 lane 只派一次"，重复由父会话负责 | 无机制拦截（有意，避免把重试当重复） |
| 模板与部署文件漂移 | 中 | 低 | 只改模板并重新生成；测试校验生成结果 | 无 |
| 新增码与文案膨胀 | 中 | 低 | 码族统一为 `FANOUT_*`；单一规范章节；workflow/skill 只放指针 | 需定期检查重复 |

## 11. 兼容、灰度与回滚

- 兼容：`meta.fanout` 缺失 → `plan=null` → 准入走原路径；不新增共享运行期文件；不新增迁移。
- 灰度：先合并"仅指导"部分（R8）单独生效，再合并机制；机制按任务 opt-in。
- 回滚：把 `meta.fanout.state` 置为 `closed` 即回到单写者；代码级回滚无数据残留。

## 12. 测试策略

- 纯函数：`planFanout` / `evaluateFanoutLane` / `verifyFanout` 表驱动，覆盖每个码与 first-match 顺序。
- 事实层：`buildDispatchFacts` 在 `meta.fanout` 开/关、有无 `Lane:` 时的输出。
- 上下文：`buildSubagentSpawn` 三类集成（合法 allow、缺 lane deny、无声明不变）。
- 解析：`readDispatchHeader` 对空行、正文误写、大小写、BOM 的边界。
- CLI：临时仓库上跑 `plan` / `verify --json`，断言退出码与结构。
- 文档：模板快照测试，确保部署文件与模板一致。
- 回归：`pnpm verify`。

## 13. 待评审决定

1. `meta.fanout` 放 `task.json`（推荐，机器可读、与 `meta.parallel` 同址）还是 `implement.md` 的结构化块。
2. `maxLanes` 默认 2 还是 3（推荐 2，成本与冲突可控）。
3. 有 worktree 的任务是否允许 fan-out（推荐允许：lane 在任务自己的 checkout 内，与 worktree 无关）。
4. `verify` 是否把 `.phronia/tasks/<ref>/**` 计为 `parentOwned` warning（推荐是）。
5. 是否需要在 `verify` 里加入"每 lane 至少一个文件"的硬门禁（推荐只 warning）。
