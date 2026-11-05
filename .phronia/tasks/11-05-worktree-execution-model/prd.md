# Worktree-centric execution model: centralized root, default isolation, conflict preflight

## Goal

把 worktree 从"可选的并行原语"提升为 Phronia 的默认任务执行载体，让主检出回到纯粹的控制面角色（任务规划、集成目标、spec 统筹），并在不牺牲轻量任务体验的前提下收敛执行模型的分叉。

这个父任务本身不直接实现。它持有源需求集合、子任务地图、跨子任务验收标准，以及最终集成评审。

## Problem

当前执行模型有三处结构性分叉，各自都在制造维护成本：

1. **存储位置不唯一。** worktree 默认在 `<repo>/.phronia/worktrees/<slug>`，但 `attach --path` 允许任意目录（实践中出现过大量 `<parent>/<repo>-<slug>` 同级目录）。没有任何机制保证新目录被 ignore，因此配置了非默认 `worktree_dir` 的项目会把 worktree 内容暴露给 `git status`。清理只能靠 `worktree list` 逐条识别，无法按目录整体回收。

2. **隔离是条件行为。** `decideWorkspace` 只有在 `worktree=always`、`exclusive`、或同父任务有 ≥2 个 in_progress 兄弟时才创建 worktree，其余情况复用主检出并抢 claim。结果是"这个任务会不会被隔离"在开始前不可预测，主检出同时承担执行与集成两种角色，claim 状态机（busy/stale/stale-dirty/owner-active）成为主要复杂度来源。

3. **冲突不可见。** footprint 重叠检测（`footprintOverlap`）已经存在并被 planner 与 integrate 使用，但只在"已经决定并行"或"集成失败"时生效。新建任务阶段不会提示"你正在动的文件和另一个进行中的任务冲突"，用户只有在 integrate 冲突时才发现。

## Scope

### In scope

- 集中、可配置、被 gitignore 管理的 worktree 根目录，以及旧位置的只读兼容。
- 单任务默认隔离的策略模型，含显式的轻量（非隔离）通道。
- 新建/启动任务前的 footprint 冲突预检，分级输出且不阻断。
- 归档后回收 worktree 的既有行为在集中目录下的正确性与可观测性。
- 上述改动涉及的 skill / command / workflow 文案与 CLI 输出。

### Out of scope

- 平台原生 worktree 创建（Claude Code `--worktree` 等）；Phronia 继续只做 attach。
- 自动解决 merge 冲突或语义冲突。
- 跨仓库并行（cross-repo）的语义变更。
- 端口、数据库、Docker 等运行时资源隔离。
- 自动搬迁已存在的旧目录（只做只读兼容与提示，不搬移用户数据）。

## Constraints

- **分层，不做单点修补。** worktree 根目录的"真相"必须只有一个来源，其余层（core policy、core layout、CLI services、Python scripts、templates）从该来源派生。禁止在各处复制字面量后靠测试对齐。
- **不破坏既有项目。** 已经在旧路径（`.phronia/worktrees/` 或同级目录）注册的 worktree 必须继续可用：读路径保留回退，写路径只用于新建。
- **新策略只对新任务生效。** 任何改变执行位置或隔离决定的规则，其分界依据必须是任务自身的持久化标记，不能是项目版本号或创建日期。升级前创建的任务，升级后行为逐字段不变。
- **升级必须平滑。** `phronia update` 不搬移、不删除、不改写既有 worktree 与任务记录；只做补齐（gitignore、缺失注册表条目）和提示。升级时处于 planning/in_progress 的旧任务，不需要任何手工步骤即可继续推进。
- **不阻断只提示。** 冲突预检、未知 footprint、目录迁移提示都不得阻止用户创建或启动任务；唯一的硬门是既有安全规则（dirty worktree 不删、unlanded 不删）。
- **轻量任务必须有出路。** 单文件/文档/配置类任务不得被迫走完整 worktree 流程；但"不隔离"必须是显式决定，不能是隐含结果。
- **可观测。** 所有新增决策（为何隔离、为何提示冲突、目录落在哪里、任务用的是哪套策略）必须能在 `--json` 输出中读到，供 agent 与用户双方消费。

## Task map

| 子任务 | 交付 | 依赖 |
|---|---|---|
| `11-05-worktree-managed-root` | 集中根目录 + 受管 gitignore + 旧路径只读兼容 | 无（必须先行） |
| `11-05-worktree-default-isolation` | 隔离分层策略 + 轻量通道 + 文案与回收行为 | managed-root |
| `11-05-worktree-conflict-preflight` | footprint 冲突预检 + 分级输出 + 流程接入 | managed-root |

依赖不是执行阻塞：三个子任务都能独立规划与验收，但 `default-isolation` 的目录语义和 `conflict-preflight` 的冲突归因都假定集中根已存在。实际实施顺序应遵守上表。

## Cross-task acceptance criteria

- [ ] worktree 根目录只有一个解析入口，其余层通过它派生；修改默认值只需改一处加回退逻辑。
- [ ] 任何新建的 worktree 都落在受管理的根目录下，且该目录被 git 忽略（含用户自定义根目录的情形）。
- [ ] 已存在的旧路径 worktree 仍可 attach、commit、integrate、archive，且 `doctor` 能报告它们的位置与可回收状态。
- [ ] 单任务默认进入隔离目录；选择非隔离执行是显式行为，且在 `--json` 中可区分。
- [ ] 新建任务时若与活跃任务存在确定的文件重叠，用户能看到具体冲突路径与对方任务；未知 footprint 只提示声明 `touches`，不报假冲突。
- [ ] 归档后 landed 且 clean 的 worktree 被回收，集中目录下不残留目录；未 landed 或被 attach 的目录保留并给出可执行的清理命令。
- [ ] **升级前后，所有既有任务的 `workspace ensure` 决策逐字段一致**（新旧策略共存期的核心回归）。
- [ ] **升级前后，所有既有 worktree 的路径逐字节不变**；旧任务可完整走完 commit → integrate → archive。
- [ ] **升级过程不产生任何对既有 `task.json` 或 worktree 目录的写入**（可用 git status 与残留目录对照验证）。
- [ ] 全部行为有单测或集成测试覆盖，`pnpm test` 与现有回归套件保持绿。

## Migration contract

这一组任务改变长期默认行为，因此升级语义本身就是验收对象：

| 维度 | 规则 |
|---|---|
| 分界依据 | 任务自身的持久化策略标记（创建时写入），不是项目版本号、不是 `createdAt` |
| 旧任务 | 缺少标记 = 按升级前的策略求值，行为逐字段不变 |
| 旧 worktree | 位置不变、可继续 commit/integrate/archive，归档时在旧位置回收 |
| 升级动作 | 只补齐（gitignore 块、缺失注册表条目）+ 提示；不搬移、不删除、不改写任务记录 |
| 提示位置 | `update` 一行说明 + `doctor` 计数与位置；均不阻断、不改退出码 |
| 退出路径 | 单条任务可用 `phronia task workspace policy <ref> --set default` 主动升级 |

## Notes

- 父任务在全部子任务归档并通过交叉验收前保持 `planning`/`in_progress`，不作为实现目标。
- 每个子任务必须写 `design.md`；父任务只保留需求与任务地图。
