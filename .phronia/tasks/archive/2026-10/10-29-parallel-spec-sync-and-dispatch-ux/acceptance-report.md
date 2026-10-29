# 验收报告：spec 后置同步、派发 UX 与 worktree 运维（S4）

> 结论：**通过（PASS）**。S1–S3 的运行时实现；S4 补齐规格文档、工作流/技能与 CI e2e；S3 随后补齐了 R10 的 doctor/parallel status 可见性。`pnpm verify` 全绿，模板与 dogfood 无结构性漂移。
>
> 未在本阶段执行：真实 ZCode 多会话窗口 UI 操作、真实 Codex 会话、端口/DB/Docker 运行时隔离、共享 Cargo target 的性能基准。这些是明确的范围外或人工步骤，见 §5。

## 1. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-10-29 |
| 仓库 | `/Users/magicdian/Documents/personal_project/phronia`（main checkout） |
| 版本 | 2610.29.2（本地源码，未发版/未打 tag） |
| Node / pnpm | 仓库锁定 `pnpm@10.32.1` |
| Python | `python3`（archive / spec-sync e2e 使用仓库模板脚本） |
| 变更范围 | S4：docs / skills / tests；无运行时语义修改 |

## 2. 全量门禁

```text
pnpm verify → exit 0
- check:layout / typecheck / check:layout-json / check:shims / lint / build: pass
- @phronia/core:  59 files, 926 passed, 1 skipped
- @phronia/cli:  115 files, 2125 passed
- @phronia/testing: 5 files, 23 passed（含 dogfood idempotence）
```

独立复跑：

```text
pnpm check:shims      → shim guard ok (14 files), artifacts current
pnpm check:layout     → layout literal ratchet ok (total=3)
pnpm check:layout-json→ layout.json is current
node packages/cli/bin/trellis.js update --dry-run
  → 无 "New files"，无 "Template updated"；仅 .phronia/config.yaml 为用户改动
```

基线为 114 files / 2121 + 23；S4 新增 1 个 e2e 文件、2 个测试，R10 可见性再增 2 个测试，因此为 115 / 2125 + 23。

## 3. PRD Acceptance Criteria → 证据

### A. spec C

| AC | 证据 |
|---|---|
| A-1 任务只写 `spec-delta.md`；planner 不再因 spec 串行，wave 可含 A/B/C | `packages/cli/test/commands/parallel-spec-e2e.integration.test.ts`「plans one wave…」断言三任务同 wave 且无 `SPEC_IS_POST_INTEGRATION`；`packages/core/test/task/parallel.test.ts` PLAN-S1/S2 |
| A-2 integrate 后 spec sync 串行 apply；`chore(spec): sync`；`meta.spec_sync.status=synced` | `packages/cli/test/commands/spec-sync.integration.test.ts`「commit writes only .phronia/spec…」「syncs two tasks in one call…」；e2e 断言恰好 1 个 `chore(spec): sync` 且三个任务 `synced` |
| A-3 两个任务同时 integrate + sync 不交错写 spec | `spec-sync.integration.test.ts`「commits two tasks serially without interleaving their spec files」「refuses while another integration holds the lock」 |
| A-4 未 sync 的 archive 被拒绝；`--skip-spec-sync` 可显式跳过并记录原因 | `packages/cli/test/scripts/task-archive-spec-sync.integration.test.ts`「refuses to archive a pending spec delta」「--skip-spec-sync archives and records the reason in notes」 |
| A-5 footprint 含 `.phronia/spec/**` → `SPEC_IS_POST_INTEGRATION` warn + next | `packages/core/test/task/parallel.test.ts` PLAN-S1/S2（severity=warn、next 指向 `spec-delta.md`） |
| A-6 spec-only 任务不进 wave，主 checkout 直接更新，archive 正常 | `packages/core/test/task/parallel.test.ts` PLAN-S3/S4；`packages/cli/test/commands/integrate.integration.test.ts`「SPEC_IN_CODE_TASK: a spec-only task bypasses the gate and lands」；e2e「spec-only task updates spec… and archives without skip flags」 |

### B. archive

| AC | 证据 |
|---|---|
| B-1 worktree 存在：从 registry 读 branch，不需要 `--skip-branch-validation` | `packages/cli/test/regression.test.ts`「[issue-399.3] archive reads the branch from the worktree registry」；e2e 三个任务均不带该 flag 归档成功 |
| B-2 worktree 已删除、landed、commit 可从 base 到达：不需要 branch | `regression.test.ts`「archive accepts a removed worktree whose landed commit is on the base」 |
| B-3 worktree 已删除、未 landed：仍拒绝并给出 integrate / skip | `regression.test.ts`「archive still refuses a removed, unlanded worktree with no branch」 |

### C. 派发 UX

| AC | 证据 |
|---|---|
| C-1 `DISPATCH_WRONG_CHECKOUT` 首条为“open a new session/window in `<worktree>`”，含 `Active task:` | `packages/core/test/task/dispatch.test.ts`「WRONG_CHECKOUT opens a new session and keeps cd as a shell-only hint」 |
| C-2 `DISPATCH_TASK_NOT_CHILD` 说明 active task、关系、多会话路径 | `dispatch.test.ts`「TASK_NOT_CHILD explains a sibling relationship and its own workspace」「TASK_NOT_CHILD reports an unrelated task…」；`packages/core/test/context/subagent-facts.test.ts` 同样覆盖 |
| C-3 `DISPATCH_ISOLATION_REQUIRED` 明确禁止 main session 并发 mutating 子代理 | `dispatch.test.ts`「ISOLATION_REQUIRED forbids concurrent mutating sub-agents in one session」 |

### D. launch plan

| AC | 证据 |
|---|---|
| D-1 `parallel launch --wave 1 --json` 输出 workspace/branch/`Active task:`/平台指令；不启动进程 | `packages/cli/test/commands/parallel.integration.test.ts`「is read-only without --prepare…」「creates and then attaches workspaces with --prepare」「emits platform-specific open instructions」；断言 `worktree list` 与 `.phronia/worktrees` 未变化 |
| D-2 缺 workspace 时给 `workspace ensure` next，不静默创建 session | 同文件「is read-only without --prepare…」断言 `task.next === prepareCommand`；「rejects an out-of-range wave without creating anything」 |
| D-3 skill 明确主会话编排多 session；单会话只并行 research | `packages/cli/src/templates/common/skills/coordinator.md` + 5 个 dogfood 副本；`.phronia/workflow.md` Phase 2「Multi-session is the only mutating parallel model」 |

### E. worktree 运维

| AC | 证据 |
|---|---|
| E-1 `parallel.inputs` symlink/copy 生效；越界拒绝 | `packages/cli/test/commands/workspace.integration.test.ts`「symlinks parallel.inputs…」「copies parallel.inputs…」「rejects an input path that escapes either root」「rejects a source that resolves outside the repository」 |
| E-2 integrate 只忽略显式 `ignored_inputs`；其他 untracked 仍 dirty | `packages/cli/test/commands/integrate.integration.test.ts`「S3/R6: a configured ignored symlink does not block integration」「the same symlink without ignored_inputs still blocks」「a real untracked file is dirty even when inputs are configured」；`spec-sync.integration.test.ts` 两个 S3/R6 用例 |
| E-3 缺 node_modules/target/custom input → 可执行 next | `workspace.integration.test.ts`「emits executable hints for conventional missing inputs」；`parallel.integration.test.ts`「reports missing build inputs per launched task」 |
| E-4 `parallel.build` shared/sccache 只生成建议 | `workspace.integration.test.ts`「emits shared-target and sccache hints without setting anything globally」；`.phronia/spec/cli/backend/parallel-tasks.md` §4 |
| E-5 worktree 清理打印释放空间 | `workspace.integration.test.ts`「reports the bytes freed by worktree removal」 |

### F. 回归

| AC | 证据 |
|---|---|
| F-1 `pnpm verify` 通过 | §2，exit 0 |
| F-2 2610.29.2 派发准入 / worktree claim/lease / integrate 回归全绿 | `pnpm verify` 全量；`dispatch.test.ts`、`workspace.integration.test.ts`、`integrate.integration.test.ts`、`regression.test.ts` 均通过 |
| F-3 bedrock 风格 e2e：三任务并行、spec 后置串行 sync、archive 无 skip flag | `packages/cli/test/commands/parallel-spec-e2e.integration.test.ts`（见 §4） |

### G. 可观测性（R10）

| AC | 证据 |
|---|---|
| G-1 doctor 显示未 sync 任务 | `packages/cli/test/platform-matrix.test.ts` 的 spec sync 四态用例（pending/synced/failed/no-delta）；doctor 文本输出 `spec sync pending: <refs>` / `spec sync failed` / `spec sync ok (N synced)` |
| G-2 parallel status 显示 per-task 与汇总 | `packages/cli/test/commands/parallel.integration.test.ts` 的 `specSync` 四态 + `runParallelStatus --json` 断言；文本输出 `spec=<state>` 与 `Spec sync: N pending, M failed` |
| G-3 breadcrumb `spec:` | `packages/core/test/context/{user-prompt,session-start}.test.ts`；`workflow-state-contract.md` |

## 4. CI e2e 流程与结果

文件：`packages/cli/test/commands/parallel-spec-e2e.integration.test.ts`
运行：`pnpm --filter @phronia/cli exec vitest run test/commands/parallel-spec-e2e.integration.test.ts`
结果：**2/2 passed**（约 3.3s）。

用例 1（bedrock 风格）：

1. 临时 git 仓库，复制真实 `.phronia/scripts`，三个叶子任务各有 `spec-delta.md`、代码 footprint 不重叠。
2. `planTasks` → 1 个 wave、3 个任务；无 `SPEC_IS_POST_INTEGRATION` warn。
3. 三个 `git worktree`（`phronia/<id>`）+ shared registry；每个只提交代码。
4. 断言每个任务分支 diff 只有 `src/<id>/…`，没有 `.phronia/spec/**`。
5. 串行 `integrate` W2 → W1 → W3，均 `outcome=landed`。
6. `planSpecSync` 三个任务均 `ready`；主检出写入三段 spec；`commitSpecSync` 一次提交三个 ref。
7. 断言：恰好 1 个 `chore(spec): sync` 提交；三个 `meta.spec_sync.status=synced`；spec/代码内容均落盘。
8. 用真实 `python3 .phronia/scripts/task.py archive <id>` 归档三个任务，**不带** `--skip-branch-validation`、`--skip-spec-sync`；全部 status 0，worktree 已移除，任务进入 `archive/YYYY-MM/`。
9. 最终 `git status --porcelain` 为空。

用例 2（spec-only）：

- `meta.kind=spec` 任务不进 wave，出现 `PARALLEL_SPEC_ONLY`；
- 主 checkout 直接更新 spec；
- `task.py archive` 成功，不需要 skip flag。

## 5. 已知限制与未覆盖项

| 项 | 说明 |
|---|---|
| ZCode 多会话 UI | 本阶段未手工打开多个 ZCode 窗口逐项操作；`parallel launch`、dispatch next 文案由单测/集成测试覆盖。剩余人工步骤见 §6。 |
| Codex live run | 本机未启动真实 Codex 会话；`subagentWorkspace=inherited` 的文案与降级由 `coordinator` / `dispatch` 测试覆盖。 |
| 运行时隔离 | worktree 不隔离端口、数据库、Docker；PRD 明确为 Non-Goal，本阶段未改变。 |
| 共享 Cargo target | `parallel.build.cargo_target_dir=shared` 只生成建议，未做并发构建性能/锁竞争基准。 |
| doctor / parallel status 的 spec 可见性 | 已补齐：`doctor` 的 `task.specSync` 与 `parallel status` 的 per-task `specSync` + 汇总 pending/failed；见 §3-G。 |
| 命令命名 | 「spec sync」是流程名；实际命令是 `phronia task spec plan|commit|status`，PRD/设计已按实现命名。 |
| 平台 agent 提示词 | 已同步所有 `templates/*/agents/phronia-{implement,check}.md`（以及 codex toml / kiro json）和已安装平台的 dogfood 副本；未安装平台的模板也同步，避免源不一致。真正的硬门禁仍由 `integrate` 的 `SPEC_IN_CODE_TASK` 承担。 |

## 6. 剩余人工 e2e 步骤

1. 在 ZCode 中打开三个真实 worktree 窗口，分别以 `Active task: <ref>` 为首行执行实现/提交；确认主会话只做编排。
2. 主会话串行执行 `phronia task integrate`，再 `phronia task spec plan` → 人工更新 spec → `phronia task spec commit`。
3. 用真实 `task.py archive` 归档，确认无需 `--skip-branch-validation` / `--skip-spec-sync`。
4. 在 Codex 上重复一次，确认 `activeTaskLine` 与“独立 session”提示可直接执行。
5. 如需验证共享 Cargo target，单独在含三个 Rust worktree 的项目里测量构建时间与锁等待；本阶段未做。

## 7. 清理与回滚

- 所有 e2e 仓库都在 `os.tmpdir()` 下创建、`afterEach` 删除；测试结束无残留。
- 未提交、未打 tag、未发版。
- 文档回滚：恢复 `.phronia/spec/cli/backend/{parallel-tasks,workflow-state-contract,script-conventions}.md`、`docs/migrations/user-visible-changes.md`、`.phronia/workflow.md`、workflow/agent/skill 模板与 dogfood 副本即可。
- 运行时回滚（S1–S3 范围，供参考）：恢复 `.phronia/spec/**` 的 always-serial、移除 `integrate` 的 `SPEC_IN_CODE_TASK` 门禁、停止使用 `meta.spec_sync`；已 landed 的提交不受影响。
- 本阶段没有修改 `.phronia/tasks/**` 之外的运行时状态；本文件与 `progress.md` 是仅有的任务目录改动。
