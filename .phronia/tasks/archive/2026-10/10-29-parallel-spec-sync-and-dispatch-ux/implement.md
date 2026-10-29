# 实施计划：spec 后置同步、派发 UX 与 worktree 运维补齐

> 设计：`design.md`。每个阶段独立通过验证；S1 是行为变化点，最后单独做 e2e。
> 前置：2610.29.2 的派发准入已上线，不要改动 block 语义（只改 next 文案和新增能力）。

## 0. 准备

- [ ] 读 `.phronia/tasks/10-29-parallel-spec-sync-and-dispatch-ux/{prd,design}.md`。
- [ ] 读 `.phronia/spec/cli/backend/parallel-tasks.md`、`workflow-state-contract.md`、`filesystem-safety.md`、`trellis-core-sdk.md`。
- [ ] 读 2610.29.2 的实现：`task/parallel/planner.ts`、`task/integration/policy.ts`、`services/integrate.ts`、`services/workspace.ts`、`context/subagent/{facts,guard,index}.ts`、`.phronia/scripts/task.py`。
- [ ] 记录基线：`pnpm verify`。

## 1. S1：spec C 核心

### 1.1 任务工件与状态

- [ ] `packages/core/src/state/tasks/artifacts.ts`：增加 `specDelta` 检测（`spec-delta.md`）。
- [ ] `packages/core/src/task/spec/types.ts`：
  - `SpecDelta`（targetFiles、intent、rationale、verification）；
  - `SpecSyncState = "none" | "pending" | "synced" | "failed"`；
  - `SpecSyncResult`。
- [ ] `packages/core/src/task/spec/policy.ts`（纯函数）：
  - `parseSpecDelta(markdown)`：解析 `## Target files` 列表；
  - `validateTargets(delta, root)`：必须 `.phronia/spec/**`、repo-relative、无 `..`；
  - `canSync(task)`：outcome landed + delta 存在；
  - `verifyChangedTargets(targets, changedFiles)`：返回 missing/extra。
- [ ] `task.py` / `task_store.py`：
  - 任务创建时可选生成 `spec-delta.md` 模板（`--with-spec-delta` 或 `spec start` 子命令；不要给所有任务加空文件）。
  - archive 增加 spec-sync 门禁：有 `spec-delta.md` 且 `meta.spec_sync.status != synced` → 拒绝；`--skip-spec-sync` 显式跳过并写 reason。
- [ ] `finish-work` 顺序：integrate → spec plan → 主会话更新 → spec commit → archive。

### 1.2 spec sync 服务与命令

- [ ] `packages/cli/src/services/spec-sync.ts`：
  - `planSpecSync({refs, cwd, sessionKey})`：只读；校验 landed；输出 delta、landed diff 文件、target files、当前 spec sha。
  - `commitSpecSync({refs, cwd, sessionKey, allowMissing})`：
    - 获取 integration lock（复用 `services/integrate.ts` 的锁/队列）；
    - 校验 main clean、在 base branch；
    - 校验 target files 在 `.phronia/spec/**` 且确实有改动；
    - 只提交 `.phronia/spec/**`，消息 `chore(spec): sync <refs>`；
    - 写 `meta.spec_sync = {status:"synced", commit, synced_at, refs, mode:"agent"}`；
    - 释放锁。
  - `statusSpecSync({refs})`：读取状态。
- [ ] `packages/cli/src/commands/spec.ts` + `cli/index.ts` 注册：
  - `phronia task spec plan <refs...> [--json]`
  - `phronia task spec commit <refs...> [--json] [--allow-missing]`
  - `phronia task spec status [refs...] [--json]`
- [ ] 复用 integration lock：不要新建第二把锁；顺序保持 lease → claim → integration lock。
- [ ] 失败码：`SPEC_SYNC_NOT_LANDED`、`SPEC_SYNC_LOCK_BUSY`、`SPEC_SYNC_DIRTY_MAIN`、`SPEC_SYNC_TARGET_INVALID`、`SPEC_SYNC_NO_CHANGES`、`SPEC_SYNC_FAILED`；每个带 next。

### 1.3 integrate 门禁

- [ ] `packages/cli/src/services/integrate.ts`：在计算任务分支 diff 时检测 `.phronia/spec/**`。
  - 有 spec 改动且 `meta.kind != "spec"` → `SPEC_IN_CODE_TASK`。
  - next：`git restore --staged --worktree .phronia/spec`；写 `spec-delta.md`；重新提交。
  - 不提供 `--allow-spec-in-code`。
- [ ] spec-only 任务（`meta.kind=spec`）跳过该门禁；integrate 行为保持（或直接标记 landed，按设计 §4.6）。

### 1.4 planner

- [ ] `DEFAULT_ALWAYS_SERIAL` 移除 `.phronia/spec/**`（core + config 默认两处）。
- [ ] `planner.ts`：`meta.parallel.touches` 含 spec 路径 → `SPEC_IS_POST_INTEGRATION` warn；不串行。
- [ ] `meta.kind=spec` → `PARALLEL_SPEC_ONLY` info；不进 wave。
- [ ] `services/parallel.ts`：`--explain` 打印这两类诊断和 next。
- [ ] 测试：spec 不再 always-serial；spec-only 不进 wave；warn 文案。

### 1.5 可观测性

- [ ] `context/user-prompt.ts` / `session-start.ts`：`spec: none|pending|synced`。
- [ ] `phronia doctor` / `parallel status`：列出 pending/failed。
- [ ] 测试。

验证：

```bash
pnpm --filter @phronia/core test
pnpm --filter @phronia/cli test
pnpm --filter @phronia/core typecheck && pnpm --filter @phronia/cli typecheck
pnpm verify
```

审查门：spec sync 只在 main、只持 integration lock、只提交 spec 树；无 spec 改动不提交。

## 2. S2：archive branch + 派发 UX + launch plan

### 2.1 archive branch

- [ ] `.phronia/scripts/common/task_store.py`：
  - `resolve_task_branch(data, registry, repo_root)`：task.json.branch → registry entry branch → null。
  - `_validate_branch_metadata` 使用它。
  - branch 为空且 `meta.integration.outcome=landed` + `meta.integration.commit` 可从 base 到达 → 接受。
  - 远程模式 `pushed` 仍拒绝。
- [ ] 测试：worktree 存在/已删除/分支已删/无 remote/有 remote/未 landed。
- [ ] 不写回 `task.json.branch`。

### 2.2 派发 next

- [ ] `task/dispatch/policy.ts`：
  - `wrongCheckout` next：`open a new session/window in <worktree>`、`Active task: <ref>`、`cd` 仅作提示。
  - `checkTaskLineage` next：active/requested 关系、requested workspace、独立 session 指令、平台 coordinator 说明。
  - `DISPATCH_ISOLATION_REQUIRED` 增加"不要在 main session 并发 mutating 子代理"。
- [ ] tests：断言 next 顺序和包含字段。

### 2.3 launch plan

- [ ] `packages/cli/src/services/parallel.ts`：`launchPlan({refs|wave, prepare, cwd})`：
  - 读取 plan/refs；
  - 每个 mutating 任务：workspace（registry 或 ensure 结果）、branch、`Active task:`、平台 openInstructions、prepareCommand、inputs missing/next；
  - `--prepare` 才调用 `workspace ensure`；默认只读；
  - 不启动进程。
- [ ] `commands/parallel.ts` + CLI：`phronia task parallel launch [refs...] --wave <n> [--prepare] [--json]`。
- [ ] 平台文案：ZCode/Codex 新窗口；Claude Code 标注 coordinator capability（未实现）。
- [ ] tests：manifest 字段、不启动进程、缺 workspace 的 next。

验证：core/cli tests + `pnpm verify`；手工跑一次 launch（无 `--prepare`）确认无副作用。

## 3. S3：worktree 输入、ignored_inputs、依赖与构建

### 3.1 配置

- [ ] `state/config/readers.ts`：
  - `ParallelInput { path, mode: "symlink"|"copy" }`；`parallel.inputs`。
  - `parallel.integration.ignored_inputs: string[]`。
  - `parallel.build: { cargo_target_dir: "per-worktree"|"shared"; sccache: boolean }`。
  - 校验：repo-relative、无 `..`、mode 合法；非法回退 + 诊断。
- [ ] tests。

### 3.2 worktree 输入

- [ ] `services/workspace.ts`：
  - `applyWorktreeInputs`：symlink（相对路径、目标在 main 内）/copy；目标存在 skip；Windows symlink 失败降级 copy + warning。
  - 越界/绝对路径 → `WORKTREE_INPUT_FAILED`。
  - `worktree add` / `ensure` 都调用。
- [ ] 依赖检测：创建后检查 `parallel.inputs` 缺失；输出可执行 next。
- [ ] 清理大小：`removeWorktree` / archive 前 best-effort 计算并打印。
- [ ] tests：symlink/copy/越界/Windows fallback/缺失 next。

### 3.3 integrate ignored_inputs

- [ ] `services/integrate.ts` / `adapters/git.ts`：
  - 新增 `statusFiltered(cwd, ignoredInputs)`：从 `git status --porcelain` 剔除显式路径；
  - 额外校验：路径在 `ignored_inputs` 且（`git check-ignore` 或 symlink 目标在 repo 内）；
  - main 和 worktree 的 dirty check 都用它；
  - 不提供 blanket `--allow-untracked`。
- [ ] tests：显式 ignored symlink → clean；未声明 untracked → dirty；配置错误 → warning。

### 3.4 `worktree add` 与 ensure

- [ ] 抽出共享 `taskArtifactsVisible` / `assertTaskArtifacts`。
- [ ] `worktree add` main dirty 时：只有 `.phronia/tasks/<ref>` → 精确 scoped commit / `--copy-task` 指引；其他 → 拒绝。
- [ ] 增加 `--copy-task` 或指向 `workspace ensure --copy-task`。
- [ ] tests。

### 3.5 doctor

- [ ] `task.specSync`、`task.worktreeInputs`、`task.ignoredInputs`（只读）报告。
- [ ] 文档：build cache 建议、sccache、共享 target 的并发权衡。

验证：core/cli tests + `pnpm verify`；在临时仓库跑 symlink/ignored_inputs/清理大小。

## 4. S4：文档、技能、e2e、验收

### 4.1 文档/技能

- [ ] `.phronia/spec/cli/backend/parallel-tasks.md`：
  - spec 控制平面章节、spec-delta、spec plan/commit、integrate 门禁；
  - launch plan、inputs/ignored_inputs、archive branch 解析。
- [ ] `.phronia/workflow.md`：Phase 3.3 写 delta；finish-work spec sync。
- [ ] `phronia-implement` / `phronia-check` / `phronia-coordinator` / `phronia-finish-work` skills（模板 + dogfood）。
- [ ] `docs/migrations/user-visible-changes.md`。
- [ ] `parallel-tasks.md` 版本/兼容说明。

### 4.2 e2e（bedrock 风格）

在临时项目：

1. 父任务 + 三个子任务；代码 footprint 不重叠；各写 `spec-delta.md`。
2. `parallel plan` → 单 wave 三任务（spec 不再串行）。
3. 三个 worktree 并行实现；提交。
4. 串行 integrate W2 → W1 → W3；每个 integrate 后 `spec plan`。
5. 主会话按 plan 更新 spec；`spec commit` 三个 refs → 一个 `chore(spec)` 提交。
6. archive 三个任务；**不使用** `--skip-branch-validation`、`--skip-spec-sync`。
7. 断言 final spec 含三个 delta；无代码冲突；`pnpm verify`。

### 4.3 最终验收

- [ ] `pnpm verify` 全绿。
- [ ] 所有 PRD Acceptance Criteria 勾选。
- [ ] 2610.29.2 的派发准入/worktree/integrate 回归全绿。
- [ ] acceptance-report.md 记录命令、结果、未覆盖风险。
- [ ] task 归档；release 按项目流程（OMV bump → artifacts → tag → GitHub Release）。

## 5. 提交与回退

建议 4 个逻辑提交：

1. `feat(spec): post-integration spec sync` —— artifact、spec 命令、integrate gate、planner。
2. `fix(task): resolve archive branch from registry/integration` —— Python guard。
3. `feat(parallel): multi-session launch plan and dispatch next` —— launch + next 文案。
4. `feat(worktree): declarative inputs and ignored-input dirty check` —— inputs/ignored/依赖/构建/清理。

每个提交独立可回退；S1 的行为变化最大，回退时恢复 `.phronia/spec/**` always-serial 并移除 integrate gate。

## 6. 完成定义

- [ ] spec 不再出现在任务 footprint；planner 不再 blanket 串行 spec。
- [ ] 任务代码落地后，spec 由主会话在集成锁下串行 sync；未 sync 不得 archive。
- [ ] archive 不再需要 `--skip-branch-validation`（worktree 已 landed 的正常路径）。
- [ ] 派发 next 在 ZCode 上可直接执行：新开 session，而不是 `cd`。
- [ ] 主会话可用 `parallel launch` 编排多 session；不启动进程。
- [ ] gitignored 构建输入/依赖/缓存有显式配置和可执行提示；integrate 不做 blanket ignore。
- [ ] 全量测试与 e2e 通过。
