# 最终验收标准与执行编排

> 本文件是 `implement.md` 的验收摘要，也是子代理和当前会话的共同验收口径。
> 规则：**任何一项未通过，不得进入下一阶段；阶段 5 未通过，不得提交。**

## 0. 全局门禁

| 门禁 | 命令 | 通过标准 |
|---|---|---|
| 基线 | `git status --short` | 只允许任务目录未跟踪；无源码改动 |
| 类型 | `pnpm typecheck` | 0 error |
| 测试 | `pnpm test` | 全绿 |
| Lint | `pnpm lint` | 0 error |
| Shim 一致性 | `pnpm check:shims` | 通过 |
| Layout | `pnpm check:layout` | 通过 |
| 全量 | `pnpm verify` | 通过（阶段 5 必跑） |

## 1. 执行编排（串行，禁止同 checkout 并发写）

| 阶段 | 子代理任务 | 主要文件 | 当前会话动作 |
|---|---|---|---|
| S0 | 无（baseline） | — | 跑基线，记录 `pnpm test` 结果 |
| S1 | core 决策层 + 事实层 + 能力维度 + breadcrumb | `packages/core/src/task/dispatch/**`、`state/runtime-facts.ts`、`state/git.ts`、`platform/capabilities.ts`、`context/user-prompt.ts`、`context/session-start.ts`、对应 tests | 审 diff + 跑 S1 验收 |
| S2 | context 接入 + deny 渲染 + shims + 配置字段 | `context/subagent/**`、`context/types.ts`、`context/index.ts`、`state/config/readers.ts`（仅 `parallel.dispatch.enforce`）、`templates/shared-hooks/phronia-hook.py`、`templates/opencode/**`、`_generated/shims/**`、tests | 审 diff + 跑 S2 验收 |
| S3 | planner 容器 + `task.py` 门禁 + session key + doctor/docs | `task/parallel/**`、`services/parallel.ts`、`services/workspace.ts`、`services/lease.ts`、`state/session/tickets.ts`、`context/pre-shell.ts`、`.phronia/scripts/task.py`、`commands/doctor.ts`、spec/docs/skills | 审 diff + 跑 S3 验收 |
| S4 | 无（当前会话） | — | 新建测试项目，端到端验证自动准入 |
| S5 | 无（当前会话） | — | `pnpm verify` + bench + acceptance-report + commit |

子代理规则：

- 每次只派发一个；上一阶段验收通过后才派发下一个。
- 子代理 prompt 首行必须是 `Active task: .phronia/tasks/10-28-parallel-dispatch-admission`。
- 子代理只改本阶段文件；发现需要越界，先报告，不擅自改。
- 子代理不得 `git commit`、不得改 `.phronia/tasks/**`（除自己的进度记录）。
- 当前会话负责最终质量：不直接写实现代码，只写验收结论和必要的返工指令。

## 2. S1 验收：core 决策层与事实层

| # | 检查 | 命令/方法 | 通过标准 |
|---|---|---|---|
| S1-1 | 判定纯函数 | `pnpm --filter @phronia/core test -- dispatch` | 每个 `DISPATCH_*` 码至少 1 正 1 反；顺序表驱动通过 |
| S1-2 | 事实读取容错 | `pnpm --filter @phronia/core test -- runtime-facts` | 缺失/损坏/未知版本/非 git 都返回诊断，不抛 |
| S1-3 | 能力矩阵完整 | `pnpm --filter @phronia/core test -- capabilities` | 每个平台都有 `hookPolicy`；ZCode=`block` |
| S1-4 | breadcrumb 事实 | `pnpm --filter @phronia/core test -- user-prompt session-start` | 含 `workspace/claim/lease/parallel`；父任务含 children |
| S1-5 | 无平台分支 | `git diff` 人工审 | core 里没有 `if (platform === ...)` |
| S1-6 | 成本 | `pnpm bench:hooks` + `readRuntimeFacts` 微基准 | 标准 checkout + 无 claim = 0 次 git 进程；中位数 ≤10ms；user-prompt ≤25ms |
| S1-7 | 快路径正确性 | 单测 | `.git` 目录/`gitdir:`+`commondir`/detached HEAD 都不 spawn git；非常规布局只 spawn 1 次 rev-parse |
| S1-8 | dirty 门控 | 单测 | 无 claim 不跑 status 且 `factsReliable=true`；有 claim + status 失败 → `factsReliable=false` |

## 3. S2 验收：派发接入与平台渲染

| # | 检查 | 命令/方法 | 通过标准 |
|---|---|---|---|
| S2-1 | 父任务 deny | `pnpm --filter @phronia/cli test -- context-shim` | `mutations[0].op=deny`，code=`DISPATCH_PARENT_TASK` |
| S2-2 | 未启动 deny | 同上 | code=`DISPATCH_TASK_NOT_IN_PROGRESS` |
| S2-3 | 无 claim 守卫 | 同上 | allow + `WORKSPACE_GUARD` 块，含 `workspace ensure` |
| S2-4 | 错误 checkout deny | 同上 | code=`DISPATCH_WRONG_CHECKOUT` |
| S2-5 | 跨任务 deny | 同上 | code=`DISPATCH_TASK_NOT_CHILD` |
| S2-6 | research 放行 | 同上 | allow，无 deny |
| S2-7 | Python shim deny | 同上（spawn python） | ZCode/Claude 输出 `permissionDecision:"deny"` + reason；无 `updatedInput` |
| S2-8 | Codex inject | 同上 | 不输出 deny；`additionalContext` 含 `WORKSPACE_GUARD`，首行 `STOP:` |
| S2-9 | OpenCode throw | 同上 | `tool.execute.before` 抛错 |
| S2-10 | 生成的 shim 一致 | `pnpm build:shims && pnpm check:shims` | 无 diff |

## 4. S3 验收：规划/启动/身份/配置/文档

| # | 检查 | 命令/方法 | 通过标准 |
|---|---|---|---|
| S3-1 | planner 容器 | `pnpm --filter @phronia/core test -- parallel` | 父任务不入 wave；`--explain` 输出 `container` |
| S3-2 | 父任务提示 | `node packages/cli/bin/phronia.js task parallel plan --include-planning --explain` | 父任务不出现为 wave 成员；输出 `container (children: N)` |
| S3-3 | `task.py start` 父任务 | `python3 ./.phronia/scripts/task.py start .phronia/tasks/<parent>` | 默认失败并列出 children；`--coordinator` 成功；子任务正常 |
| S3-4 | session key | `pnpm --filter @phronia/cli test -- workspace lease` | ticket fixture 下无 `--session-key` 成功；双 ticket 降级并提示 |
| S3-5 | 配置 | `pnpm --filter @phronia/core test -- config` | 非法 `enforce` 回落 `block`；doctor 显示 |
| S3-6 | 文档 | 人工审 | `parallel-tasks.md` 新增准入章节；workflow-state 文档；user-visible-changes |
| S3-7 | skill 同步 | `diff` 模板与 dogfood | 内容一致 |
| S3-8 | ensure 复用 main | `pnpm --filter @phronia/cli test -- workspace` | `task.branch=main` 时 `ensure` 返回 `reuse-current`，不创建 worktree |

## 5. S4 验收：端到端自动准入（必须真实运行）

测试项目：`/Users/magicdian/Documents/personal_project/aaa-phronia-admission-e2e`（临时，验收后删除）。

前置：ZCode 的 hook 通过全局 `phronia` 调用 CLI。e2e 期间必须让全局命令指向本仓库的新构建：

```bash
pnpm build
ln -sf /Users/magicdian/Documents/personal_project/phronia/packages/cli/bin/phronia.js /opt/homebrew/bin/phronia
phronia --version   # 确认是本仓库构建
# 验收结束后恢复：
ln -sf ../lib/node_modules/@phronia/cli/bin/phronia.js /opt/homebrew/bin/phronia
```

不要把这一步写进发布脚本；它只是本机 e2e 的临时环境准备。

### 5.1 场景 A：父任务实现派发被自动拒绝

1. 在测试项目创建父任务 + 2 个子任务（子任务保持 `planning`）。
2. `task.py start <parent> --coordinator`。
3. 在 ZCode 测试会话中要求派发 `phronia-implement`。
4. 期望：Agent 工具 `state.status=error`，reason 含 `DISPATCH_PARENT_TASK`，无子会话，模型不重试。

### 5.2 场景 B：子任务未启动被拒绝

1. `task.py start <child>` 之前派发。
2. 期望：`DISPATCH_TASK_NOT_IN_PROGRESS`。

### 5.3 场景 C：正常子任务放行且带守卫

1. `task.py start <child>`；没有 claim。
2. 派发 `phronia-implement`。
3. 期望：allow；子代理 prompt 顶部有 `WORKSPACE_GUARD`，含 `claim: none` 和 `workspace ensure`。

### 5.4 场景 D：workspace ensure 后无守卫

1. 在 ZCode shell 执行 `phronia task workspace ensure <child>`（不传 `--session-key`）。
2. 期望：成功；再派发时无 `DISPATCH_NO_CLAIM`。

### 5.5 场景 E：worktree 隔离

1. 让两个子任务都 `in_progress`，其中一个 `workspace ensure` 创建 worktree。
2. 在 main 派发该子任务。
3. 期望：`DISPATCH_WRONG_CHECKOUT` 或 `DISPATCH_ISOLATION_REQUIRED`；在 worktree 窗口派发则放行。

### 5.6 场景 F：Codex 降级

1. 用 Codex（若可用）对同一父任务派发。
2. 期望：不 deny；子代理上下文首行 `STOP:`。

### 5.7 场景 G：research 不受限

1. 在父任务/planning 子任务下派发 `phronia-research`。
2. 期望：allow。

## 6. S5 验收：最终质量

- [ ] `pnpm verify` 全绿。
- [ ] `pnpm bench:hooks` 增量达标。
- [ ] 端到端 A–G 全部有记录（命令、结果、证据路径）。
- [ ] `acceptance-report.md` 写明每项结论与未覆盖风险。
- [ ] task 状态 `completed`，归档前确认无残留测试项目。
- [ ] 变更提交：5 个逻辑提交（policy/facts/context/planner+start/session-key+docs）。

## 7. 最终验收标注（Definition of Done）

只有同时满足以下 6 条，任务才算完成：

1. **可证明的违规被阻断**：父任务、未启动、错误 checkout、main 被其他任务认领、隔离要求未满足——全部 deny，且有单测/集成测试。
2. **不可证明的归属被显式暴露**：无 claim/lease 冲突/平台不能阻断——allow + guard，guard 含可执行 next。
3. **平台能力真实生效**：ZCode 3.16.3 实测 deny 阻止派发（无子会话）；Codex 走 inject；OpenCode throw；未知平台 fail-closed。
4. **可观测**：每轮 breadcrumb 显示 workspace/claim/lease/parallel；父任务显示 children 统计。
5. **不破坏常规路径**：单任务、干净 main、无 claim 仍然 allow；`parallel.enabled: false`、`worktree: never` 都有明确降级。
6. **可回退**：`parallel.dispatch.enforce: warn|off` 可即时降级；不新增数据格式；不引入守护进程。

## 8. 回退点

| 阶段 | 回退 |
|---|---|
| S1 | 删除 `task/dispatch/**`、`state/runtime-facts.ts` 与相关导出 |
| S2 | 移除 `deny` mutation 与 shim 渲染；恢复 `buildSubagentSpawn` |
| S3 | 分别 revert planner、`task.py`、ticket、config、docs |
| S4 | 删除临时测试项目；不影响源码 |
| S5 | `parallel.dispatch.enforce: warn|off`；必要时 revert 提交 |
