# Default task isolation policy with lightweight escape hatch

## Goal

让 worktree 成为**默认**的任务执行载体，而不是只有并发时才启用的条件行为；同时保留一条显式的、有边界的非隔离通道，使单文件或文档类任务不必承担完整 worktree 流程的开销。

## Problem

当前 `decideWorkspace` 的隔离条件分散在 `packages/core/src/task/workspace/policy.ts` 与 `packages/core/src/task/dispatch/policy.ts:51` 的 `requiresIsolation()` 中，只在以下情形创建 worktree：

- `parallel.worktree = always`
- 任务标记 `exclusive`
- 同父任务有 ≥2 个 in_progress 兄弟
- 主检出已被其他任务 claim

其余情况下任务复用主检出并抢 claim。这带来后果：

1. **结果不可预测。** 同一个任务在不同时刻、不同兄弟任务状态下会得到不同决策，用户与 agent 都无法事先知道"这个任务会不会被隔离"。
2. **主检出承担双重角色。** 它既是执行目录又是集成目标，因此 `claim` 状态机（busy / stale / stale-dirty / owner-active）成为 `policy.ts` 主要复杂度来源；跨任务串味（A 任务未提交改动被 B 任务编译）只能靠 dirty 检查兜底。
3. **没有明确的轻量通道。** 现在"不隔离"是默认结果而非显式选择，所以无法针对小任务做差异化（例如跳过 worktree 但保留任务目录 commit 纪律）。

## Requirements

### R1 分层隔离策略

引入显式的隔离层级（isolation tier），由任务元数据与任务形态共同决定，规则集中在一处，输出可解释的理由：

- `isolate`：默认层。任务声明了 `meta.parallel.touches`、涉及多目录、或该仓库已有其他活跃任务时进入。
- `reuse-current`：轻量层。必须在任务上显式声明（例如 `meta.parallel.worktree: "never"` 或等价的轻量标记），且仅在主检出干净、无其他活跃任务占用时成立。
- `always`：强制层。重构/大改任务显式声明，行为等同今天的 `worktree=always`。

策略函数返回层级 + 理由码，理由码进入 `--json`。

### R2 决策可解释

`workspace ensure --json` 的 `decision` 必须包含：层级、命中的规则、以及"如果换一种声明会得到哪一层"的一句话建议。当前只有 `reason` 自由文本，无法被 agent 稳定消费。

### R3 轻量通道的边界

`reuse-current` 必须满足全部条件，否则降级为 `isolate`：

- 主检出干净（或仅有本任务的任务目录改动且可 scoped commit）
- 没有其他 in_progress 任务持有 claim
- 任务未声明 `meta.parallel.touches` 覆盖多个顶层目录

轻量通道不得悄悄触发 claim 状态机的新分支；它的写入仍走既有 dirty 检查。

### R4 dispatch 一致

`requiresIsolation()` 与新的层级策略共用同一判定，禁止出现"workspace 说不隔离、dispatch 说必须隔离"的分歧。`DISPATCH_ISOLATION_REQUIRED` 的触发条件必须能从层级策略推导。

### R5 文案与流程

以下位置同步更新，措辞从"若需要隔离"改为"默认在任务目录执行，轻量任务可显式就地执行"：

- `templates/workflow/workflow.md`（Phase 1.4 workspace decision、Phase 2 workspace 段、Phase 3 finish 段）
- `templates/common/commands/continue.md`（Step 2）
- `templates/common/commands/finish-work.md`（worktree 前置检查）
- `templates/common/skills/brainstorm.md`（任务创建后的下一步）
- `templates/common/skills/coordinator.md`（波次准备）

### R6 归档回收

沿用 `task_store.py:_guard_worktree_before_archive()` 的既有语义（dirty 拒绝 / landed+clean 删除 / 未 landed 拒绝），并补充：

- 回收后输出释放的磁盘量（已有能力，确认在集中目录下仍生效）。
- 对被 `attach` 进来的外部目录，拒绝自动删除并给出显式清理命令，不静默跳过。

### R7 只对新任务生效（行为分界）

新的默认隔离策略**不得**改变已存在任务的行为。分界依据必须是任务自身的持久化记录，而不是项目版本号——因为用户可能在一个新版本项目里继续推进一个旧版本创建的任务。

- 分界标记写入 `task.json`（例如 `meta.workspace.policyVersion` 或等价字段），在任务创建时由 `task.py create` 落定。
- 缺少该标记的任务（升级前创建的所有任务）一律按**旧策略**求值：即 `decideWorkspace` 现有逻辑原样保留，`reuse-current` 仍是默认结果。
- 带新标记的任务按三级隔离策略求值。
- 禁止用"项目先升级再看创建时间"推断：`createdAt` 只能精确到日期，且宽松估算会在升级当天误伤。

### R8 升级平滑

- `phronia update` 在检测到"项目存在旧策略任务"时，输出一行迁移说明（不是错误、不阻断），指出：旧任务保持原行为，新任务默认隔离，可用 `phronia task workspace policy <ref> --set default` 单条升级。
- 升级过程不得改写任何既有 `task.json`；标记只在任务创建时写入。
- `phronia doctor` 报告两类任务的计数，让用户能一眼看到"还有 N 个旧策略任务"。

### R9 未完成旧任务的兼容

升级时处于 `planning` / `in_progress` 的旧任务必须继续可推进，不需要任何手工步骤：

- `workspace ensure` 对旧任务返回与升级前一致的决策结果（含 `reuse-current` 时的 claim 行为）。
- 已存在的旧 worktree（旧根目录、注册表里的外部路径、`task.json.worktree_path` 遗留字段）继续 attach / commit / integrate / archive。
- 一个正在旧策略下并发运行的多任务项目，升级后其后续 `ensure` 调用不得突然要求迁移到 worktree，否则会打断正在进行的会话。
- `task.py archive` 与 `finish-work` 对旧任务的行为不变。

## Acceptance Criteria

- [ ] 新建并启动一个普通多文件任务，`ensure` 返回 `create`（isolate 层），主检出不被 claim。
- [ ] 显式声明轻量层的单文件任务在干净主检出上返回 `reuse-current`，且不创建目录。
- [ ] 主检出被其他任务占用时，轻量任务降级为 `isolate` 并在 `--json` 中说明原因。
- [ ] `requiresIsolation()` 与层级策略对同一组输入给出相同结论（表驱动测试覆盖）。
- [ ] 五处文档与命令模板文案已更新，且不再暗示"隔离是并行才需要"。
- [ ] 归档一个 landed 且 clean 的 worktree 任务后，目录被删除并报告释放空间；未 landed 的任务被拒绝并给出下一步。
- [ ] 被 attach 的外部 worktree 在归档时不被删除，输出显式清理命令。
- [ ] 升级前创建的任务（无策略标记）在升级后 `ensure` 结果与升级前逐字段一致（表驱动对照测试）。
- [ ] 升级前创建、已带旧 worktree 的任务可完整走完 commit → integrate → archive。
- [ ] `update` 在有旧策略任务时输出迁移说明且退出码不变；`doctor` 输出两类任务计数。
- [ ] 升级不改写任何既有 `task.json`（可用 git status 验证）。

## Notes

- 依赖 `11-05-worktree-managed-root`：集中根不存在时，"默认隔离"会让目录散落得更明显。
- 该任务改变既有行为。用户已确认：**只对新任务生效**，旧任务保持原策略，且升级必须平滑（R7-R9）。
- R7 的选择意味着 `decideWorkspace` 在一段时间内需要同时服务两套策略。design.md 必须说明如何组织这两条路径，避免它们在同一函数里交织成条件泥潭（建议：策略选择前置为独立的策略对象，两种实现分别封装，决策函数只做分发）。
