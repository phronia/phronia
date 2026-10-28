# 并行任务执行与协调者编排：worktree 隔离、串行合入、冲突治理与子代理并行

> 修订 v3（2026-10-28）：coordinator 模式纳入同一任务的终态，不再作为"后续再说"；新增 Phase 0 能力验证，先确认 harness 的并行子代理、每任务工作区和显式 task_ref 能力，再实现 coordinator。v2 的隔离、claim 与合入设计保持不变。

## Problem

Phronia 当前的执行模型是"一次一个活动任务、一个 checkout、一条分支"。当任务池里有多个互不耦合的任务时（例如一个项目积压了 3–5 个独立的 UI/报表/脚本修复），只能串行推进，等待时间主要花在 agent 执行和验证上，而不是花在真正有依赖关系的工作上。

现有基础不足：

- `phronia task worktree add|list|remove` 只是原语：能创建隔离工作区，但不回答"哪些任务可以并行"。
- 任务记录已有 `branch` / `base_branch` / `worktree_path` / `commit` / `pr_url`，但没有合入队列、冲突分类或状态聚合。
- v0.5.0 移除了旧的 `multi_agent` pipeline 和 `parallel` 命令，因为主流 agent CLI 已有原生 worktree 支持；但"任务级并行决策 + 合入治理"仍然缺失。
- 没有远端仓库的个人项目、以及有远端但无 forge CLI 的项目，需要不同的落地方式。

## Goal

让 Phronia 能安全地把"没有明显耦合"的任务并行推进，并保证任何并行结果最终都以**可验证、可回滚、串行**的方式进入集成分支。

终态是：**单会话多任务（coordinator）与多会话多任务（并行执行）共用同一套任务、worktree、claim 和合入原语。** coordinator 不引入第二套执行模型，只是在同一套原语上增加任务索引、任务租约、派发清单和能力门控。

具体目标：

1. 给出可解释的并行判定：哪些任务可以同批，哪些必须串行，为什么。
2. 为需要隔离的任务建立 task ↔ branch ↔ worktree 的一一映射。
3. 提供单车道合入机制：同一时刻只有一个任务在合入，验证跑在合入后的结果上。
4. 同时支持两种集成后端：本地合并（无远端）和远端 MR/PR（有远端）。
5. 对冲突做分类和路由，明确哪些能自动处理、哪些必须人工接管。
6. 保持零守护进程：Phronia 不启动/调度 agent 进程，只维护任务账本和合入状态。
7. 支持 coordinator 模式：单会话读取积压、规划批次、准备 worktree、通过 harness 原生子代理派发、聚合状态、串行合入；新会话可中途加入任务。

## 典型场景

### 场景 A：无远端的个人项目

一个本地 git 仓库，没有 `origin`。积压 4 个互不耦合的小任务。

期望：`parallel plan` 给出 1–2 个批次；每个任务在自己的 worktree/分支完成；`phronia task integrate` 逐个 rebase、验证、fast-forward 到 `main`。全程不需要网络。

### 场景 B：有 GitHub/GitLab 远端的团队项目

多个开发者/多个会话同时工作。期望：Phronia 创建 worktree、推送分支、创建 PR/MR 并记录 `pr_url`；**不执行远端合并**，由远端 merge queue 保证串行；Phronia 只跟踪状态，合并后同步标记。

### 场景 C：任务之间有隐藏耦合

两个任务分别改同一个共享类型和一个新增调用方，文件不重叠但语义冲突。期望：合入第一个后，第二个在合入结果上验证失败；Phronia 回滚并标记为 `semantic`，要求人工决定目标行为，而不是自动改写。

### 场景 D：任务确实有依赖

任务 B 需要任务 A 产出的接口。期望：`parallel plan` 把 B 放到 A 之后的批次；如果用户强行并行，命令给出明确拒绝或警告。

## Requirements

### Must Have

- **R1 可并行性判定**：基于显式依赖、文件足迹（footprint）、项目级"总是串行"路径，计算可并行批次；未知足迹默认串行；`--explain` 必须说明每个串行化/并行化决策的原因。
- **R2 工作区策略**：支持 `auto | always | never` 三种 worktree 策略；`auto` 仅在并发或显式隔离时创建 worktree；创建工作区时支持复制 gitignored 文件和执行 setup 命令。
- **R3 串行本地合入**：提供 `task integrate`（不提供 `land` 别名），在同一时刻只允许一个合入操作（仓库级共享租约锁，同仓所有 worktree 共用；跨机器无效）；顺序为 rebase → 在 rebase 结果上验证 → fast-forward 集成分支；失败不得留下半合入状态。
- **R4 原子回滚与崩溃恢复**：记录合入前 SHA；验证失败或 fast-forward 冲突时回到合入前状态；提供 `integrate --recover` 处理中断的合入。
- **R5 远端集成模式**：检测到远端和 forge CLI 时，推送分支、创建 PR/MR、记录 URL；Phronia 不自行合并；远端不可用时显式降级为"仅推送 + 打印操作指引"。
- **R6 冲突分类**：至少区分 `mechanical`（机械文本冲突）、`semantic`（合入后验证失败/意图冲突）、`generated`（锁文件/生成物）、`duplicate`（add/add 或重复实现）；每类给出明确的下一步。
- **R7 状态聚合**：`parallel status` 展示每个任务的 worktree、分支、领先/落后提交数、足迹重叠、队列位置、合入状态和最近一次失败原因。
- **R8 生命周期一致性**：任务归档时不得静默留下 worktree；有未提交改动时拒绝归档；干净且已合入时清理 worktree。
- **R9 无远端/边界场景**：无 `origin`、detached HEAD、bare repo、dirty 主 checkout、submodule、polyrepo 包都必须有显式行为，不得静默 no-op。
- **R10 控制平面与执行平面分离**：`.phronia/tasks` 随分支走、`.phronia/.runtime` 每个 worktree 一份；跨 worktree 的锁、队列、worktree 映射必须放在仓库级共享运行时（`<git-common-dir>/phronia/`），否则串行合入失效。
- **R11 任务级工作区决策**：隔离单位是任务，不是会话；同一任务的新会话必须 attach 已有工作区，不得创建第二个 worktree；工作区决定支持 `reuse-current | attach | create | refuse`，并在创建前确认。
- **R12 工作区时机**：运行中的 agent 会话 cwd 固定，Phronia 不得假装能在会话中途切换工作区；SessionStart 只读，工作区决定发生在认领任务时，必要时提示用户在新目录启动会话或使用平台原生 worktree。
- **R13 集成模式交互**：模式先按"任务覆盖 → 命令行 → 项目配置 → 自动检测"解析；只在两种模式都可行且有实质差异时询问一次，并把选择记在任务上；提示必须说明后果（本地线性历史/无 PR/机器锁 vs 远端 PR/CI/merge queue）。
- **R14 平台原生 worktree 接管**：支持 `worktree attach` 校验并登记平台（Claude Code、Conductor、Cursor 等）已创建的 worktree，不重复创建。
- **R15 工作流集成**：并行能力必须进入 `phronia-continue`、`phronia-finish-work`、per-turn breadcrumb 和 `workflow.md`，而不是孤立命令；`finish-work` 先 integrate 再 archive。
- **R16 主 checkout 占用与原子认领**：占用以显式 workspace claim 为准，不以任务状态或 `git diff` 为准；用 `O_EXCL` 原子认领，消除 check-then-act 竞态；claim owner 从 session 迁移到 task；stale + 主 checkout 脏时绝不回收；不引入计数器。
- **R17 Provisional workspace**：主 checkout 被占且任务尚未创建时，允许先创建 provisional worktree（`taskRef: null`），任务创建后在同一工作区绑定；避免向被占用的主 checkout 写任务工件。
- **R18 共享任务索引**：共享运行时维护可重建的 `tasks.index.json`（taskRef/title/status/priority/footprint/dependsOn/owner/workspace/updatedAt）；新会话创建任务时登记；orchestrator 用它做跨会话规划。索引不是第二份事实来源，可由主 worktree + 各 worktree 的 `task.json` 重建。
- **R19 任务租约**：task lease 防止 orchestrator、子代理、新会话重复领取同一任务；与 workspace claim、integration lock 是三个不同的互斥；租约原子获取、心跳、TTL、显式释放，过期可被回收。
- **R20 协调者会话模型**：会话可处于 coordinator 模式，活动任务指针为空，batch id 存在会话 runtime；breadcrumb 显示 batch 状态；所有任务命令接受显式 `--task`，coordinator 模式下禁止依赖环境指针。
- **R21 派发清单**：`parallel dispatch --batch <id> --json` 输出 taskRef/workspace/branch/lease/dependsOn/promptPrefix；Phronia 不启动子代理，由 harness 原生能力派发。
- **R22 子代理能力门控**：能力矩阵增加 `subagentExecution` / `subagentWorkspace` / `subagentIdentity`；coordinator 至少要求 `parallel` + `per-task`；不满足的平台降级为多会话或串行；Phase 0 必须在真实 harness 上验证，不能按"应该都支持"假设。W0 首轮结论：ZCode/Codex 只能 multi-session；Claude Code 是 coordinator 候选（schema+docs，live 待跑）。
- **R23 提交归属**：worktree 任务在 integrate 前必须提交；提供 `task commit <ref>`，或由 task agent/orchestrator 在任务 worktree 内提交；orchestrator 不在 main 上替 worktree 任务提交。
- **R24 监控、失败与新会话加入**：`parallel status --json` 聚合 batch 状态；task lease stale 可回收；子代理失败标记 blocked 并继续其他任务；新会话创建任务登记索引，orchestrator 重新 plan 进入下一 wave；不引入全局 batch 锁。

### Nice to Have

- **N1 批次清单导出**：`parallel plan --json` 可被外部 orchestrator（脚本、其他 agent CLI）消费。
- **N2 投机验证**：在锁外提前对"预测 base"跑验证，进入锁后只做快速确认；首版可不实现。
- **N3 队列排空**：`integrate --drain` 按 FIFO 处理所有已排队任务，适合批量收尾。
- **N4 冲突摘要**：为 `semantic` 冲突生成 `conflict.md`（双方 diff、失败输出、建议决策点）。

## Non-Goals

- 不实现 agent 进程调度、会话复用或终端多路复用（交给平台的 native worktree / 多会话能力）。
- 不自动解决语义冲突；不让模型直接改写冲突标记并当作成功。
- 不实现跨机器的分布式锁；多人协作的串行化由远端 merge queue 负责。
- 不自动创建远程仓库、不自动配置凭证、不自动 push 到用户未授权的远端。
- 不取代远端 CI；本地验证命令由项目配置显式提供。
- 不把父/子任务关系当作依赖关系；依赖必须显式声明。
- coordinator 不引入第二套执行模型：它复用同一套任务、worktree、claim、lease 和 integrate；不实现自己的 agent 进程调度。

## Constraints

- 零守护进程、零后台服务；所有状态落在仓库内的 JSON/任务元数据中。
- Git 是 worktree/分支存在性的唯一事实来源；Phronia 的 registry 只是诊断缓存。
- 遵循 `packages/core` 与 `packages/cli` 的边界：纯决策逻辑放 core，参数/输出放 cli；core 不打印、不 `process.exit`。
- 不引入新的运行时依赖到 `packages/core`。
- 跨平台：路径、锁文件、进程探测必须在 macOS / Linux / Windows 上可运行。
- 默认保守：无法判断依赖或足迹时串行；无法验证时要求显式 `--no-verify`，不得静默通过。
- 所有会改变用户仓库的操作必须可 dry-run、可回滚、错误信息包含下一步命令。

## Acceptance Criteria

### 并行判定

- [ ] 给定 3 个足迹互不重叠、无依赖的任务，`parallel plan --json` 返回单个批次且包含 3 个任务。
- [ ] 给定 2 个任务都声明 `packages/cli/src/commands/worktree.ts`，planner 返回 2 个批次，`--explain` 指出重叠路径。
- [ ] 给定任务 B 声明 `depends_on: [A]`，B 不早于 A 所在批次。
- [ ] 给定任务未声明 `touches`/`relatedFiles`/`package`，planner 将其单独成批并在 `--explain` 中标记 `unknown_footprint`。
- [ ] `parallel plan` 在 `parallel.enabled: false` 时输出禁用原因，而不是静默空结果。

### 本地合入

- [ ] 两个任务同时执行 `integrate`：只有一个获得锁；另一个返回队列位置或明确的"稍后重试"，不会交错写入集成分支。
- [ ] `integrate` 在验证失败时不移动集成分支；任务 outcome 变为 `blocked`（reason=verify），并记录日志路径。
- [ ] `integrate` 在 rebase 冲突时不自动解决；返回冲突文件列表和 `mechanical`/`unknown` 分类。
- [ ] 合入成功后，代码提交是已验证的；随后可能有一个仅改 `task.json` 的 metadata-only commit，不改变代码树。任务记录写入 `commit` / `pr_url` 和 `meta.integration.outcome=landed`。
- [ ] 模拟进程在 fast-forward 后、状态写入前崩溃：`integrate --recover` 能识别已完成合入并补齐状态，或安全回退。
- [ ] 主 checkout 脏时 `integrate` 拒绝执行并给出提交/暂存建议。
- [ ] 任务本身使用主 checkout 时，`integrate` 只做验证 + 写 outcome，不执行 rebase/fast-forward。
- [ ] 任务使用 worktree 且主 checkout 被其他任务占用时，local `integrate` 等待或明确失败并建议 remote，不抢占主 checkout。
- [ ] local `integrate` 按 workspace claim → integration lock 的固定顺序获取，并发场景无死锁。

### 远端模式

- [ ] 无 `origin` 时 `--mode remote` 明确失败并提示使用 `--mode local`。
- [ ] 有 `origin` 但无 `gh`/`glab` 时，推送成功后状态为 `pushed`，并打印手工创建 MR 的命令。
- [ ] 有 `gh` 时成功创建 PR，`task.json.pr_url` 被写入；Phronia 不调用任何 merge API。
- [ ] 远端已合并后执行 `integrate --mode remote --sync`，识别祖先关系并标记 `outcome=landed`。

### 冲突与边界

- [ ] 两个任务 add/add 同一路径时，后合入者被分类为 `duplicate`，不被自动覆盖。
- [ ] 合入后验证失败但 rebase 无文本冲突时，分类为 `semantic`，并在报告里列出失败命令与输出摘要。
- [ ] 任务归档时 worktree 存在未提交改动 → 归档被拒绝；干净且已合入 → worktree 被清理。
- [ ] detached HEAD、bare repo、submodule 指针变更均有显式错误或警告，不出现静默成功。
- [ ] 在无远端仓库中完成一次完整的 plan → workspace ensure → worktree → integrate 流程，且 `main` 历史保持线性。

### 架构与交互（v2）

- [ ] 在 linked worktree 中执行 `integrate`，锁文件位于 `<git-common-dir>/phronia/`，主 worktree 能立即看到同一把锁；两个 worktree 不会交错合入。
- [ ] `.phronia/.runtime/worktrees.json` 的旧条目能迁移到共享 registry；丢失 registry 时可由 `git worktree list` 重建。
- [ ] 同一任务在两个会话中执行 `workspace ensure`：两个会话都得到同一个 worktree 路径，不创建第二个工作区。
- [ ] 任务 A 占用主 checkout 时，为新任务 B 执行 `workspace ensure` 返回 `create` 并请求确认；确认后创建的 worktree 分支从集成分支分叉，而不是从 A 分支分叉。
- [ ] 平台原生 worktree 已存在时，`worktree attach` 登记成功且不重复创建；分支不匹配时拒绝并说明。
- [ ] 创建 worktree 前，任务目录已进入集成分支，或用户显式选择 scoped commit / `--copy-task`；worktree 内能读到 prd/design/implement。
- [ ] 创建 worktree 后主 checkout 保持干净；`task.json.worktree_path` 不再被写入，运行时映射只存在共享 registry。
- [ ] 默认 worktree 位于 `.phronia/worktrees/<task-id>`；系统重启后目录和未提交工作仍在；除非显式 `ephemeral`，不使用 `/tmp`。
- [ ] 归档或 `worktree prune` 只删除"干净且已合入"的 worktree；dirty、未合入、未推送的 worktree 被保留并给出原因。
- [ ] 两个会话同时执行 `workspace prepare`：只有一个认领主 checkout，另一个必然得到 worktree；不存在两者都判断"main 空闲"的窗口。
- [ ] 主 checkout 被占且新任务尚无工件时，先创建 provisional worktree；`task create` 在同一工作区绑定任务，不向主 checkout 写入新任务目录。
- [ ] 任务在 `planning` 阶段没有任何文件改动，仍持有主 checkout 的 claim；提交全部改动后仍持有，直到 integrate/archive/release。
- [ ] stale claim 且主 checkout 有未提交改动时，不回收，新会话改用 worktree 并提示旧占用者。
- [ ] stale claim 但 owner 任务仍是 `planning`/`in_progress` 时，默认不回收；只有显式 `workspace reclaim` 才回收。
- [ ] 无 claim 但主 checkout 脏时，默认创建 worktree；`--reuse-dirty` 才复用。
- [ ] 任务本身使用主 checkout 时，`--mode remote` 被拒绝并提示 local 或在新工作区开始。
- [ ] SessionStart/breadcrumb 不创建、不删除、不切换任何工作区；只输出建议。
- [ ] 无远端时 `integrate` 不询问模式，直接说明使用 local；有远端且两种模式都可行时只询问一次，第二次重试不再询问。
- [ ] 用户选择 remote 后，Phronia 只 push + 建单，不调用任何 merge API；选择 local 后不再推送。
- [ ] `finish-work` 在 integrate 失败时停止，不归档任务；成功后归档并清理已合入的 worktree。
- [ ] 在主 worktree 执行 `parallel plan` 看不到 linked worktree 中新建的 branch-local 任务；`parallel status` 会单独列出它们并标注 `branch-local`。

### 协调者模式（v3）

- [ ] Phase 0 在至少 3 个真实 harness 上验证：并行子代理、每任务独立 cwd/worktree、显式 `task_ref` 转发；结果写入能力矩阵，未验证的平台不得标记为支持。
- [ ] 不支持的 harness 上执行 coordinator 命令时明确拒绝或降级为多会话/串行，并说明原因；不静默 no-op。
- [ ] 新会话创建任务后，orchestrator 的 `parallel status` 能在不读取该 worktree 的情况下看到任务摘要（通过共享索引）。
- [ ] 两个子代理同时领取同一任务：只有一个 task lease 成功，另一个明确失败或被分配到其他任务。
- [ ] coordinator 会话没有活动任务指针时仍可规划 batch；所有命令使用显式 `--task`，不依赖环境指针。
- [ ] `parallel dispatch --batch --json` 输出 workspace/lease/promptPrefix；Phronia 没有启动任何 agent 进程。
- [ ] worktree 任务未提交时 `integrate` 拒绝；执行 `task commit <ref>` 后可以合入；orchestrator 不在 main 上替 worktree 任务提交。
- [ ] 新会话在 batch 执行中加入任务：不重叠的任务进入下一 wave 或当前可用空位；重叠的任务等待，不会与运行中任务并行。
- [ ] 子代理失败后任务标记 blocked，其他任务继续；stale task lease 可被回收，不永久阻塞。
- [ ] 整批完成后 `integrate --drain` 串行合入；orchestrator 不占用 main 导致 local integrate 饿死。

## Risks

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户误以为 worktree 能消除语义冲突 | 合入后运行时故障 | 强制"合入结果验证"；文档明确边界 |
| 本地锁被跨机器场景误用 | 并发写入/覆盖 | 多人项目默认远端模式；状态输出标注锁作用域 |
| 验证命令缺失导致"假绿" | 坏代码进入集成分支 | 无验证命令时必须显式 `--no-verify`，并在状态中标记 `unverified` |
| 每个 worktree 的依赖安装成本高 | 并行反而更慢 | `auto` 策略 + 可配置 `post_create`，只在收益明确时创建 |
| 任务足迹声明不准 | 该串行的被并行 | 默认未知即串行；合入时仍做重叠检测和验证 |
| 与现有 `task worktree` 行为不一致 | 用户困惑 | 复用原语，新增命令只做编排；迁移文档列出差异 |

## Decisions

已拍板（2026-10-28）：

1. **命令名**：`phronia task integrate`；不加入 `land` 别名，避免语义发散。
2. **确认频率**：`confirm: auto`。auto 每次做出选择时都必须输出解析结果和原因（例如 "mode=remote because origin + gh available"），用户可据此纠正；首次远端建 PR 前询问一次。
3. **单包仓库并行前提**：必须声明目录/模块级足迹；未知即串行；后续体验不好再考虑放宽。
4. **主 checkout 占用**：以显式 workspace claim 为准，不以任务状态或 `git diff` 为准；`O_EXCL` 原子认领；需要 provisional workspace 支持"先隔离、再建任务"；不使用计数器。详见 `design.md` §4.6 与 `decisions.md` §4-深化。
5. **linked worktree 中 `task create`**：允许 + 警告 branch-local + 跨 worktree 重名检查。
6. **worktree 位置**：持久化 `.phronia/worktrees/<task-id>`；归档时清理；`/tmp` 仅显式 ephemeral。
7. **coordinator 范围**：纳入同一任务的终态，不作为后续 child task；但先做 Phase 0 能力验证，再实现 coordinator。验证不通过的平台降级为多会话或串行，不假装支持。

仍可调整的默认值：`parallel.integration.confirm` 的具体触发条件、claim TTL、provisional workspace 的命名。

## Success Metrics

这些指标用于判断"功能是否真的可用"，不是实现细节：

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 并行批次可解释性 | 100% 的并行/串行决策都有原因 | `parallel plan --explain` 每条任务都有 footprint 来源、level、重叠对象 |
| 无静默并行 | 未知足迹任务并行数 = 0 | planner 单测 + `--explain` 断言 |
| 合入串行性 | 并发 integrate 交错写入 = 0 | 临时仓库双进程测试 |
| 合入结果验证 | 100% 的 local integrate 在 rebase 后的树上跑验证 | 集成测试检查命令执行目录与 base SHA |
| 语义冲突自动解决 | 0 次 | 代码路径不存在冲突标记改写；测试断言 handoff 生成 |
| 生命周期残留 | 归档后残留 worktree = 0 | archive 守卫测试 |
| 主 checkout 洁净 | integrate 成功后主 checkout dirty = 0 | 集成测试 `git status --porcelain` |
| 崩溃恢复 | 每个 phase 模拟崩溃后 recover 一致 = 100% | 故障注入测试矩阵 |
| coordinator 能力诚实 | 未验证平台标 `supported` = 0 | Phase 0 证据检查 + `features.ts` gate 测试 |
| 子代理重复领取 | 同一任务同时 lease 成功 > 1 = 0 | lease 并发测试 |
| 新任务重叠并行 | 与运行中任务足迹重叠仍并行 = 0 | coordinator 调度测试 |
| 启动开销 | `parallel plan` 100 个任务 < 1s；`status` < 2s | benchmark/单测超时 |

## Requirement Traceability

| R | 验收章节 | 测试类型 | Phase |
|---|---|---|---|
| R1 可并行性判定 | Acceptance: PLAN-01..04 | unit + integration | A |
| R2 工作区策略 | WS-01..04 | unit + integration | B |
| R3 串行本地合入 | INT-01 | integration + e2e | C |
| R4 原子回滚与恢复 | INT-02, INT-05 | integration (fault injection) | C |
| R5 远端集成 | INT-04 | integration (mock forge) | D |
| R6 冲突分类 | INT-03 | unit + integration | D |
| R7 状态聚合 | WS-06, INT-01 | integration | A/E |
| R8 生命周期一致性 | LIFE-01 | integration | F |
| R9 边界场景 | COMPAT-01, WS-05, INT-05 | integration + manual | C/D |
| R10 控制/执行平面 | WS-01, WS-06 | integration | A |
| R11 任务级工作区 | WS-03 | unit + integration | B |
| R12 工作区时机 | WS-02, WS-04 | manual + integration | B |
| R13 集成模式交互 | INT-04, INT-06 | integration | D |
| R14 原生 worktree 接管 | WS-04 | integration | B |
| R15 工作流集成 | WORKFLOW-01 | manual | F |
| R16 主 checkout claim | WS-01, WS-05 | unit + integration | B |
| R17 provisional workspace | WS-02 | integration | B |
| R18 共享任务索引 | COORD-02 | unit + integration | A/E |
| R19 任务租约 | LEASE-01 | unit + integration | B/E |
| R20 coordinator 会话 | COORD-01 | integration + manual | E |
| R21 dispatch manifest | COORD-01 | unit + integration | E |
| R22 能力门控 | COORD-03 | unit + manual | 0/E |
| R23 提交归属 | INT-07 | integration | C |
| R24 监控/新任务/失败 | COORD-02, COORD-04 | integration | E |

## Acceptance Scenarios

以下场景是"可直接执行的验收脚本"。每条都给出 Given / When / Then、命令和期望；子代理实现后由当前会话逐条执行。

### PLAN-01 无重叠任务同批

- **Given** 三个 `in_progress` 任务，`touches` 分别为 `src/a/**`、`src/b/**`、`src/c/**`，无 `depends_on`。
- **When** `phronia task parallel plan --json`。
- **Then** 返回 1 个 wave，包含 3 个任务；每个任务 `reason` 为 `independent`。
- **失败判据**：wave 数 > 1，或任一任务缺失。

### PLAN-02 重叠任务拆批

- **Given** 两个任务都声明 `touches: ["src/shared/**"]`。
- **When** `phronia task parallel plan --explain`。
- **Then** 返回 2 个 wave；解释文本包含 `overlap: src/shared/**` 和两个 task ref。
- **失败判据**：同批，或解释缺少重叠路径。

### PLAN-03 未知足迹串行

- **Given** 一个任务没有 `touches`、`relatedFiles`、`package`。
- **When** `phronia task parallel plan --explain`。
- **Then** 该任务单独成批；解释包含 `unknown_footprint` 和 `phronia task footprint set` 提示。
- **失败判据**：与其他任务同批。

### PLAN-04 依赖环拒绝

- **Given** A `depends_on B`，B `depends_on A`。
- **When** `phronia task parallel plan`。
- **Then** exit != 0；错误包含环路径 `A -> B -> A`；不输出部分批次。
- **失败判据**：静默截断或输出不完整计划。

### WS-01 主 checkout 原子认领

- **Given** 干净主 checkout，无 claim；两个进程同时执行 `workspace prepare`。
- **When** 两个进程都尝试认领。
- **Then** 恰好一个得到 `reuse-current` 并持有 claim；另一个得到 `create` 并创建 worktree；不存在两者都 `reuse-current`。
- **失败判据**：两个进程都认为 main 空闲。

### WS-02 任务工件在 worktree 可见

- **Given** 任务目录未提交，主 checkout 只有该任务目录改动；main 被另一任务占用。
- **When** `workspace prepare --for-new-task "<title>"`，然后在返回的 worktree 内 `task create`。
- **Then** worktree 内存在 `.phronia/tasks/<ref>/prd.md`；主 checkout 没有被写入新任务目录；任务绑定到 provisional workspace。
- **失败判据**：worktree 内缺任务工件，或主 checkout 出现新任务目录。

### WS-03 同一任务两会话 attach

- **Given** 任务 A 已有 worktree。
- **When** 两个会话分别执行 `workspace ensure A`。
- **Then** 两者返回同一路径和 branch；不创建第二个 worktree；输出警告"共享工作区"。
- **失败判据**：创建第二个 worktree，或返回不同路径。

### WS-04 平台原生 worktree attach

- **Given** 平台已在 `/repo/.claude/worktrees/foo` 创建分支 `phronia/A`。
- **When** `phronia task worktree attach A --path /repo/.claude/worktrees/foo`。
- **Then** registry 登记 `kind=platform`；不创建新 worktree；`worktree list` 显示该路径。
- **失败判据**：重复创建，或分支不匹配仍登记。

### WS-05 stale claim 不抢

- **Given** claim owner 任务仍是 `in_progress`，心跳超过 TTL；主 checkout 干净。
- **When** 新会话 `workspace prepare`。
- **Then** 返回 `stale-owned`；新会话创建 worktree；不回收 claim；输出 `workspace reclaim` 的提示。
- **失败判据**：自动回收并复用 main。

### WS-06 跨会话任务可见

- **Given** 主 worktree 有任务 A；linked worktree 有任务 B（branch-local）。
- **When** 在主 worktree 执行 `phronia task parallel status --json`。
- **Then** 输出同时包含 A（`control-plane`）和 B（`branch-local`），B 带 `workspace` 路径和 `owner`。
- **失败判据**：只看到 A。

### LEASE-01 任务租约互斥

- **Given** 任务 A 无 lease。
- **When** 两个子代理同时 `task lease acquire A`。
- **Then** 恰好一个成功；另一个返回 `LEASE_BUSY`，包含 owner 和 workspace；数据库/文件中只有一个 lease。
- **失败判据**：两个都成功。

### INT-01 本地串行合入与结果验证

- **Given** 两个 worktree 任务 A/B，main 干净，验证命令记录执行目录。
- **When** 两个进程同时 `integrate A` / `integrate B`。
- **Then** 一个先合入；另一个入队或等待；验证只在 rebase 后的任务 worktree 内执行；最终 main 线性，包含 A 和 B。
- **失败判据**：交错写入、验证在旧 base 上执行、main 出现分叉。

### INT-02 验证失败不移动 base

- **Given** 任务 A rebase 成功，验证命令返回 1。
- **When** `integrate A`。
- **Then** main SHA 不变；outcome=`blocked`（reason=verify）；日志路径存在；worktree 保留。
- **失败判据**：main 前进，或状态写成 landed。

### INT-03 语义冲突 handoff

- **Given** A 已合入；B rebase 无文本冲突，但验证失败。
- **When** `integrate B --handoff`。
- **Then** outcome=`needs_human`；生成 `integration-handoff.md`，包含 base/head、失败命令、输出尾部、重叠任务、下一步 prompt；不自动改代码。
- **失败判据**：自动解决，或缺 handoff。

### INT-04 远端模式不合并

- **Given** 有 origin 和 mock `gh`。
- **When** `integrate A --mode remote`。
- **Then** push + 创建 PR；`pr_url` 写入；未调用任何 merge API；main 未被修改。
- **失败判据**：调用 merge，或修改 main。

### INT-05 崩溃恢复

- **Given** 在 `rebasing`、`verifying`、`merging` 三个阶段分别模拟进程被杀。
- **When** `integrate A --recover`。
- **Then** 每个阶段都恢复一致：要么重试，要么标记 landed，要么 `needs_human`；不出现半合入的 main。
- **失败判据**：main 处于未知状态，或锁永久占用。

### INT-06 模式确认只问一次

- **Given** `confirm=auto`，有 origin + mock `gh`，任务没有记录 mode。
- **When** 第一次 `integrate A`，选择 remote；第二次重试。
- **Then** 第一次输出一次询问和 `mode=remote (reason)`；第二次不再询问，直接使用记录的 mode。
- **失败判据**：每次重试都问。

### INT-07 提交归属

- **Given** 任务 A 使用 worktree，存在未提交改动。
- **When** 在 main 执行 `task commit A`，或在 worktree 执行 `integrate A`。
- **Then** main 上的 `task commit` 拒绝（`COMMIT_WRONG_WORKSPACE`）；worktree 内 `integrate` 拒绝 dirty；在 worktree 内 `task commit A` 成功后 `integrate` 通过。
- **失败判据**：在 main 替 worktree 任务提交，或 dirty 仍合入。

### COORD-01 dispatch manifest 不启动进程

- **Given** 支持 parallel + per-task workspace 的 mock harness；三个任务已 plan。
- **When** `phronia task parallel dispatch --batch b1 --json`。
- **Then** 输出三个条目，含 taskRef/workspace/branch/lease/promptPrefix；Phronia 进程列表中没有 agent 子进程；lease 已领取。
- **失败判据**：Phronia 启动了 agent，或 manifest 缺少 workspace/lease。

### COORD-02 新会话中途加入

- **Given** batch 正在跑任务 A/B；新会话创建任务 C，足迹与 A/B 不重叠。
- **When** orchestrator 重新 `parallel plan`。
- **Then** C 进入下一 wave，或在当前 wave 有空位时加入；C 的 task lease 成功；不等待 batch 结束。
- **失败判据**：C 被全局 batch 锁阻塞，或与 A/B 重叠仍并行。

### COORD-03 不支持平台降级

- **Given** 平台能力为 `subagentExecution=none` 或 `subagentWorkspace=inherited`（ZCode/Codex 属于后者）。
- **When** 执行 coordinator 命令。
- **Then** 明确返回 `COORDINATOR_UNSUPPORTED` 或降级为多会话/串行；输出原因和替代命令；不创建 batch。
- **失败判据**：静默 no-op，或假装支持。

### COORD-04 子代理失败隔离

- **Given** batch 中 A 的子代理失败，B/C 正常。
- **When** `parallel status --json`。
- **Then** A=`blocked`，B/C 继续；A 的 lease 可回收；orchestrator 可以重试 A 而不影响 B/C。
- **失败判据**：整个 batch 停止，或 A 永久占用 lease。

### LIFE-01 归档清理

- **Given** 任务 A 有 worktree，outcome=`landed`；任务 B 有 worktree，dirty。
- **When** 分别 archive A/B。
- **Then** A 的 worktree 被自动删除；B 的 archive 被拒绝并说明 dirty；registry 更新；`git worktree list` 无残留。
- **失败判据**：A 残留，或 B 被静默删除。

### COMPAT-01 无远端完整流程

- **Given** 无 origin 的本地仓库，两个独立任务。
- **When** plan → prepare → worktree → implement → commit → integrate --drain。
- **Then** 两个任务依次合入；main 线性；无网络访问；无残留 worktree；`git log --graph` 无分叉。
- **失败判据**：需要远端，或历史分叉。

### WORKFLOW-01 工作流集成

- **Given** 新会话无活动任务，已有 in-progress 任务 A。
- **When** 执行 `phronia-continue` 流程。
- **Then** 列出 active tasks；认领任务后调用 `workspace ensure`；breadcrumb 显示 workspace/integration 状态；不自动创建 worktree 除非确认。
- **失败判据**：SessionStart 静默创建/切换工作区。

## Non-Functional Acceptance

### 跨平台

- [ ] macOS、Linux 上 `open('wx')` 锁、unlink、路径解析通过。
- [ ] Windows 路径（盘符、反斜杠、长路径截断）有单测；锁文件关闭后再 unlink。
- [ ] 不依赖 POSIX-only 命令；所有外部命令用 `execFile`，不经 shell。

### 性能与资源

- [ ] `parallel plan` 100 个任务 < 1s（不含 git 读取）。
- [ ] `parallel status` 20 个 worktree < 2s。
- [ ] 锁获取/释放 < 100ms；心跳不阻塞主流程。
- [ ] 验证日志单文件上限（默认 10 MB），超出截断并保留尾部。
- [ ] `max_concurrent` 生效；worktree 数量可观测。

### 安全

- [ ] `handoff.md` 和日志不包含 token、环境变量值、完整私有 URL。
- [ ] 任务 ref / path 参数做路径穿越校验，拒绝 `..` 和仓库外路径（显式 `--path` 除外）。
- [ ] 远端 PR body 只包含任务标题/摘要，不包含环境或凭证。
- [ ] 不自动 push 到未授权远端；push 失败原样输出 stderr。

### 可观测性

- [ ] 所有命令 `--json` 输出稳定 schema；错误也返回 `{ok:false, code, message, next}`。
- [ ] 每个失败都有可执行的下一步命令。
- [ ] `doctor` 或 `parallel status` 能显示共享运行时路径、claim/lease 状态、能力门控结论。

### 兼容性

- [ ] 旧 `task.json` 无迁移；新数据只在 `meta`。
- [ ] 旧 `.phronia/.runtime/worktrees.json` 可读并迁移。
- [ ] `task worktree add` 的 `--base HEAD` 旧行为可用。
- [ ] `packages/core` 不新增运行时依赖。
