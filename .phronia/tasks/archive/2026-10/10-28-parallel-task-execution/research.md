# 调研：并行任务执行与合入治理

> 调研时间：2026-10-28
> 目的：为 Phronia 的并行任务能力确定边界，避免重新发明 agent 调度器或远端合并队列。

## 结论摘要

1. **并行单位是任务，集成的单位是分支/PR。** 成熟工具（Conductor）把 workspace 当作委派单位，把 branch/PR 当作集成单位；worktree 只是隔离手段，不是目标。
2. **worktree 只隔离文件，不隔离语义。** 两个任务改不同文件仍可能在运行时冲突（改名后的调用方、重复注册、迁移顺序）。因此必须"合入一个、验证一个"，且验证跑在合入后的结果上。
3. **合入必须串行，但并行可以发生在合入之前。** GitHub merge queue、Mergify、Harness 都采用 FIFO + 在"最新 base + 队列中前序变更"上跑检查；Graphite 进一步用 stack-aware 的惰性 rebase 减少重复 CI。
4. **冲突治理的关键是预防和分类，不是让模型硬解。** 业界实践普遍建议：路径预留/文件所有权避免重叠；机械冲突交给写该分支的 agent 在自己的 worktree 解决；语义冲突由人决定目标行为；锁文件/生成物通过重新生成解决。
5. **不存在"跨机器本地锁"。** 本地文件锁只能约束同一台机器上的 CLI；多人协作必须依赖远端 merge queue 或等价机制。

## 1. Conductor：workspace 与 PR 的双层模型

来源：<https://www.conductor.build/docs/concepts/workflow>、<https://www.conductor.build/docs/concepts/git-worktrees>

- 每个 workspace = 一个 git worktree + 一个分支 + 独立终端/进程/上下文。
- workspace 是**委派单位**，branch/PR 是**集成单位**；完成一个 workspace 就 review、开 PR、合并、归档。
- 明确建议：不要把同一个"文件密集重构"拆给两个 workspace，否则冲突是提前预约的。
- 需要共享同一分支状态时，用同一 workspace 的多个 chat，而不是多个 worktree。
- Git 约束：一个分支同一时刻只能在一个 worktree 检出；因此一个 workspace 通常独占一个分支。

**对 Phronia 的启示**：不要做"多 agent 共享一个 checkout"的调度器；把 task → branch → worktree 的对应关系固定下来，让 agent 在各自 worktree 内工作。

## 2. 合并队列：串行集成与 merge skew

来源：
- <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/using-a-merge-queue>
- <https://mergify.com/learn/merge-queue/speculative-merging>
- <https://developer.harness.io/code-repository/use-harness-code/pull-requests/merge-queue>

机制：

1. PR 通过自身检查后进入队列，按 FIFO 处理。
2. 队列创建临时 `merge_group` 分支 = 最新 base + 队列中位于它之前的 PR 变更。
3. CI 在这个合并结果上运行；通过才真正合并。
4. 某个 PR 失败/冲突 → 从队列移除，后面的条目重新计算并重跑。
5. 投机检查（speculative checks）让多个条目并行验证各自的"预测 base"，命中时吞吐提升；失败会级联作废后面的投机结果。

关键点：**合并队列解决的是 merge skew（各自通过、合在一起失败），不是文本冲突本身。** 它把"验证合并结果"变成强制步骤。

**对 Phronia 的启示**：本地模式必须复刻"在合并结果上验证"这一点；远端模式应把串行化交给远端队列，不要自己再实现一套。

## 3. Graphite：stack-aware 与惰性 rebase

来源：<https://graphite.com/docs/graphite-merge-queue>、<https://graphite.com/guides/merge-queue-comparison-github-gitlab-graphite>

- 传统队列按顺序验证每个 PR；Graphite 对整个 stack 做 fast-forward，已整体验证过的 stack 不再重复跑 CI。
- 惰性 rebase：只有检测到冲突的 PR 才 rebase，m 个冲突只产生 m 次 rebase/CI。
- 仍然明确：真正的语义冲突需要人介入；自动 rebase 失败就取消合并任务。

**对 Phronia 的启示**：任务之间若存在"堆叠"关系（B 基于 A），不要并行；要么串行，要么显式建成依赖边。不要为了并行而制造 stack。

## 4. 多 agent worktree 的冲突实践

来源：
- <https://parallelcode.app/blog/merging-parallel-ai-agent-branches/>
- <https://raylabs.app/articles/handling-git-merge-conflicts-in-multi-agent-worktrees/>
- <https://nimbalyst.com/blog/git-worktrees-for-ai-coding-agents-complete-guide/>
- <https://orcyx.dev/docs/run-multiple-ai-coding-agents-in-parallel>

可复用的规则：

### 4.1 任务拆分

- 每个 agent 一个任务、一个 checkout、一个分支。
- 先写清楚每个任务拥有哪些文件/模块；越界就停下来问，而不是悄悄改共享类型。
- 三种并行形态：
  - **独立特性**：不同区域，唯一可规模化的形态。
  - **堆叠工作**：B 依赖 A，不要同时跑。
  - **竞争尝试**：同一任务两套方案，保留更好的；token 贵但协调便宜。

### 4.2 悲观路径预留

- 编排器为任务声明目标路径；若后续任务与已预留路径重叠，则串行排队，而不是并发。
- 这比"事后解冲突"便宜得多。

### 4.3 合入顺序

1. 先合共享契约（类型、schema、API shape）。
2. 再合文件足迹最宽的分支（趁其他分支还小，容易 rebase）。
3. 再合窄的、独立的分支。
4. 最后合最实验性的工作（如果要放弃，别让它被 rebase 三次）。

### 4.4 合入循环

- **一次只合一个分支**，然后在新结果上跑完整验证，再合下一个。
- 用 `--no-ff` 保留单个合并提交，失败时一次 revert 即可回滚。
- 剩余分支 rebase 到新 base；rebase 前先暂停 agent，避免分支在脚下变化。

### 4.5 冲突归属

| 冲突类型 | 例子 | 处理者 |
|---|---|---|
| 文本/机械 | 两边都加 import、都往列表追加 | 写该分支的 agent，在它自己的 worktree 解决 |
| 同函数、不同意图 | 两边以不同目的重写同一方法 | 人先决定目标行为，agent 实现 |
| 语义/无冲突标记 | 改名、重复路由、校验器收紧 | 人；这是设计决策，不是合并 |
| 生成物 | lockfile、快照、生成代码、迁移 | 解决输入后重新生成，不手改输出 |

明确反对：让 LLM 直接处理冲突标记——模型容易丢掉相邻改动、编造逻辑或留下坏标记。

## 5. Git worktree 的硬约束

来源：<https://git-scm.com/docs/git-worktree>

- worktree 共享同一 object database、refs、remotes；各自有独立 working tree 和 index。
- 同一分支不能在多个 worktree 同时检出。
- 每个 worktree 的 `node_modules`、构建缓存、生成文件都是独立的 → 有 setup 成本。
- worktree 是开发隔离，不是安全边界。

## 6. 对 Phronia 的设计约束

1. **不做 agent 调度器/守护进程。** 主流 agent CLI 已经有原生 worktree/并行会话；Phronia 再做一层进程编排会重复且不可移植。
2. **Phronia 负责任务级决策与账本**：可并行性、任务↔分支↔worktree 映射、合入队列状态、冲突分类、远端交接。
3. **默认不总是 worktree。** 只有在并发/隔离有收益时才创建；串行小任务用当前 checkout 更省事。
4. **本地模式与远端模式二选一，默认自动检测。** 本地模式由 Phronia 维持单车道合入锁；远端模式只推送和记录 PR/MR，串行化交给远端 merge queue。
5. **任何"无法判断"都退化为串行 + 显式提示**，不静默并行。

## 7. 本仓库事实核查（v2 修订依据）

设计评审时验证了三个会改变架构的事实：

| 事实 | 验证方式 | 影响 |
|---|---|---|
| `.phronia/.runtime/` 被 `.gitignore` 忽略，且每个 worktree 各有一份 | `.gitignore:149`、`git worktree list`、`active_task.py::_runtime_sessions_dir` | 锁/队列/registry 放这里会导致不同 worktree 互不可见，串行合入失效 |
| `.phronia/tasks/**` 是跟踪文件，随分支走 | `git ls-files .phronia`（1487 个文件） | 在 linked worktree 新建的任务是 branch-local，主 worktree 的 planner 看不到 |
| 会话指针存在 `<worktree>/.phronia/.runtime/sessions/` | `active_task.py` 的 `_context_path` / `_runtime_sessions_dir` | 跨 worktree 的会话/任务状态必须显式聚合，不能假设共享 |

由此得出 v2 的三平面模型：控制平面（主 worktree）、共享运行时（`<git-common-dir>/phronia/`）、执行平面（linked worktrees）。协调状态属于仓库，不属于某个 checkout。

另一个交互事实：**运行中的 agent 会话 cwd 是固定的**，中途创建 worktree 并不能把会话移过去。因此工作区决定必须发生在启动会话之前；SessionStart 只能给建议，不能静默变更环境。

