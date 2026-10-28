# 实施计划 v3：并行任务执行 + 协调者编排

> 前置：`prd.md`、`design.md`、`research.md` 已评审通过；`task.py start` 后进入 Phase 2。
> v3 相对 v2 的变化：coordinator 纳入同一任务终态；新增 Phase 0 能力验证；共享任务索引与 task lease 从 Phase A/B 就落地；新增 Phase E coordinator 与 Phase F dogfood。
> **子代理分工、文件所有权和当前会话的最终验收协议见 `delegation.md`。当前会话不实现业务代码，只做集成、审阅和验收。**

## 0. 实施原则

1. **先验证、再设计落地。** Phase 0 先确认 harness 的真实能力，避免在"应该都支持"的假设上堆代码。
2. **先共享、再决策、后写入。** 先让所有 worktree 看到同一份运行时，再做工作区/租约决策，最后才允许合入。
3. **先只读、后变更。** `parallel plan/status` 不写仓库；`workspace prepare` 才可能创建 worktree；`integrate` 最后做。
4. **每个阶段独立可验证。** 阶段结束必须能跑完整测试，不依赖下一阶段。
5. **不改 task.json 必填字段。** 新数据在 `meta`；旧任务不迁移。
6. **失败显式。** 每个错误都有 `code`、`message`、`next`；不静默。
7. **纯策略先写单测。** planner、模式解析、冲突分类、工作区决策、capability gate 都是纯函数。
8. **coordinator 不引入第二套执行模型。** 复用任务、worktree、claim、lease、integrate；只增加索引、派发清单和能力门控。

## 1. 变更地图

| 文件 | 变更 |
|---|---|
| `packages/core/src/task/parallel/types.ts` | 新增：`TaskSnapshot` / `Footprint` / `Wave` / `Explain` |
| `packages/core/src/task/parallel/footprint.ts` | 新增：足迹规范化、重叠判定 |
| `packages/core/src/task/parallel/graph.ts` | 新增：依赖解析、环检测、level |
| `packages/core/src/task/parallel/planner.ts` | 新增：批次装箱、解释 |
| `packages/core/src/task/index-types.ts` | 新增：`TaskIndexEntry` / `TaskLease` 类型 |
| `packages/core/src/task/index-policy.ts` | 新增：索引重建、lease 过期、batch 状态（纯函数） |
| `packages/core/src/task/integration/types.ts` | 新增：`IntegrationMode` / `Outcome` / `ConflictKind` / `QueueEntry` |
| `packages/core/src/task/integration/policy.ts` | 新增：`resolveMode`、`classifyConflict` |
| `packages/core/src/task/integration/queue.ts` | 新增：队列排序/选择（纯函数） |
| `packages/core/src/task/workspace/types.ts` | 新增：`WorkspaceDecision` |
| `packages/core/src/task/workspace/policy.ts` | 新增：`decideWorkspace` |
| `packages/core/src/task/coordinator/types.ts` | 新增：`Batch` / `DispatchManifest` / `CoordinatorState` |
| `packages/core/src/task/coordinator/policy.ts` | 新增：capability gate、batch 状态、新任务调度 |
| `packages/core/src/task/index.ts` | 导出新模块 |
| `packages/core/src/state/shared-runtime.ts` | 新增：共享运行时路径类型/解析接口（不执行 git） |
| `packages/core/src/state/config/readers.ts` | 新增 `parallel` 配置视图与默认值 |
| `packages/core/src/platform/capabilities.ts` | 扩展 `subagentExecution` / `subagentWorkspace` / `subagentIdentity` |
| `packages/core/src/platform/features.ts` | 新增 `coordinator.mode` feature gate |
| `packages/cli/src/adapters/git.ts` | 新增：`GitPort` 的 execFile 实现 |
| `packages/cli/src/adapters/forge.ts` | 新增：gh/glab/generic 检测与调用、compare URL |
| `packages/cli/src/adapters/lease.ts` | 新增：O_EXCL 租约、心跳、stale（workspace claim + task lease 共用） |
| `packages/cli/src/adapters/shared-runtime.ts` | 新增：`git-common-dir` 解析、JSON 原子读写、registry 迁移 |
| `packages/cli/src/services/parallel.ts` | 新增：plan/status 聚合（跨 worktree + task index） |
| `packages/cli/src/services/workspace.ts` | 新增：prepare/ensure/attach/release/claim |
| `packages/cli/src/services/lease.ts` | 新增：task lease acquire/release/status |
| `packages/cli/src/services/integrate.ts` | 新增：local/remote/recover |
| `packages/cli/src/services/coordinator.ts` | 新增：batch/dispatch/monitor |
| `packages/cli/src/commands/parallel.ts` | 新增：`parallel plan/status/dispatch` |
| `packages/cli/src/commands/integrate.ts` | 新增：`integrate`（不提供 `land` 别名） |
| `packages/cli/src/commands/lease.ts` | 新增：`task lease acquire/release/status` |
| `packages/cli/src/commands/commit.ts` | 新增：`task commit <ref>`（只在任务 worktree 内提交） |
| `packages/cli/src/commands/worktree.ts` | 修改：base 解析、attach、copy/post_create、共享 registry；停止写 task.json.worktree_path/branch |
| `packages/cli/src/cli/index.ts` | 注册新命令与选项 |
| `packages/core/test/task/parallel.test.ts` | 新增：足迹/重叠/依赖/批次/解释 |
| `packages/core/test/task/index-policy.test.ts` | 新增：索引重建/lease 过期/batch 状态 |
| `packages/core/test/task/integration-policy.test.ts` | 新增：模式解析/冲突分类/队列排序 |
| `packages/core/test/task/workspace-policy.test.ts` | 新增：工作区决策矩阵 |
| `packages/core/test/task/coordinator-policy.test.ts` | 新增：capability gate/新任务调度 |
| `packages/cli/test/commands/parallel.integration.test.ts` | 新增：跨 worktree 的 plan/status |
| `packages/cli/test/commands/workspace.integration.test.ts` | 新增：prepare/ensure/attach/占用/确认/claim |
| `packages/cli/test/commands/lease.integration.test.ts` | 新增：并发领取/过期/释放 |
| `packages/cli/test/commands/integrate.integration.test.ts` | 新增：local/remote/conflict/race/recover/commit |
| `packages/cli/test/commands/coordinator.integration.test.ts` | 新增：batch/dispatch manifest/新任务加入/失败处理 |
| `packages/cli/test/commands/worktree.integration.test.ts` | 新增/扩展：base、attach、copy、registry 迁移 |
| `.phronia/scripts/common/task_store.py` | 修改：archive 守卫 + docs generate 共享锁 |
| `.phronia/workflow.md` | Phase 1/2/3 增加并行、workspace、integrate、coordinator 步骤 |
| `.agents/skills/phronia-continue/SKILL.md` | 认领任务后调用 `workspace ensure` |
| `.agents/skills/phronia-finish-work/SKILL.md` | 先 `integrate` 再 archive |
| `.agents/skills/phronia-coordinator/SKILL.md` | 新增：orchestrator 的规划/派发/监控/合入流程 |
| `docs/migrations/user-visible-changes.md` | 新增命令、行为变更、registry 迁移 |
| `README.md` / docs-site | 使用说明 |
| `.phronia/spec/cli/backend/*` | 共享运行时/锁/队列/租约/协调者契约 |

## 2. 阶段与检查点

### Phase 0：能力验证（只读研究）

**W0 已完成首轮（2026-10-28）**，见 `capability-report.md`。结论：Claude Code 是 coordinator 候选（schema+docs，live 待跑）；ZCode/Codex 只能 multi-session；三款 Agent 工具都没有 `task_ref` 字段，W5 必须扩展 `readTaskRef` 解析 prompt 首行 `Active task:`。

**目标**：确认 harness 的真实能力，避免 coordinator 建立在假设上。

步骤：

- [ ] 0.1 选至少 3 个目标 harness（Claude Code、Codex、ZCode 优先），逐一验证：
  - 是否支持并行子代理；
  - 每个子代理能否有独立 cwd/worktree；
  - 能否显式转发 `task_ref`（`hints.taskRef` / `input.task_ref` / `tool_input.taskRef`）；
  - 是否支持嵌套子代理；
  - 子代理是否有独立 session identity（没有时如何回退）；
  - 子代理能否执行 shell 并提交（或由父会话提交）。
- [ ] 0.2 把结果写入能力矩阵草稿（`subagentExecution` / `subagentWorkspace` / `subagentIdentity`），未验证的标 `unknown`，不得标 `supported`。
- [ ] 0.3 为不支持的平台定义降级路径：多会话（每任务一个会话）或串行子代理。
- [ ] 0.4 输出一页结论：哪些平台可以跑 coordinator、哪些只能跑多会话、哪些只能串行；对 Phase E 的范围影响。

验证：

- 结论文档 + 能力矩阵草稿；无生产代码改动。
- 至少一个真实 harness 上完成一次"父会话派发两个子代理到两个目录"的手工实验。

退出标准：

- 每个目标 harness 都有明确的 `supported|unknown|unsupported` 和证据（命令/截图/日志）。
- 不支持的平台有可执行的降级方案。

**Review gate 0**：禁止把"文档说支持"当成"验证通过"；必须有真实运行证据。Phase 0 的结论若推翻 coordinator 假设，回到 design 修订，不进入 E。

### Phase A：共享运行时 + 任务索引 + 纯 planner

**目标**：所有 worktree 看到同一份运行时；orchestrator 能看到跨会话任务；能回答"哪些任务可以并行"。

步骤：

- [ ] A1 `shared-runtime.ts`：用 `git rev-parse --git-common-dir` 解析 `<common>/phronia/`；提供 `integration.lock`、`integration.json`、`worktrees.json`、`workspace.claim.json`、`tasks.index.json`、`leases/`、`logs` 的路径。`--git-common-dir` 可能返回相对路径，需 `path.resolve(cwd, ...)`。失败时回退到主 worktree `.phronia/.runtime` 并打印 warning。
- [ ] A2 registry 迁移：读旧 `.phronia/.runtime/worktrees.json`，合并到共享位置；写只写新位置；可由 `git worktree list --porcelain` 重建。
- [ ] A3 `TaskIndexEntry` + `TaskSnapshot`：从 task.json 读取 `meta.parallel` / `meta.integration` / `relatedFiles` / `package` / `priority`；索引可由主 worktree + 各 worktree 的 task.json 重建。
- [ ] A4 `footprint.ts`：`normalizeFootprint` + `overlap`；单测覆盖 10 种组合。
- [ ] A5 `graph.ts`：`depends_on` 解析、缺失引用报错、环检测、level。
- [ ] A6 `planner.ts`：同 level 贪心装箱、`max_concurrent`、unknown/exclusive/always-serial 单独成批、`explain`。
- [ ] A7 `parallel plan`：默认读主 worktree + 共享索引；`--include-planning`；`--json`；`--explain`；无并行任务时输出原因和建议命令。
- [ ] A8 `parallel status`：聚合主 worktree + 共享索引 + 各 worktree 的 task.json；区分 `control-plane` / `branch-local`；显示 worktree、ahead/behind、outcome、队列位置、owner。
- [ ] A9 配置读取：`parallel.*` 默认值，未知值 warn + 回退。

验证：

```bash
pnpm --filter @phronia/core test -- parallel index-policy
pnpm --filter @phronia/cli test -- parallel
pnpm lint && pnpm typecheck
```

退出标准：

- 3 个互不重叠任务 → 1 个 wave；重叠 → 2 个 wave；unknown → 单独成批；环 → 明确错误。
- 从 linked worktree 运行 `parallel status` 能看到主 worktree 的任务；从主 worktree 能看到 branch-local 任务。
- 无仓库写入（`git status --porcelain` 验证）。

**Review gate A**：planner 无 IO/打印/退出；共享运行时解析在 linked worktree、普通仓库、`.git` 为文件时都正确；索引可重建且不丢条目。

### Phase B：workspace claim + task lease + 工作区

**目标**：任务级工作区决策、原子认领、任务去重、平台原生 worktree 接管。

步骤：

- [ ] B1 `workspace/policy.ts`：`decideWorkspace` 决策矩阵（reuse-current / attach / create / refuse）。纯函数，单测覆盖全部条件。
- [ ] B2 `workspace prepare`：原子 `tryClaim`；成功 → reuse-main；busy → create/attach；`stale-dirty` → 不回收、改开 worktree。创建任务后在同一 claim 上把 owner 从 session 改为 task。
- [ ] B3 当前 checkout 占用者判定：共享 registry 中 `path == cwd` 且 taskRef 不同的活动任务；或当前分支属于另一任务。
- [ ] B4 任务工件可见性：创建 worktree 前检查 `.phronia/tasks/<ref>` 是否已在集成分支；未提交且只有该任务目录改动 → 询问后 scoped commit；未提交且有其他改动 → 拒绝或 `--copy-task`。
- [ ] B5 停止写 `task.json.worktree_path` / `branch`：worktree 创建/删除只更新共享 registry；旧字段只读兜底。
- [ ] B6 `workspace ensure`：attach 已有 worktree；同一任务两个会话返回同一路径；平台原生 worktree 用 `attach`。
- [ ] B7 `worktree add` base 解析：`--base` → `task.base_branch` → `origin/HEAD` → 当前分支（仅当等于集成分支）。`--base HEAD` 保留旧行为。
- [ ] B8 `worktree add` 预检：分支已在其他 worktree 检出、目标路径存在、主 checkout dirty（`--force` 可绕过）、detached/bare/shallow。
- [ ] B9 `worktree attach`：校验路径是 git worktree、分支与任务匹配（或 `--branch` 指定）、登记为 `kind=platform`。
- [ ] B10 `copy` / `post_create`：配置与命令行；缺失文件跳过并记录 info；失败保留现场并输出修复命令。
- [ ] B11 会话警告：`.phronia/.runtime/sessions` 中有指向该 worktree 的会话时打印 warning。
- [ ] B12 位置策略：`parallel.worktree.dir/location/cleanup`；默认 `.phronia/worktrees/<task-id>` 持久化；`ephemeral` 必须显式开启并输出重启丢数据警告。
- [ ] B13 路径长度：目录名截断到 60 字符 + 短哈希；完整 ref 存 registry；Windows 路径测试。
- [ ] B14 `worktree prune [--dry-run] [--older-than]`：只删除已归档/已合入且干净的 worktree；永不删 dirty/未合入/未推送；清理 `git worktree prune` 元数据。
- [ ] B15 task lease：`leases/<task>.json` 用 `O_EXCL` 原子获取；记录 ownerType/ownerId/sessionKey/workspace/heartbeat/ttl；release 显式释放；stale 可回收。
- [ ] B16 provisional workspace：`prepare --for-new-task` 在 main 被占时从集成分支建 `phronia/wip/<short>`，registry `taskRef:null, provisional:true`；`task create` 检测并绑定；可选重命名分支；TTL 后 prune。
- [ ] B17 stale 判定：TTL、owner task 已归档、同 host session 文件缺失（辅助）；stale + owner 仍 planning/in_progress 默认不回收；stale + 脏永不回收；无 claim + 脏默认 worktree。

验证：

```bash
pnpm --filter @phronia/core test -- workspace
pnpm --filter @phronia/cli test -- workspace lease worktree
pnpm lint && pnpm typecheck
```

集成测试矩阵：

| 用例 | 期望 |
|---|---|
| 无其他任务 + 干净 checkout | `reuse-current` |
| 任务已有 worktree | `attach`，路径一致 |
| 任务工件未提交 | 询问后 scoped commit；worktree 内存在 `.phronia/tasks/<ref>` |
| 创建 worktree 后主 checkout | 保持 clean（不再写 task.json.worktree_path） |
| 当前 checkout 被任务 A 占用，任务 B prepare | `create` + 确认；base 是集成分支而非 A |
| 同一任务两个会话 ensure | 同一路径，不创建第二个 |
| 平台原生 worktree + attach | 登记成功；分支不匹配拒绝 |
| 分支已被其他 worktree 检出 | refuse，给出路径 |
| 主 checkout dirty | refuse；`--force` 才 reuse |
| copy/post_create 失败 | worktree 保留，错误含下一步 |
| 默认位置 | `.phronia/worktrees/<task-id>`，仓库重启/重开仍在 |
| `ephemeral` | 使用 tmp，输出丢数据警告 |
| `prune` 遇到 dirty/未合入/未推送 | 拒绝删除并说明原因 |
| 超长 slug | 目录名截断 + 哈希，路径长度可控 |
| 两个会话同时 `prepare` | 一个拿到 main（`O_EXCL` 成功），另一个得到 `busy` 并建 worktree |
| main 被占 + 新任务无工件 | 建 provisional worktree；`task create` 后绑定，不向 main 写任务目录 |
| stale claim + main 干净 + owner 仍 in_progress | `stale-owned`，不自动回收 |
| stale claim + main 脏 | 不回收，返回 `stale-dirty`，新会话用 worktree |
| 任务创建后 | claim owner 从 session 改为 task，不出现第二个 claim |
| 两个子代理同时领取同一任务 | 只有一个 task lease 成功 |

退出标准：所有用例通过；`workspace prepare --json` 和 task lease 是稳定契约。

**Review gate B**：检查"会话中途无法切换 cwd"是否如实说明；attach 不误登记普通目录；claim/lease 的 stale 规则不抢别人的工作；Windows 路径。

### Phase C：共享锁/队列 + 本地合入 + 提交

**目标**：跨 worktree 严格串行、可回滚、可恢复；worktree 任务有明确提交归属。

步骤：

- [ ] C1 `lease.ts`：`open('wx')` 获取、内容写入、心跳、释放（关闭后 unlink）、stale 判定（同 host PID + TTL）。workspace claim 和 integration lock 共用同一实现。
- [ ] C2 共享 `integration.json`：队列 enqueue/remove/peek、原子 temp+rename；队列只保存等待条目。
- [ ] C3 `integrate --dry-run`：解析模式、锁状态、将执行的 git 命令、验证命令；不写入。
- [ ] C4 local 主流程：前置检查 → 获取 main claim + integration lock（固定顺序）→ fetch → preLandSha → rebase → verify → CAS → ff → 写 outcome → 释放。
- [ ] C5 任务本身用 main：跳过 rebase/ff，只验证 + 写 outcome + 释放 claim。
- [ ] C6 任务用 worktree 且 main 被占：等待、失败并提示 remote，或先结束占用任务；不抢 main。
- [ ] C7 `--queue` / `--wait` / `--drain`：忙时入队；drain 循环处理；wait 超时返回位置。
- [ ] C8 `--recover`：按 phase + git 状态判定；`--rollback` 显式回退。
- [ ] C9 验证执行：按序、超时、日志到主 worktree `.phronia/.runtime/integration-logs/`；无配置时强制 `--no-verify`。
- [ ] C10 `task commit <ref>`：只在任务 worktree 内运行；确认 worktree 路径与 registry 一致；`git add -A` + commit；禁止在 main 替 worktree 任务提交。
- [ ] C11 错误路径：dirty 主 checkout、dirty worktree、detached、bare、shallow、空仓库、base 移动、ff 失败。
- [ ] C12 跨 worktree 并发测试：两个进程从不同 worktree 同时 integrate，只有一个拿到锁。
- [ ] C13 claim 被占的错误文案：列出占用任务、worktree 路径、建议（先 finish 对方 / 用 remote / `--wait`）。

验证：

```bash
pnpm --filter @phronia/core test -- integration-policy
pnpm --filter @phronia/cli test -- integrate
pnpm lint && pnpm typecheck
```

集成测试矩阵（临时仓库 + linked worktree）：

| 用例 | 期望 |
|---|---|
| 任务 A 正常合入 | base 前进；outcome=landed；历史线性 |
| 验证失败 | base 不动；outcome=blocked；日志存在 |
| rebase 冲突 | base 不动；outcome=blocked；冲突分类 |
| 两个 worktree 并发 integrate | 一个成功；另一个入队/失败；无交错 |
| 合入中 base 移动 | 重试；成功或 blocked |
| 合入后状态写入失败 | recover 补齐 |
| 主 checkout 脏 | 拒绝 |
| 无验证命令且无 `--no-verify` | 拒绝 |
| 任务用 main 时 integrate | 只验证 + 写 outcome，不做 rebase/ff |
| 任务用 worktree 且 main 被占 | local integrate 等待或失败并提示 remote；不抢 main |
| 锁顺序 | claim → integration lock；并发场景无死锁 |
| worktree 未提交就 integrate | 拒绝；`task commit` 后成功 |

退出标准：所有用例通过；失败路径下 `git reflog` 显示 base 未被改写；锁无泄漏。

**Review gate C**：锁位置（共享运行时）、原子性、崩溃恢复、错误文案；禁止任何"失败但 base 已被改写"的路径；确认 `task commit` 不会在 main 上运行。

### Phase D：远端合入与冲突治理

**目标**：有远端时正确交接；冲突有分类和 handoff。

步骤：

- [ ] D1 `forge.ts`：origin URL 解析、gh/glab 可用性、create/view、compare URL；所有调用超时 3s。
- [ ] D2 remote：push、create PR/MR、记录 `pr_url`、outcome=pushed；已存在复用；无 CLI 打印 compare URL。
- [ ] D3 `--sync`：fetch + `merge-base --is-ancestor`；有 CLI 查询状态；失败降级 `unknown`。
- [ ] D4 模式解析与确认：`resolveMode` + `confirm` 策略；每次输出 `mode=... (reason)`；提示包含后果；选择写回 `meta.integration.mode`。
- [ ] D5 任务用 main 时拒绝 remote：没有独立分支；提示改用 local 或在新工作区开始。
- [ ] D6 冲突分类器：generated / duplicate / needs_human / mechanical / semantic / race。
- [ ] D7 `--handoff`：写主 worktree `.phronia/.runtime/integration-handoff.md`；包含任务/base/head/分类/冲突文件/验证输出/重叠任务/下一步 prompt。
- [ ] D8 生成物冲突：abort → regenerate → 重试；仍冲突 → needs_human。
- [ ] D9 远端模式禁止本地 rebase；检测已推送分支并警告。

验证：

```bash
pnpm --filter @phronia/core test -- integration-policy
pnpm --filter @phronia/cli test -- integrate
pnpm lint && pnpm typecheck
```

集成测试矩阵（临时裸仓库作为 origin）：

| 用例 | 期望 |
|---|---|
| 无 origin + `--mode remote` | 明确失败，提示 local |
| 有 origin 无 gh | push 成功；outcome=pushed；打印 compare URL |
| 有 gh（mock） | PR URL 写入；未调用 merge |
| 远端已合并 + `--sync` | outcome=landed |
| add/add 冲突 | duplicate；不覆盖 |
| clean rebase + verify 失败 | semantic；handoff 文件存在 |
| 锁文件冲突 | generated；regenerate 后重试 |
| 模式确认 auto/always/never | 只在预期场景询问一次 |
| 任务用 main + remote | 拒绝，提示 local/新工作区 |

退出标准：远端模式不修改 `main`；冲突分类可预测；handoff 足以让人/agent 继续。

**Review gate D**：不调用 merge API；PR body 不含敏感信息；分类不把语义冲突误判为机械冲突；确认交互只问一次。

### Phase E：Coordinator 模式

**目标**：单会话多任务编排；新会话可中途加入；能力门控与降级明确。

步骤：

- [ ] E1 扩展 `PlatformCapabilities`：`subagentExecution` / `subagentWorkspace` / `subagentIdentity`；`features.ts` 新增 `coordinator.mode` gate。
- [ ] E2 coordinator 会话模型：`mode: coordinator`，活动任务指针为空，batch id 存在会话 runtime；breadcrumb 显示 batch 状态。
- [ ] E3 所有任务命令接受显式 `--task <ref>`；coordinator 模式禁止依赖环境指针。
- [ ] E4 `parallel dispatch --batch <id> --json`：输出 taskRef/workspace/branch/lease/dependsOn/promptPrefix；Phronia 不启动任何进程。
- [ ] E5 task lease 与 workspace prepare 合并为原子步骤；派发前领取，失败则跳过并报告。
- [ ] E6 监控：`parallel status --json` 聚合 batch（queued/running/blocked/landed）；lease 心跳与 stale 回收。
- [ ] E7 失败处理：子代理失败 → task blocked；其他任务继续；orchestrator 可重试或 re-plan。
- [ ] E8 新会话中途加入：创建任务 → 登记索引 → 重新 plan → 下一 wave 或当前可用空位；足迹重叠则等待；无全局 batch 锁。
- [ ] E9 合入协调：orchestrator 不占 main；批量结束 `integrate --drain`；或整批 remote；如果占用 main，integrate 前释放。
- [ ] E10 降级：`subagentExecution < parallel` 或 `subagentWorkspace != per-task` 时，coordinator 明确拒绝或降级为多会话/串行；不静默 no-op。
- [ ] E11 新增 `phronia-coordinator` skill：读取积压目录、分析耦合/优先级、创建任务、plan、prepare、dispatch、monitor、integrate。

验证：

```bash
pnpm --filter @phronia/core test -- coordinator-policy
pnpm --filter @phronia/cli test -- coordinator lease
pnpm lint && pnpm typecheck
```

集成测试矩阵：

| 用例 | 期望 |
|---|---|
| 不支持并行子代理的平台 | coordinator 命令明确拒绝/降级，说明原因 |
| 支持 parallel + per-task 的平台（mock harness） | dispatch manifest 含 workspace/lease/promptPrefix |
| 两个子代理领取同一任务 | 只有一个 lease 成功 |
| 子代理失败 | 任务 blocked；其他任务继续；lease 可回收 |
| 新会话中途加入不重叠任务 | 进入下一 wave 或当前空位 |
| 新会话中途加入重叠任务 | 等待，不与运行中任务并行 |
| orchestrator 占 main | local integrate 等待/失败；提示释放或 remote |
| 整批完成 | `integrate --drain` 串行合入，历史线性 |

退出标准：coordinator 不再依赖"所有 harness 都支持子代理"的假设；每个平台有明确的支持/降级结论。

**Review gate E**：Phase 0 结论与实现一致；没有静默降级；dispatch 不启动进程；lease/claim/lock 三个互斥不混淆；新任务不会与运行中任务重叠。

### Phase F：工作流/技能、归档守卫、文档与 dogfood

**目标**：能力进入日常流程，生命周期闭环，coordinator 在真实积压上跑通。

步骤：

- [ ] F1 `task_store.py` archive 守卫：dirty 拒绝；clean+landed 自动 remove；clean+未 landed 拒绝。
- [ ] F2 archive + `docs generate` 持有共享锁（或至少串行化），避免并发写投影。
- [ ] F3 `phronia-finish-work`：先 integrate 再 archive；失败停止。
- [ ] F4 `phronia-continue`：无活动任务时列出 active tasks；有任务时 ensure workspace。
- [ ] F5 per-turn breadcrumb：加入 workspace / integration / coordinator batch 状态（只读）。
- [ ] F6 `workflow.md`：Phase 1 可选 `parallel plan`；Phase 1.4 prepare workspace；Phase 3 integrate；coordinator 作为可选模式。
- [ ] F7 文档：README、migration note（命令、base 变更、registry 迁移、共享运行时、coordinator 能力门控）、docs-site。
- [ ] F8 spec：共享运行时/锁/队列/租约/冲突/coordinator 契约；命令契约。
- [ ] F9 dogfood：两个互不重叠任务，plan → prepare → 两个 worktree → integrate → archive；确认 main 线性、registry 正确、无残留。
- [ ] F10 coordinator dogfood：在 bedrock 类积压目录上，一个 orchestrator 规划 3 个任务、派发子代理、聚合状态、串行合入；记录哪些 harness 能力不足。
- [ ] F11 `phronia docs generate` 更新 `docs/requirements.md`。

验证：

```bash
pnpm verify
python3 ./.phronia/scripts/task.py validate .phronia/tasks/10-28-parallel-task-execution
phronia docs generate --check
```

手工验收：

```bash
phronia task parallel plan --explain
phronia task parallel status --json
phronia task workspace prepare <ref> --json
phronia task lease status <ref> --json
phronia task parallel dispatch --batch <id> --json
phronia task integrate <ref> --dry-run
```

退出标准：

- 跨 worktree 的 status 能看到所有任务；
- 归档 dirty worktree 被拒绝；
- dogfood 后 `git log --graph --oneline` 线性；
- coordinator dogfood 至少在一个 harness 上完成，其他平台有降级结论；
- `docs generate --check` 通过。

**Review gate F**：文档解释"任务级隔离""共享运行时""integrate ≠ archive""本地锁只在同仓对象库内有效""coordinator 的能力边界"；spec 与实现一致。

## 3. 测试策略

### 3.1 单元测试（core）

- `parallel.test.ts`：足迹来源、重叠矩阵、依赖解析、环、批次、max_concurrent、exclusive、always-serial、解释。
- `index-policy.test.ts`：索引重建、lease 过期、batch 状态、新任务调度。
- `integration-policy.test.ts`：模式解析优先级、confirm 策略、冲突分类矩阵、队列排序。
- `workspace-policy.test.ts`：决策矩阵（已有 worktree、占用、并行批次、exclusive、dirty、目标冲突）。
- `coordinator-policy.test.ts`：capability gate、batch 状态、新任务加入。
- `shared-runtime` 路径解析：普通仓库、linked worktree、`.git` 为文件、非 git 目录。

### 3.2 集成测试（cli）

用 `mktemp` 创建临时仓库 + `git worktree add` 创建 linked worktree。覆盖：

- 跨 worktree 的 plan/status；
- workspace prepare/ensure/attach/占用/确认/claim；
- task lease 并发、过期、释放；
- local integrate 的并发、冲突、验证失败、race、recover、commit；
- remote integrate 的 push/PR/compare URL/sync；
- coordinator dispatch manifest、新任务加入、失败处理、降级；
- registry 迁移；
- archive 守卫。

### 3.3 交互测试

对 `--yes` / `--interactive` / `confirm=auto|always|never` 做快照测试：

- 无远端：不问，直接 local；
- 有远端 + 两模式可行：问一次；
- 已有任务 mode：不问；
- `--yes`：不问；
- `--interactive`：总是问。

### 3.4 手工验收

- 在本仓库或 bedrock 类项目上跑双任务并行；
- 故意制造语义冲突，确认 handoff 可读；
- 断网跑 local；
- 平台原生 worktree（Claude Code `--worktree`）→ attach；
- coordinator：一个 orchestrator + 两个子代理 + 新会话中途加入；
- Windows 锁与路径（如有 CI/虚拟机）。

## 4. 验证命令

每个阶段：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

最终：

```bash
pnpm verify
python3 ./.phronia/scripts/task.py validate .phronia/tasks/10-28-parallel-task-execution
phronia docs generate --check
```

Python 改动：

```bash
pnpm --filter @phronia/cli lint:py
```

## 5. Review Gates

| Gate | 关注点 | 不通过则 |
|---|---|---|
| 0 | 真实 harness 证据；不做"文档说支持"的假设 | 回到 design 修订，不进入 A |
| A | planner 纯函数、共享运行时解析正确、索引可重建 | 回到 A |
| B | 任务级决策、attach 校验、claim/lease stale 安全 | 回到 B |
| C | 锁在共享运行时、原子性、崩溃恢复、claim→lock 顺序 | 停止 D |
| D | 不调用 merge API、确认只问一次、分类不误判 | 关闭 remote 默认 |
| E | Phase 0 结论一致、无静默降级、dispatch 不启进程 | 回退 coordinator 开关 |
| F | workflow/skill 一致、dogfood、无残留 | 不归档任务 |

## 6. 回滚点

| 阶段 | 回滚动作 | 数据影响 |
|---|---|---|
| 0 | 删除结论草稿 | 无 |
| A | 删除 `parallel` 命令与 core 模块；registry 保留在共享位置 | 无 |
| B | 删除 `workspace prepare/ensure/attach` 和 lease；恢复 `worktree add` 旧 base | 已创建 worktree 保留 |
| C | `parallel.enabled: false`；停止 integrate | 已合入提交保留；队列可删 |
| D | 强制 `mode: local`；关闭 confirm | 已推送分支/PR 保留 |
| E | `parallel.coordinator.enabled: false` | batch/lease 文件可删 |
| F | 技能/文档回滚；archive 守卫改 warning | 无 |

共享 registry 迁移是单向的，但旧位置仍可读；回滚时保留两份即可。

## 7. 风险检查点

- [ ] Phase 0 有真实运行证据，未验证的能力没有标 supported。
- [ ] 从 linked worktree 运行时，锁确实在 `<git-common-dir>/phronia/`，两个进程互斥。
- [ ] `parallel status` 在主 worktree 能看到 branch-local 任务和 coordinator batch。
- [ ] `workspace prepare` 不会在会话中途假装切换 cwd。
- [ ] 同一任务的两个会话得到同一路径；两个子代理不会同时领取同一任务。
- [ ] 创建 worktree 后主 checkout 保持 clean，且 worktree 内能找到 `.phronia/tasks/<ref>`。
- [ ] `task.json.worktree_path` 没有被新写入；registry 是唯一运行时映射。
- [ ] 失败路径下 `main` 从未被改写（`git reflog`）。
- [ ] 锁/租约在进程异常退出后能被 stale 判定清理。
- [ ] 远端模式没有调用任何 merge API。
- [ ] `handoff.md` 不含 token/环境变量/完整私有 URL。
- [ ] unknown footprint 的任务没有被并行。
- [ ] `docs/requirements.md` 的并发写入被共享锁串行化。
- [ ] `confirm=auto` 只在预期场景询问，不重复打扰。
- [ ] coordinator 不启动 agent 进程；dispatch 只输出 manifest。
- [ ] 新会话中途加入的任务不会与运行中任务足迹重叠。

## 8. Definition of Done

- [ ] PRD 的 Must Have R1–R24 全部有实现与测试。
- [ ] 验收标准逐条可复现。
- [ ] Phase 0 结论文档化，能力矩阵有证据。
- [ ] `pnpm verify` 通过。
- [ ] 无远端 dogfood + 有远端（或 mock）+ 平台原生 worktree attach 各验证一次。
- [ ] coordinator dogfood 至少在一个 harness 上完成；其他平台有降级结论。
- [ ] 文档、migration note、spec 更新完成。
- [ ] 任务归档时无残留 worktree、无未合入分支（或已显式保留并说明）。

## 9. 后续可选项（不属于 R1–R24）

- 投机验证（N2）：在锁外提前跑验证，减少排队时间。
- backlog 导入：`phronia task import <dir>` 把问题目录批量转成任务。
- worktree 磁盘占用展示：`worktree list --disk`。
- 跨机器协调：仍交给远端 merge queue，不在本地实现分布式锁。

这些不阻塞终态；先保证 R1–R24 和 dogfood 通过。

## 10. 子代理派发与最终验收

完整分工见 `delegation.md`。摘要：

- **W0（能力验证）与 W1（core 领域）可并行**；W2 → W3 → W4 → W5 → W6 按 gate 串行。
- 每个工作流：implement 子代理 → check 子代理 → 当前会话审阅并统一 commit。
- 子代理只改自己拥有的文件；`cli/index.ts`、`core/task/index.ts`、`package.json` 导出由当前会话统一修改。
- 每个 gate 由当前会话跑 targeted tests + lint + typecheck；失败按 `delegation.md` §5 回派，不静默修业务代码。
- 最终验收由当前会话执行：
  1. `pnpm verify`；
  2. PRD `Acceptance Scenarios` 逐条；
  3. dogfood：无远端 / 远端 mock / 原生 worktree / coordinator / 崩溃恢复；
  4. 安全与卫生检查；
  5. 写 `acceptance-report.md`。
- 只有全部通过才进入 `finish-work` / archive。
