# Implement：任务内 fan-out lanes

> 前置：`prd.md` 与 `design.md` 已评审通过；`task.py start` 之后才能进入编码。
> 分支/工作区：遵循 `.phronia/workflow.md` 与 `parallel-tasks.md` 的隔离规则；本任务改动集中在 `packages/core`、`packages/cli` 与模板，不涉及 `.phronia/spec/**` 的直接提交（spec 走 Phase 3.3 的 `spec-delta.md`）。

## 0. 前置核查

- [ ] 确认没有在途任务同时编辑 `packages/core/src/task/dispatch/policy.ts`、`packages/core/src/context/subagent/*`、`packages/cli/src/templates/workflow/workflow.md`；如有，记录顺序约束到本节。
- [ ] 跑基线：`pnpm test:core`、`pnpm test:cli`，记录既有失败（预期为空）。
- [ ] 跑 `pnpm --filter @phronia/core typecheck` 与 `pnpm --filter @phronia/cli typecheck`，确认基线干净。

**回滚点 0**：本阶段无代码改动。

## 1. 领域层（纯策略）

新增 `packages/core/src/task/fanout/`：

- [ ] `types.ts`：`LaneSpec`、`FanoutPlan`、`FanoutFacts`、`FanoutVerdict`、`FanoutVerification`、`FANOUT_*` 码。
- [ ] `policy.ts`：`planFanout(task, maxLanes)`，按 design §3.1 的 first-match 顺序实现；写面重叠复用 `task/parallel/footprint.ts` 的 `normalizeFootprint` / `footprintOverlap`。
- [ ] `policy.ts`：`evaluateFanoutLane(facts)`，按 design §3.2 的表实现。
- [ ] `verify.ts`：`verifyFanout(plan, changedPaths)`，按 design §3.3 实现；不读文件系统。
- [ ] `index.ts` 导出；在 `packages/core/src/task/index.ts` 加再导出。
- [ ] 单测 `packages/core/test/task/fanout.test.ts`：每个 `FANOUT_*` 码至少一例；first-match 顺序；重叠路径与 lane id 出现在 details；`changedPaths` 的删除/新增/重命名边界。

**验证**：

```bash
pnpm --filter @phronia/core test -- task/fanout
pnpm --filter @phronia/core typecheck
pnpm --filter @phronia/core lint
```

**评审门 A**：纯函数签名与码表冻结。之后只允许增码，不允许改语义。

**回滚点 1**：删除 `task/fanout/` 与再导出即可，无数据迁移。

## 2. 事实层与准入

- [ ] `packages/core/src/context/subagent/facts.ts`：新增只读 `meta.fanout` 映射，把 `FanoutFacts` 放进 `DispatchFacts`；缺失时为 `null`。
- [ ] `packages/core/src/task/dispatch/types.ts`：`DispatchFacts` 增加 `fanout`；新增 `DispatchCode` 成员或独立 `FanoutCode`（与现有码族保持命名一致）。
- [ ] `packages/core/src/task/dispatch/policy.ts`：在 checkout 规则之后、lease 之前插入 fan-out 分支，调用 `evaluateFanoutLane`；保持 `evaluateDispatch` 仍是纯函数。
- [ ] 不修改现有规则的顺序与文案；仅在 `plan !== null` 时走新分支。
- [ ] 单测：`packages/core/test/task/dispatch.test.ts` 增加 allow / `FANOUT_LANE_REQUIRED` / `FANOUT_OPEN_CHECK` / `FANOUT_CLOSED` / `plan=null` 不变 五组。

**验证**：

```bash
pnpm --filter @phronia/core test -- task/dispatch task/coordinator
pnpm --filter @phronia/core typecheck
```

**评审门 B**：确认 `plan=null` 时所有既有断言逐字节不变（跑全量 core 测试）。

**回滚点 2**：撤销 `DispatchFacts.fanout` 与分支插入；`task/fanout/` 可保留但不再被调用。

## 3. 上下文解析与契约注入

- [ ] `packages/core/src/context/subagent/index.ts`：把 `readTaskRefFromPrompt` 扩展为 `readDispatchHeader(prompt)`，返回 `{ taskRef, laneId }`；保持"第一行必须是 `Active task:`、只扫首个头部块"的现有语义。
- [ ] `packages/core/src/context/subagent/prompts.ts`：新增 lane 契约段落渲染（design §7）；只在 `laneId !== null` 时追加。
- [ ] `buildSubagentSpawn` 把 lane 契约与现有 implement prompt 合并；deny 路径仍然只返回 deny 文本。
- [ ] 单测：合法 lane allow、缺 lane deny、无声明不变；解析器对空行/正文误写/大小写/BOM 的边界。

**验证**：

```bash
pnpm --filter @phronia/core test -- subagent
pnpm --filter @phronia/core typecheck
```

**评审门 C**：prompt 渲染结果快照评审（确认没有破坏四类角色语义）。

**回滚点 3**：撤销 `readDispatchHeader` 的 lane 字段与 prompt 段落；`evaluateFanoutLane` 保留但不注入契约。

## 4. CLI（应用层 + 命令层）

- [ ] `packages/cli/src/services/fanout.ts`：`planFanout`（读 task、调用领域层）、`verifyFanout`（GitPort `status` → 解析路径 → 领域层核对）。
- [ ] `packages/cli/src/commands/task.ts`（或新增 `fanout.ts` 并挂到 `task` 子命令）：`phronia task fanout plan <ref> --json`、`verify <ref> --json`、`close <ref>`；输出遵循 `{ok, code, message, next, details}`。
- [ ] `verify` 违例时退出码非零；`plan` 永远无副作用。
- [ ] 测试：临时仓库夹具上跑三类场景（合法、重叠、越界），断言 JSON 结构与退出码；命令层不写业务规则（规则全部在领域层）。

**验证**：

```bash
pnpm --filter @phronia/cli test -- fanout
pnpm --filter @phronia/cli typecheck
pnpm --filter @phronia/cli lint
```

**评审门 D**：CLI 输出与错误文案评审（`next` 必须可直接复制执行）。

**回滚点 4**：移除命令注册与 service；领域层不受影响。

## 5. 指导与规范

- [ ] `packages/cli/src/templates/workflow/workflow.md`：Phase 2.1 增加分叉（design §5 与 PRD R8）：声明 lane → `fanout plan` → 每 lane 派发 → `verify` → 全量 check → commit → `close`；未声明 → child task 多会话或串行；明确"任务内步骤不是车道"。
- [ ] `packages/cli/src/templates/common/skills/coordinator.md`：在 "Only one mutating agent per session" 段落补一句边界：fan-out lane 是同一任务内的写面单位，不是 sibling task，不得用 coordinator 的 sibling 路径派发。
- [ ] `packages/cli/src/templates/workflow/agents/implement.md`：补充 lane 契约（若模板中已有提交约束，则只加"按写面限定"与"报告文件"）。
- [ ] 用现有 configurator 安装入口刷新本仓库的部署文件（`.phronia/workflow.md`、`.agents/skills/phronia-coordinator/SKILL.md` 等），不要手改两份；刷新后 `git diff` 只应包含预期文案。
- [ ] 在任务目录写 `spec-delta.md`：给 `.phronia/spec/cli/backend/parallel-tasks.md` 增加 `12. Fan-out lanes` 一节（规范定义、码表、规则顺序、恢复语义）。
- [ ] 文档测试/快照：确认模板渲染测试通过；如仓库有部署文件一致性测试，加入 fanout 相关断言。

**验证**：

```bash
pnpm --filter @phronia/cli test -- templates configurators
pnpm --filter @phronia/cli typecheck
git diff --stat   # 部署文件 diff 仅限预期文案
```

**评审门 E**：文案评审——只放指针，不复制规范正文；所有命令名与现有 `phronia task` 子命令风格一致。

**回滚点 5**：文案改动单独可回滚，不影响机制。

## 6. 全量验证与交付

- [ ] `pnpm verify`（layout、typecheck、lint、build、test 全绿）。
- [ ] 手工端到端：在一个临时仓库里创建任务 → 声明两条 lane → `fanout plan` → 用真实 Agent 派发两条 → `verify` → 故意越界一次确认被检出 → `close` → `check` 恢复。
- [ ] 回归确认：未声明 `meta.fanout` 的任务，`buildSubagentSpawn` 输出与改动前一致（快照对比）。
- [ ] 写入 `spec-delta.md` 并在 Phase 3.3 由主会话应用到 `.phronia/spec/**`。

**定义完成（DoD）**：

- PRD 的 Acceptance Criteria 全部勾选；
- `pnpm verify` 通过；
- 部署文件与模板一致；
- 端到端手工场景通过；
- 没有新增共享运行期文件，没有迁移。

## 7. 顺序与依赖说明

- Phase 1 → 2 → 3 是严格顺序（类型 → 事实/准入 → 渲染）。
- Phase 4 依赖 Phase 1；Phase 5 依赖 Phase 4 的命令名。
- 如果团队希望先落"仅指导"版本：把 Phase 5 拆成独立变更，但此时文案只能描述"拆 child task / 串行"，**不得**提前写 `fanout` 命令，避免文档指向未发布的命令。
- 若任务执行期间有其它任务合入 `dispatch/policy.ts` 或 `subagent/index.ts`，先 rebase 并重跑评审门 B / C。
