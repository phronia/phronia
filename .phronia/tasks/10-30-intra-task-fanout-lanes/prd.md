# 任务内步骤级并行（fan-out lanes）

> 关联现场：2026-10-30，ZCode 会话试图为同一任务的三个"车道"并行派发 `phronia-implement`，被 dispatch admission 以"本会话只能在自己的 checkout 里派发"拒绝，随后回退为 main 串行。
> 关联契约：`.phronia/spec/cli/backend/parallel-tasks.md`、`.phronia/tasks/archive/2026-10/10-28-parallel-task-execution/design.md`（隔离单位是任务）、`.phronia/tasks/archive/2026-10/10-28-parallel-dispatch-admission/design.md`（准入判定）。

## Problem

现有并行模型的隔离单位是**任务**：一个任务 = 一条分支 = 至多一个 worktree；并行只允许发生在不同任务之间，通过 coordinator 或多会话落地。这在跨任务场景是对的，但它没有"任务内步骤级并行"的合法形态：

- dispatch admission 只识别 lineage（self / child / sibling），不识别"同一任务的两个独立步骤"，因此把步骤当成 sibling/child 派发会撞 `DISPATCH_TASK_NOT_CHILD` / `DISPATCH_WRONG_CHECKOUT` / `DISPATCH_ISOLATION_REQUIRED`。
- 工作流与 coordinator 技能只写了"不要在一个会话里跑多个可变子 agent"，没有写"如果剩余步骤彼此独立，应该怎么改道"。
- 结果是模型在该并行的常见场景里只有两个动作：被拦，或串行。用户看到的"被 blocked"不是配置缺失，而是**缺少一个被声明、可校验、可收敛的执行单位**。

同时要注意两个既有事实，它们决定了方案的上界：

1. implement 子 agent 已经被禁止执行 `git commit`，只改代码并报告文件；提交由编排者完成（`packages/core/src/context/subagent/prompts.ts:34`）。因此 index/commit 争用不是主要风险。
2. ZCode/Codex 的子 agent 继承父 cwd，拿不到 per-subagent 工作区（`packages/core/src/platform/capabilities.ts`：`execution=parallel, workspace=inherited`）。因此"每 lane 一个 worktree"在目标平台不可实现。

## Goals

- 让**同一任务内、写面互不重叠**的步骤可以并行派发给多个可变子 agent，且这条路径是声明式的、可校验的、可回滚的。
- 让"能不能并行"来自**规划期声明**，而不是运行期的模型臆断；运行期只做准入与验证。
- 把决策分叉写进工作流入口（Phase 2.1），使模型在"被拦 / 串行"之外有第三个合法动作。
- 默认关闭、零迁移：未声明 `meta.fanout` 的任务行为与今天完全一致。

## Non-Goals

- 不做 per-lane worktree，不改 coordinator 的隔离模型，不新增分支/lease/claim 维度。
- 不做运行期自动识别可并行步骤（启发式不可验证）。
- 不允许并行 `check`；不让子 agent 提交；不做跨任务 fan-out（那是 coordinator）。
- 不做 per-lane 快照/自动回滚。

## Requirements

### R1 声明模型

任务可以在 `task.json.meta.fanout` 声明车道：

```json
{ "state": "open", "maxLanes": 2,
  "lanes": [
    { "id": "a", "writes": ["src/a/**"] },
    { "id": "b", "writes": ["src/b/**"], "dependsOn": [] }
  ] }
```

约束：`state ∈ {open, closed}`；至少 2 条 lane；id 唯一且非空；`writes` 非空；任意两条 lane 的写面两两不相交；任务状态必须是 `in_progress`。声明属于规划产物，必须经过 Phase 1 评审，不允许运行期临时添加。

### R2 只读规划命令

`phronia task fanout plan <ref> --json` 返回校验后的 plan、每条 lane 的 prompt 前缀，或结构化拒绝（`FANOUT_DISABLED` / `FANOUT_LANES_INSUFFICIENT` / `FANOUT_LANE_DUPLICATE` / `FANOUT_EMPTY_WRITES` / `FANOUT_OVERLAP` / `FANOUT_TASK_NOT_IN_PROGRESS`）。命令不创建 worktree、不写状态、不启动进程。

### R3 只读验证命令

`phronia task fanout verify <ref> --json` 读取 `git status --porcelain`，把变更路径映射到 lane，输出：

- 每条 lane 的 `changed` 列表；
- `outOfLane`（不属于任何 lane 的路径）；
- `doubleWritten`（同时落在多条 lane 的路径）；
- `emptyLanes`（未产生变更的 lane，warning）。

有违例时退出码非零。路径匹配复用 `footprintOverlap` / footprint 归一化语义，不引入第二套 glob 实现。

### R4 运行期准入（允许路径）

`meta.fanout.state=open` 时，派发可变 `phronia-implement` 且 prompt 头部声明 `Lane: <id>` 的，准入放行并注入 lane 契约；未声明的 lane id、已关闭的 plan、写面冲突分别拒绝（`FANOUT_LANE_UNKNOWN` / `FANOUT_CLOSED` / `FANOUT_OVERLAP`）。

### R5 运行期准入（拒绝路径）

`meta.fanout.state=open` 时：

- 可变派发没有 `Lane:` 行 → `FANOUT_LANE_REQUIRED`，next 给出可直接复制的那一行；
- 派发 `phronia-check` → `FANOUT_OPEN_CHECK`，next 要求先 `fanout close`；
- 任一拒绝都必须携带可执行的 next，延续现有 `DISPATCH_*` 的文案契约。

### R6 车道契约注入

被放行的 lane 子 agent，prompt 必须包含：只写声明的写面；禁止 `git add/commit/stash/checkout`；只跑路径限定的检查；结束时报告变更文件列表，由父会话提交。

### R7 收敛与恢复

- 父会话在 `verify` 通过后执行全量 check 与提交；提交归属不变（父会话/编排者）。
- 越界变更：子 agent 不提交，父会话可用 `git checkout -- <path>` 精确回退，无需回滚整条 lane。
- `fanout close`（把 `state` 置为 `closed`）后行为回到单写者模型；`check` 与第二次 `implement` 正常放行。

### R8 指导分叉

`workflow.md` Phase 2.1 增加显式分叉：剩余步骤互相独立时，要么按 R1 声明 lane 并 fan-out，要么拆 child task 走多会话，要么串行；并明确"同一任务内的步骤不是车道，不得当作 sibling 派发"。coordinator 技能补一句同样的边界。模板是唯一来源，部署文件由生成器刷新。

### R9 兼容

没有 `meta.fanout` 的任务：准入结果、prompt、退出码与今天逐字节一致。不新增共享运行期文件，不新增迁移。

### R10 可观测

`plan` / `verify` 输出 lane → 路径映射；所有拒绝码都带 `reason`、`next`、`details`，与现有 JSON 错误约定一致。

## Acceptance Criteria

- [ ] `meta.fanout` 声明合法时，`fanout plan --json` 返回 plan 与每条 lane 的 prompt 前缀；非法声明返回对应 `FANOUT_*` 码且不产生副作用。
- [ ] 写面重叠被 `FANOUT_OVERLAP` 拒绝，细节里同时给出冲突路径与两条 lane 的 id。
- [ ] `meta.fanout.state=open` 时：带合法 `Lane:` 的可变派发放行并注入契约；不带 `Lane:` 的被 `FANOUT_LANE_REQUIRED` 拒绝；`check` 被 `FANOUT_OPEN_CHECK` 拒绝。
- [ ] `fanout verify --json` 正确区分 `changed` / `outOfLane` / `doubleWritten` / `emptyLanes`，违例时退出码非零。
- [ ] `close` 之后，`check` 与串行 `implement` 恢复原有行为。
- [ ] 未声明 `meta.fanout` 的任务：既有测试全绿，行为无变化（含 prompt 与错误码快照）。
- [ ] 领域层三个纯函数有表驱动单测；`buildSubagentSpawn` 有 allow / deny / 无 lane 三类集成测试。
- [ ] `pnpm verify` 通过；模板修改后部署文件与模板一致。

## Constraints

- 领域层（`packages/core/src/task/fanout/**`）必须是纯函数：无 IO、无进程、无打印、不读 `process.cwd()`，与 `task/parallel`、`task/coordinator`、`task/dispatch` 同构。
- 事实层（`context/subagent/facts.ts`）是唯一知道存储布局的地方；策略层不得直接读 `task.json`。
- CLI 命令只做参数解析与输出，不写业务规则。
- 不得新增平台分支；能力差异继续由 `capabilitiesFor` 与 `hookPolicy` 驱动。
- 指导文案只在一个规范位置定义（spec），workflow/skill 做简短指针，避免多处漂移。

## Residual Risks（必须在评审时确认）

- 写面不相交不等于语义不相交：接口约定的冻结是规划责任，机制无法验证（`FANOUT_CONTRACT_UNFROZEN` 只能给 warning）。
- 越界写只能事后发现；ZCode 无法沙箱化子 agent。
- 并发全量检查会看到彼此的半成品：约定为路径限定检查，收敛后跑全量。
- 中途失败会留下部分改动；lane 之间不相交，父会话可按路径精确回退，但没有 lane 级原子回滚。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Complex task: `design.md` and `implement.md` are required before `task.py start`.
