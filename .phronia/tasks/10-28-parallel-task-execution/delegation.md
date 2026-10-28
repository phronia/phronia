# 子代理派发与最终验收计划

> 角色：**当前会话是验收负责人**，不直接实现业务代码；实现与检查由子代理按工作流完成。
> 目标：在不牺牲分层和长期可维护性的前提下，把大任务拆成文件所有权清晰、可独立验收的工作流。

## 0. 总原则

1. **一个工作流一个所有者。** 子代理只改自己拥有的文件；跨流文件由当前会话在集成时统一修改。
2. **先类型/契约，后实现。** W1 先落 core 类型和纯策略；W2/W3 依赖它，不反向定义。
3. **每个工作流必须有可执行验收。** 子代理提交前跑 targeted tests + lint + typecheck；当前会话跑全量 `pnpm verify` 和 PRD 验收场景。
4. **实现子代理不碰 git 历史。** 不 commit、不 push、不 rebase；由当前会话在集成点统一提交。
5. **检查子代理独立。** 每个工作流实现完成后，先由 check 子代理审查，再由当前会话验收。
6. **失败回派，不静默修。** 当前会话发现失败时，把失败的精确命令/输出回派给对应工作流；只有跨流集成胶水才由当前会话直接改。

## 1. 工作流总览

| 工作流 | 内容 | 拥有文件 | 依赖 | 可并行 |
|---|---|---|---|---|
| W0 | 能力验证（Phase 0） | `capability-report.md` | 无 | 与 W1 并行 |
| W1 | core 领域与纯策略 | `packages/core/src/task/{parallel,integration,workspace,index-*}/**` + 对应测试 | 无 | 与 W0 并行 |
| W2 | 共享运行时与适配器 | `packages/core/src/state/shared-runtime.ts`、`packages/core/src/state/config/readers.ts`、`packages/cli/src/adapters/**` + 测试 | W1 类型 | 否 |
| W3 | CLI 基础命令 | `packages/cli/src/commands/{parallel,worktree,lease}.ts`、`packages/cli/src/services/{parallel,workspace,lease}.ts` + 测试 | W1, W2 | 否 |
| W4 | 合入/远端/冲突 | `packages/cli/src/commands/{integrate,commit}.ts`、`packages/cli/src/services/integrate.ts` + 测试 | W3 | 否 |
| W5 | Coordinator | `packages/core/src/task/coordinator/**`、`packages/core/src/platform/{capabilities,features}.ts`、`packages/cli/src/commands/dispatch.ts`、`packages/cli/src/services/coordinator.ts` + 测试 | W0, W3, W4 | 否 |
| W6 | 工作流/技能/文档/归档 | `.phronia/workflow.md`、`.agents/skills/**`、`task_store.py` archive 守卫、`docs/**`、README | 全部 | 否 |

**跨流文件（当前会话统一修改）**：

- `packages/cli/src/cli/index.ts`（命令注册）
- `packages/core/src/task/index.ts`（导出）
- `package.json` / `packages/*/package.json`（子路径导出、脚本）
- `pnpm-lock.yaml`（如新增依赖）

## 2. 工作流详情

### W0：能力验证

**目标**：确认 harness 的并行子代理、每任务 cwd/worktree、显式 `task_ref`、嵌套子代理能力。

**产出**：

- `capability-report.md`：每个平台的 `supported|unknown|unsupported` + 证据 + 降级方案。
- 能力矩阵草稿（可直接粘贴到 `capabilities.ts` 的字段值）。

**验收**：

- 至少 3 个目标 harness（Claude Code、Codex、ZCode 优先）有真实运行证据。
- 每个 `supported` 至少一个正例 + 一个反例。
- 未验证的平台不得标 `supported`。
- 不支持平台有明确降级：多会话或串行。

**子代理类型**：research。不要改生产代码。

**Prompt 骨架**：

```
Active task: .phronia/tasks/10-28-parallel-task-execution
Role: research subagent for Phase 0 capability verification.

Verify on <harness>: parallel subagents, per-subagent cwd/worktree,
explicit task_ref forwarding, nested subagents, session identity.
Provide commands, outputs, version, and pass/fail evidence.
Do not modify production code. Write only capability-report.md and the matrix draft.
```

### W1：core 领域与纯策略

**目标**：所有不依赖 IO 的决策逻辑。

**文件**：

- `packages/core/src/task/parallel/{types,footprint,graph,planner}.ts`
- `packages/core/src/task/integration/{types,policy,queue}.ts`
- `packages/core/src/task/workspace/{types,policy}.ts`
- `packages/core/src/task/index-types.ts`、`index-policy.ts`
- 测试：`packages/core/test/task/{parallel,integration-policy,workspace-policy,index-policy}.test.ts`

**约束**：

- 无 IO、无打印、无 `process.exit`、无 `process.cwd()`。
- 所有输入是 plain data；所有输出是 plain data + `Diagnostic[]`。
- 覆盖 PRD 的 PLAN-01..04、WS-01..03、INT-02..03 的纯逻辑部分。
- 不实现 coordinator（W5）。

**验收**：

```bash
pnpm --filter @phronia/core test -- parallel integration-policy workspace-policy index-policy
pnpm --filter @phronia/core lint
pnpm --filter @phronia/core typecheck
```

**子代理类型**：implement → check。

**Prompt 骨架**：

```
Active task: .phronia/tasks/10-28-parallel-task-execution
Role: implement subagent for W1 (core domain).
Read design.md §5, §8, §18.1, §20.1-20.3, §24.
Own only the files listed for W1. Do not edit cli/** or cross-flow files.
Implement pure policies + unit tests. No IO, no printing.
Run the validation commands and report changed files, tests, and open questions.
```

### W2：共享运行时与适配器

**目标**：把 OS/git/forge 的脏活隔离在适配器里。

**文件**：

- `packages/core/src/state/shared-runtime.ts`
- `packages/core/src/state/config/readers.ts`（新增 `parallel` 视图）
- `packages/cli/src/adapters/{git,forge,lease,shared-runtime}.ts`
- 对应测试

**约束**：

- `GitPort`/`ForgePort`/`LeaseStore` 严格按 design §18.2。
- 所有外部命令用 `execFile`；超时按 §25.1；失败返回结构化结果。
- JSON 写入 temp+rename；锁用 `open('wx')`。
- `git-common-dir` 相对路径要 `path.resolve`。
- 旧 registry 迁移可读旧位置、写新位置。

**验收**：

```bash
pnpm --filter @phronia/cli test -- adapters
pnpm lint && pnpm typecheck
```

**子代理类型**：implement → check。

### W3：CLI 基础命令

**目标**：把 core 策略和适配器接到用户命令。

**文件**：

- `packages/cli/src/commands/{parallel,worktree,lease}.ts`
- `packages/cli/src/services/{parallel,workspace,lease}.ts`
- 对应测试

**约束**：

- 命令层只做参数/输出/退出码；业务在 services/core。
- `--json` 契约按 design §18.3。
- `workspace prepare` 的 claim 流程按 §4.6；`task lease` 按 §20.1。
- 不实现 integrate（W4）和 coordinator（W5）。
- 不改 `cli/index.ts`；把注册需求写给当前会话。

**验收**：

```bash
pnpm --filter @phronia/cli test -- parallel workspace lease worktree
pnpm lint && pnpm typecheck
```

**子代理类型**：implement → check。

### W4：合入、远端与冲突

**目标**：串行合入、提交归属、远端交接、冲突 handoff。

**文件**：

- `packages/cli/src/commands/{integrate,commit}.ts`
- `packages/cli/src/services/integrate.ts`
- 对应测试

**约束**：

- local integrate 的锁顺序：task lease → workspace claim → integration lock。
- 任务用 main 时跳过 rebase/ff；任务用 worktree 时先拿 main claim。
- 验证失败不移动 base；CAS 失败重试。
- remote 模式绝不调用 merge API；无 CLI 打印 compare URL。
- `task commit` 只在任务 worktree 内运行。
- 冲突分类不自动改写。

**验收**：

```bash
pnpm --filter @phronia/cli test -- integrate commit
pnpm lint && pnpm typecheck
```

覆盖 PRD 的 INT-01..07。

**子代理类型**：implement → check。

### W5：Coordinator

**目标**：单会话多任务、dispatch manifest、能力门控、监控/失败/新任务。

**文件**：

- `packages/core/src/task/coordinator/{types,policy}.ts`
- `packages/core/src/platform/{capabilities,features}.ts`（扩展）
- `packages/core/src/context/subagent/index.ts`（task_ref prompt fallback）
- `packages/cli/src/commands/dispatch.ts`
- `packages/cli/src/services/coordinator.ts`
- 对应测试

**约束**：

- 依赖 W0 的能力结论；未验证平台标 `unknown`，不得 `supported`。
- 平台范围按 W0：Claude Code 是 coordinator 候选（live 待跑）；ZCode/Codex 只能 multi-session；其余 unknown/不支持。
- 必须扩展 `readTaskRef` 解析 prompt 首行 `Active task:`，因为三款 Agent 工具都没有 `task_ref` 字段。
- `coordinator.mode` gate：至少 `parallel` + `per-task`；否则降级/拒绝。
- `dispatch` 只输出 manifest，不启动进程。
- 所有命令支持显式 `--task`；coordinator 模式禁止依赖环境指针。
- 新任务通过共享索引 + 重新 plan 进入下一 wave；不引入全局 batch 锁。
- 失败任务 blocked，其他继续；lease 可回收。

**验收**：

```bash
pnpm --filter @phronia/core test -- coordinator-policy
pnpm --filter @phronia/cli test -- coordinator dispatch lease
pnpm lint && pnpm typecheck
```

覆盖 PRD 的 COORD-01..04。

**子代理类型**：implement → check。

### W6：工作流、技能、文档、归档守卫

**目标**：让能力进入日常流程，并闭合生命周期。

**文件**：

- `.phronia/workflow.md`
- `.agents/skills/phronia-continue/SKILL.md`
- `.agents/skills/phronia-finish-work/SKILL.md`
- `.agents/skills/phronia-coordinator/SKILL.md`（新增）
- `.phronia/scripts/common/task_store.py`（archive 守卫 + docs 锁）
- `docs/migrations/user-visible-changes.md`
- `README.md` / docs-site 相关页
- `.phronia/spec/cli/backend/*`（新增契约文档）

**约束**：

- 先 integrate 再 archive；integrate 失败停止。
- archive 守卫：dirty 拒绝；clean+landed 自动清理；clean+未 landed 拒绝。
- `docs generate` 与 archive 共用共享锁。
- 文档必须解释：任务级隔离、共享运行时、integrate ≠ archive、本地锁作用域、coordinator 能力边界。
- 不恢复旧 `multi_agent` pipeline。

**验收**：

```bash
pnpm verify
python3 ./.phronia/scripts/task.py validate .phronia/tasks/10-28-parallel-task-execution
phronia docs generate --check
```

**子代理类型**：implement → check。

## 3. 派发顺序与集成点

```
Wave 1: W0 + W1        (并行；文件不重叠)
Gate 1:  W1 unit tests + W0 report
Wave 2: W2
Gate 2:  adapters tests
Wave 3: W3
Gate 3:  parallel/workspace/lease/worktree tests
Wave 4: W4
Gate 4:  integrate/commit tests + 无远端 e2e
Wave 5: W5
Gate 5:  coordinator tests + Phase 0 结论对照
Wave 6: W6
Gate 6:  pnpm verify + dogfood + acceptance scenarios
```

每个 Gate：

1. 实现子代理提交变更（不 commit）。
2. check 子代理审查 diff、跑 targeted tests、报告问题。
3. 当前会话审阅 diff + 跑 gate 命令；通过后由当前会话统一 commit。
4. 失败 → 回派给对应工作流，附精确命令/输出。

## 4. 当前会话的最终验收协议

### 4.1 前置

- 任务 `status=in_progress`，所有工作流已合入当前分支/worktree。
- `git status --porcelain` 干净。
- 没有残留的 task lease / integration lock；如有，先 `recover`/`release`。

### 4.2 静态与自动化

```bash
pnpm check:layout
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

如果改了 Python archive：

```bash
pnpm --filter @phronia/cli lint:py
```

### 4.3 执行 PRD 验收场景

逐条执行 `prd.md` 的 `Acceptance Scenarios`，记录：

- 场景 ID
- 命令
- 实际输出/退出码
- pass/fail
- 失败时的日志路径

必须全部 pass；无法自动化的 manual 场景（WORKFLOW-01、部分 Phase 0）由当前会话手工执行并记录证据。

### 4.4 Dogfood

1. **无远端**：在临时仓库跑 `plan → prepare → worktree → commit → integrate --drain`，确认 main 线性、无残留。
2. **远端 mock**：临时 bare origin + mock `gh`，确认 push/PR/compare URL、未调用 merge。
3. **平台原生 worktree**：用 Claude Code `--worktree` 或等价方式创建，再 `worktree attach`。
4. **Coordinator**：在 Phase 0 验证过的 harness 上，一个 orchestrator + 两个子代理 + 一个新会话中途加入；记录 manifest、lease、状态和最终合入。
5. **崩溃恢复**：在 `rebasing`/`verifying`/`merging` 各注入一次失败，跑 `integrate --recover`。

### 4.5 安全与卫生检查

```bash
git status --porcelain                     # 必须为空
git worktree list                          # 无测试残留
git log --graph --oneline -20              # 线性
grep -r "pr merge\|mr merge" packages      # 不应存在 merge API 调用
```

- 检查 `integration-handoff.md` / 日志无 token、环境变量、完整私有 URL。
- 检查 `task.json.worktree_path` 没有被新写入。
- 检查 no-remote 仓库没有网络访问。
- 检查 unknown footprint 任务没有并行。

### 4.6 验收报告

在任务目录写 `acceptance-report.md`：

```markdown
# Acceptance Report

- Task: <ref>
- Date / harness / OS:
- Commands run:
- Acceptance scenarios: X/Y pass (list failures)
- Dogfood: no-remote / remote-mock / native-worktree / coordinator / crash-recovery
- Safety checks:
- Open risks:
- Evidence paths:
```

只有全部通过才进入 `finish-work` / archive。

## 5. 失败回派格式

当前会话不直接修业务代码，按以下格式回派：

```
Workstream: W3
Failing command: pnpm --filter @phronia/cli test -- workspace
Expected: ...
Actual: ...
Repro: ...
Owned files: ...
Do not touch: ...
```

子代理修复后重新提交；当前会话重跑对应 gate，再继续。

## 6. 子代理提示模板

### 6.1 Implement

```
Active task: .phronia/tasks/10-28-parallel-task-execution
Role: implement subagent
Workstream: W<n> — <name>
Inputs: prd.md, design.md §<sections>, implement.md Phase <X>, delegation.md W<n>
Owned files: <list>
Do not edit: <cross-flow files + other workstreams>
Tasks:
  1. ...
Constraints:
  - Follow core/cli layering; no IO/printing in core.
  - Use explicit --task; no ambient active-task reliance.
  - Match the JSON contract.
Verification:
  - <commands>
Report:
  - changed files, tests run, results, open questions, risks.
Do not commit, push, rebase, or touch git history.
```

### 6.2 Check

```
Active task: .phronia/tasks/10-28-parallel-task-execution
Role: check subagent
Workstream: W<n>
Review the diff against prd.md acceptance + design.md contracts.
Run: <commands>
Check:
  - file ownership and layering
  - error codes/next steps
  - atomic writes/lock ordering
  - cross-platform assumptions
  - tests actually exercise the behavior (not tautological)
Report: findings by severity (blocker/warning/nit), with file:line and evidence.
Do not modify code unless explicitly asked.
```

### 6.3 Research (W0)

```
Active task: .phronia/tasks/10-28-parallel-task-execution
Role: research subagent
Verify on <harness>: parallel subagents, per-task cwd/worktree,
explicit task_ref forwarding, nested subagents, session identity.
Provide version, commands, outputs, positive/negative evidence.
Do not modify production code; write capability-report.md only.
```

## 7. 验收负责人检查清单

- [ ] 每个工作流的文件所有权没有重叠。
- [ ] 每个 gate 的 targeted tests 通过。
- [ ] `pnpm verify` 通过。
- [ ] PRD 验收场景逐条记录。
- [ ] Dogfood 四类（无远端/远端 mock/原生 worktree/coordinator）完成。
- [ ] 崩溃恢复矩阵至少覆盖 rebasing/verifying/merging。
- [ ] 无残留 worktree/lease/lock。
- [ ] 无 merge API 调用。
- [ ] 日志/handoff 脱敏。
- [ ] 能力矩阵没有未验证的 `supported`。
- [ ] 验收报告写入任务目录。
