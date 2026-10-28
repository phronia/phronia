# 实施计划：并行执行准入控制

> 执行编排、阶段门禁和最终验收矩阵见 `acceptance.md`。本文件是实施清单；两者冲突时以 `acceptance.md` 的验收标准为准。

> 设计：`design.md`。规则表与错误码是契约，实施时不得改语义，只能改实现。
> 每个阶段结束都必须运行该阶段的验证命令；阶段之间可独立提交。

## 0. 准备

- [ ] 读 `.phronia/spec/cli/backend/parallel-tasks.md`、`workflow-state-contract.md`、`adapter-generations.md`、`trellis-core-sdk.md`。
- [ ] 读 `packages/core/src/context/subagent/index.ts`、`packages/cli/src/services/workspace.ts`、`packages/cli/src/templates/shared-hooks/phronia-hook.py`。
- [ ] 在 `bench/hook-bench.mjs` 记录当前 subagent-spawn / user-prompt 基线。
- [ ] 在 `packages/cli/test/commands/context-shim.integration.test.ts` 找到现有 fixture 的构造方式，复用而不是新造。

验证：

```bash
pnpm --filter @phronia/core test
pnpm bench:hooks
```

## 1. 领域层：`task/dispatch`

### 1.1 类型

- [ ] 新建 `packages/core/src/task/dispatch/types.ts`：
  - `AgentMutation`、`TaskFacts`、`ClaimFacts`、`LeaseFacts`、`DispatchFacts`、`DispatchVerdict`、`GuardBlock`。
  - `DispatchCode` 联合类型，值与 `design.md` §4.4 完全一致。
- [ ] 从 `packages/core/src/task/index.ts` 导出（确认 package.json subpath 已覆盖 `./task`）。

### 1.2 纯函数

- [ ] 新建 `packages/core/src/task/dispatch/policy.ts`：
  - `evaluateDispatch(facts): DispatchVerdict`。
  - 严格按 `design.md` §4.5 的顺序实现；用小的私有函数分段（`checkParent`、`checkStatus`、`checkCheckout`、`checkClaim`），不要一个巨型 if。
  - `next` 由私有函数生成，顺序稳定。
  - 不读文件、不跑进程、不打印。
- [ ] `requiresIsolation(facts)` 独立导出，便于测试和 planner 复用（如果 planner 需要）。

### 1.3 单测

- [ ] 新建 `packages/core/test/task/dispatch.test.ts`：
  - 表驱动：每个 `DispatchCode` 至少一个触发用例 + 一个相邻不触发用例。
  - 顺序测试：构造同时满足"父任务 + 未启动 + wrong checkout"的输入，断言只返回 `DISPATCH_PARENT_TASK`。
  - `enforce=warn/off` 的映射在 policy 内还是外层？**决定：policy 只返回事实判定（block/allow + code），enforce 的降级在 `guard.ts` 做**。单测锁死 policy 不感知 enforce。
- [ ] 覆盖 `research` 直接 allow。
- [ ] 覆盖 `factsReliable=false`。

验证：

```bash
pnpm --filter @phronia/core test -- dispatch
pnpm --filter @phronia/core typecheck
```

审查门：错误码与 design.md 一致；没有平台分支；没有 IO。

## 2. 事实层：`state/runtime-facts`

### 2.1 git 公共目录

- [ ] `packages/core/src/state/git.ts` 增加 `gitCommonDir(root, exec): string | null`，复用 `resolveCommonDir`。
- [ ] 不要给 `gitCommonDir` 加跨进程缓存；`mainWorktreeRoot` 的缓存保持不变。
- [ ] 单测用 fake `GitExec`：成功、非 git、相对路径、超时（status≠0）。

### 2.2 运行时读取

- [ ] 新建 `packages/core/src/state/runtime-facts.ts`：
  - `readRuntimeFacts({root, exec, io, now})`。
  - 读取 `workspace.claim.json`、`worktrees.json`、`leases/*.json`。
  - 校验 `schemaVersion`；未知版本 → 字段 null + 诊断。
  - 按 `realpath` 匹配 worktree → taskRef。
  - 返回 `diagnostics`，不抛异常。
- [ ] 在 `packages/core/src/state/index.ts` 导出。
- [ ] 单测 `packages/core/test/state/runtime-facts.test.ts`：空目录、损坏 JSON、未知 schemaVersion、stale claim、多个 lease。

### 2.3 成本

- [ ] 合并 git 调用：`rev-parse --git-common-dir` + `rev-parse --show-toplevel` + `branch --show-current`；不要额外调用 `worktree list` 除非 common dir 推导失败。
- [ ] 跑 `pnpm bench:hooks`，记录增量。

验证：

```bash
pnpm --filter @phronia/core test -- runtime-facts
pnpm typecheck
pnpm bench:hooks
```

审查门：只读；容错；没有 `process.cwd()`；路径全部走 `sharedRuntimePaths`。

## 3. 能力矩阵：`hookPolicy`

- [ ] `packages/core/src/platform/capabilities.ts`：
  - 增加 `HookPolicy` 和字段。
  - **仿照 `SUBAGENT_CAPABILITIES` 增加独立的 `HOOK_POLICY: Record<PlatformId, HookPolicy>`，在 `CAPABILITIES` 合并时注入**；不要把字段逐个写进 22 个 `BASE_CAPABILITIES` 条目。
  - 按 `design.md` §6.1 填表；未知平台 `unknown`。
  - `validateCapabilities` 增加检查：`hookPolicy` 缺失或值非法 → violation。
- [ ] `packages/cli/src/commands/doctor.ts` 与 `phronia platforms --json` 暴露该字段。
- [ ] 单测：每个 `PLATFORM_IDS` 都有值；`unknown` 的降级行为。

验证：

```bash
pnpm --filter @phronia/core test -- capabilities
pnpm --filter @phronia/cli test -- platforms doctor
```

## 4. 接入：`context/subagent`

### 4.1 事实映射

- [ ] 新建 `packages/core/src/context/subagent/facts.ts`：
  - `buildDispatchFacts({state, runtime, sessionActive, effectiveActive, requestedRef, agent, platform, config, sessionKey})`。
  - **分别解析会话指针与有效任务**（`active(input, {platform})` 与 `active(input, {platform, taskRef})`）；不要只用后者，否则 `DISPATCH_TASK_NOT_CHILD` 失去输入。
  - 读取有效任务的 `TaskFacts`。
  - 读取父任务的子任务状态（只读 `task.json`，限制为 direct children）。
  - 映射 claim/lease/worktrees/checkout。
- [ ] 明确 `checkout.root = request.projectRoot`；不要读 `process.cwd()`。

### 4.2 守卫渲染

- [ ] 新建 `packages/core/src/context/subagent/guard.ts`：
  - `applyEnforcement(verdict, {hookPolicy, enforce})` → `{mutation?: deny; guard?: GuardBlock}`。
  - `renderGuard(guard)` → 字符串。
  - `renderDenyReason(verdict)` → `reason + "\n" + next`。
  - 平台限制文案（ZCode 多会话、Codex 只能注入）在这里生成，不在 policy 里。

### 4.3 接入

- [ ] `buildSubagentSpawn`：
  - 先判断 `isDispatch`（`design.md` §7.2.1）：只有子代理派发事件才跑准入，`pre-tool-use` 无 tool name 且 payload 无 agent type 时保持现有行为。
  - 在 `agentType` 解析后、物化上下文前，执行判定。
  - deny → 返回 `{ mutations: [deny], blocks: [], envelope: "mutation-plan" }`，不物化 PRD。
  - allow + guard → 在最终 prompt 前拼接守卫块。
  - read-only/unknown → 保持现有路径。
  - 把 verdict 写入 `diagnostics`（`DISPATCH_OK` 可以是 info）。
- [ ] `context/types.ts` 增加 `deny` mutation。
- [ ] `context/index.ts` 的 `renderContext` 支持 deny（`mutation-plan` 与默认 envelope）。
- [ ] 确认 `contextOnly` 路径：OMP/Snow 只物化上下文、不改 prompt；deny 仍需生效（返回 deny mutation），guard 拼在 block 文本前。

### 4.4 集成测试

- [ ] `packages/cli/test/commands/context-shim.integration.test.ts` 增加 fixture：
  - 父任务 + 6 子任务 → deny。
  - 子任务 in_progress + 无 claim → allow + guard。
  - 子任务有 worktree + cwd=main → deny。
  - cwd=worktree A + active=B → deny。
  - main claim=A + active=B → deny。
  - research → allow。
- [ ] 断言 JSON 的 `mutations[0].op`、`code`、`next` 顺序。

验证：

```bash
pnpm --filter @phronia/cli test -- context-shim
pnpm --filter @phronia/core test -- subagent
```

审查门：deny 不走物化；guard 只出现一次；现有 allow 测试不回归。

## 5. Shim 渲染

### 5.1 Python shim

- [ ] `packages/cli/src/templates/shared-hooks/phronia-hook.py`：
  - `_render_mutation` 识别 `op == "deny"`。
  - ZCode / Claude / Cursor 形状按 `design.md` §6.3。
  - deny 时不输出 `updatedInput`。
  - Codex 路径（`_handle_codex_subagent_start`）不输出 deny；guard 已经在 `additionalContext` 里（core 返回 guard block）。
- [ ] 记住：`phronia hook` 的 `--event subagent-spawn` 走 `_render_mutation`，不走 `renderContext`。

### 5.2 JS shims

- [ ] `packages/cli/src/templates/opencode/adapters/v1/plugins/inject-subagent-context.js`：
  - 在 `mutation.op === "deny"` 时 `throw new Error(...)`。
  - 保留 catch 日志，但不要吞掉 deny（重新抛出）。
- [ ] 其它 JS shim（`_generated/shims/v1`/`v2`）**不要手改**；改源后运行：

  ```bash
  pnpm build:shims
  pnpm check:shims
  ```

- [ ] 如果 v2 shim 有独立源，逐个处理 deny；没有的保持原样并在文档注明。

### 5.3 测试

- [ ] 用 `node` spawn Python shim 的现有测试模式，断言 deny JSON 的字段。
- [ ] OpenCode shim 单测：构造 response，断言 throw。

验证：

```bash
pnpm build:shims
pnpm check:shims
pnpm --filter @phronia/cli test -- context-shim
```

审查门：deny 不携带 `updatedInput`；allow 行为不变；所有生成物一致。

## 6. Breadcrumb

- [ ] `buildUserPrompt` 增加 `runtime-state` 块（只在有活动任务时读取 facts）。
- [ ] `buildSessionStart` 的 `buildCurrentState` 增加四行。
- [ ] `bench/hook-bench.mjs` 增加 `user-prompt` 场景（当前只有 `session-start` 和 `subagent-context`）。
- [ ] 文案与 `design.md` §8.1 一致；读取失败显示 `unknown (read failed)`。
- [ ] 父任务时 `next` 固定提示。
- [ ] 更新 `packages/core/test/context/user-prompt.test.ts`、`session-start.test.ts`。
- [ ] 更新 `.phronia/spec/cli/backend/workflow-state-contract.md`。
- [ ] 跑 `pnpm bench:hooks`，确认 user-prompt 增量 ≤ 25ms。

验证：

```bash
pnpm --filter @phronia/core test -- user-prompt session-start
pnpm bench:hooks
```

## 7. Planner 容器语义

- [ ] `packages/core/src/task/parallel/types.ts` 增加 `container?`、`childCount?`。
- [ ] `planner.ts`：
  - 分波前过滤容器。
  - 诊断 `PARALLEL_CONTAINER_TASK`；显式 refs 时 `warn`，否则 `info`。
  - `--explain` 文案。
- [ ] `packages/cli/src/services/parallel.ts`：
  - `toPlannerTask` 设置 `container`/`childCount`。
  - `PARENT_HAS_PLANNING_CHILDREN` 诊断 + next 命令。
- [ ] 单测：容器不进入 wave；父子混合；`--refs parent`。
- [ ] 集成测试：`packages/cli/test/commands/parallel.integration.test.ts`。

验证：

```bash
pnpm --filter @phronia/core test -- parallel
pnpm --filter @phronia/cli test -- parallel
```

## 8. `task.py start` 门禁

- [ ] `.phronia/scripts/task.py`：
  - 新增 `--coordinator`。
  - `cmd_start` 在 `resolve_task_dir` 之后、context-manifest 检查之前读取 `task.json.children`。
  - 默认拒绝，打印子任务与命令。
  - `--coordinator` 跳过 context-manifest 检查。
- [ ] 同步模板：如果 `task.py` 有生成源（检查 `.phronia/scripts` 与 `packages/cli/src/templates` 的关系），必须同时更新，避免 `phronia update` 覆盖。
- [ ] 集成测试 `packages/cli/test/scripts/task-start-parent.integration.test.ts`：
  - 父任务默认失败，输出含 children；
  - `--coordinator` 成功且 pointer 写入；
  - 子任务成功；
  - 父任务 + `--coordinator` + 空 jsonl 成功。
- [ ] 更新 `workflow.md` 的 Phase 1.4 文案（父任务用 `--coordinator`）。

验证：

```bash
pnpm --filter @phronia/cli test -- task-start-parent
pnpm --filter @phronia/cli test -- task-archive
```

## 9. 会话身份桥

> 前置协调：`08-05-shell-ticket-bridge`（in_progress）正在泛化 ticket 桥。先读它的 PRD 与最终实现；本节是在它之上的扩展，不是并行重写。如果它已合入，直接扩展它的单一提取函数；如果尚未合入，先在任务里记录 rebase/合并计划，不要复制一份 matcher。

- [ ] `packages/core/src/context/pre-shell.ts` 的 `extractTaskSubcommands`：
  - 复用 `08-05-shell-ticket-bridge` 的单命令提取路径，识别 `phronia|trellis task workspace <verb> <ref>` 与 `task lease <verb> <ref>`。
  - ticket 的 `subcommands` 增加 `action` 字段（保持向后兼容：旧 ticket 没有 action 时按 name 匹配）。
- [ ] `packages/core/src/state/session/tickets.ts` 的 `pendingTicketMatchesArgs`：
  - 支持 `phronia`/`trellis` 可执行文件；
  - `task workspace|lease` 的 verb/ref 匹配；
  - 多候选仍然返回 null。
- [ ] `packages/cli/src/services/workspace.ts`、`lease.ts`：`openState` 传 `argv: process.argv.slice(2)`。
- [ ] `sessionUnknown` 错误增加可用 key 的扫描（只读 `.phronia/.runtime/sessions`，唯一匹配才给出）。
- [ ] 单测：tickets 匹配表（task.py / phronia workspace / phronia lease / 错误 verb / 双 ticket）。
- [ ] 集成测试：在 workspace 集成测试里写 ticket fixture，断言不传 `--session-key` 也能成功。
- [ ] 更新 `parallel-tasks.md` 的"会话身份"说明。

### 9.1 `workspace ensure` 复用 main（dogfood 缺陷）

- [ ] `decideWorkspace` / `ensureWorkspace`：当 `task.branch` 等于集成分支（`main`/`master`）且当前 checkout 是 main 时，先判定 `reuse-current`，不要进入 target-branch 冲突检查。
- [ ] 只有 `needsIsolation`（并行/always/exclusive）时才创建 worktree；此时 worktree 分支不能复用集成分支名，应使用 `phronia/<slug>`。
- [ ] 集成测试：`task.branch=main`、main 干净/无 claim → `reuse-current`；main 被其他任务占用 → `create` 且分支为 `phronia/<slug>`。
- [ ] 更新 `parallel-tasks.md` §4 的 ensure 语义。

验证：

```bash
pnpm --filter @phronia/core test -- tickets pre-shell
pnpm --filter @phronia/cli test -- workspace lease
```

## 10. 配置

- [ ] `config/readers.ts`：`ParallelConfig.dispatch.enforce`，默认 `block`，非法回落 + 诊断。
- [ ] `packages/core/test/state/config.test.ts` 增加用例。
- [ ] `phronia doctor`：`task.dispatchAdmission`，显示平台 `hookPolicy`、`enforce`、是否可阻断。
- [ ] `phronia platforms --json` 输出 `hookPolicy`。

验证：

```bash
pnpm --filter @phronia/core test -- config
pnpm --filter @phronia/cli test -- doctor platforms
```

## 11. 文档与技能

- [ ] `.phronia/spec/cli/backend/parallel-tasks.md` 新增 §11 "派发准入"：错误码表、判定顺序、能力降级、配置。
- [ ] `.phronia/spec/cli/backend/workflow-state-contract.md`：runtime-state 块。
- [ ] `docs/migrations/user-visible-changes.md`：deny、breadcrumb、start 门禁、`--coordinator`。
- [ ] `packages/cli/src/templates/common/skills/coordinator.md` 与 `.agents/skills/phronia-coordinator/SKILL.md`：
  - ZCode/Codex 的多会话四步；
  - 派发前检查清单与错误码对应；
  - 两份内容保持一致（有测试或 diff 检查）。
- [ ] `.phronia/workflow.md` 的 Phase 1.4 / Phase 2.1 文案。

验证：

```bash
pnpm check:layout
git diff --stat
```

## 12. 回归与验收

- [ ] `pnpm verify`。
- [ ] `pnpm bench:hooks`，记录 subagent-spawn / user-prompt 增量。
- [ ] 手工验收（`design.md` §16.4）：
  - ZCode deny 真实运行（复现方法见 §12.1）；
  - 父任务 → 子任务流程；
  - worktree 多会话；
  - Codex inject 分支。
- [ ] 用 bedrock 现场做一次只读复核（不修改仓库）：`parallel plan --explain`、`workspace ensure`、breadcrumb 输出。

### 12.1 ZCode deny 真实验收方法（已跑通一次，实施后复跑）

1. 建一个独立临时项目（不要在 Phronia 仓库里改 `.zcode/config.json`），加一个只对 token 生效的插件：

   ```text
   PreToolUse matcher: Agent|Task
   若 tool_input.prompt 含 ZCODE_DENY_PROBE:
     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"... Do not retry; report this exactly."}}
   否则 exit 0（不输出）
   ```

2. 用 ZCode 在该项目新建会话，发送："只调用一次 Agent（general-purpose），prompt 以 `ZCODE_DENY_PROBE` 开头"。
3. 在 `~/.zcode/cli/db/db.sqlite` 验证：
   ```sql
   -- 1) Agent 工具的状态是 error，error 文本是 deny reason
   select p.data from part p join message m on m.id=p.message_id
    where m.session_id='<probe-session>' and p.data like '%"tool":"Agent"%';
   -- 2) 没有任何子会话
   select count(*) from session where parent_id='<probe-session>';
   ```
4. 期望：`state.status=error`，子会话数 0，父模型不重试。

2026-10-28 首次结果：通过（ZCode 3.16.3 (8992, a82dd43e)）。注意 UI 会先画出子代理卡片，那不是子代理已运行的证据。

## 13. 提交与回退点

建议拆成 5 个提交，每个都可独立回退：

1. `feat(task): add dispatch admission policy` —— 纯函数 + 单测，无行为变化。
2. `feat(state): read workspace runtime facts` —— 只读事实 + breadcrumb，无阻断。
3. `feat(context): enforce dispatch admission in subagent spawn` —— 接入 + deny 渲染 + shim，行为变化点。
4. `fix(task): treat parent tasks as containers` —— planner + `task.py start`。
5. `fix(cli): resolve session identity for workspace commands` —— ticket 桥。

行为变化点（提交 3）上线策略：

- 直接默认 `block`，不做灰度（项目当前只有单一用户，出问题用 `parallel.dispatch.enforce: warn|off` 降级即可，不需要回滚代码）。
- 上线后跑一次 ZCode 真实验收（见下），确认 deny 仍然阻止派发。

## 14. 完成定义

- [ ] PRD 的 Acceptance Criteria 全部勾选。
- [ ] 设计文档中的错误码、判定顺序、能力表与实现一致（用一个测试或文档校验脚本锁死）。
- [ ] `parallel-tasks.md` 成为唯一权威契约，设计文档只保留决策与取舍。
- [ ] bedrock 的恢复路径不再需要"靠人记住不要并发"。
