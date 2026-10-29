# 技术设计：spec 后置同步、派发 UX 与 worktree 运维补齐

> 版本：v1（2026-10-29）
> 前置：`.phronia/tasks/archive/2026-10/10-28-parallel-dispatch-admission/`
> 契约：`.phronia/spec/cli/backend/parallel-tasks.md`

## 0. 一句话结论

把 spec 从**执行平面**移到**控制平面**：任务只产出 `spec-delta` 意图，代码先落地，spec 在 integrate 之后用集成锁串行 apply。planner 不再把 `.phronia/spec/**` 当任务 footprint；integrate 拒绝在 code 任务分支里直接改 spec。同时修掉 archive 的 branch 回归、派发 next 文案、worktree 输入/依赖/缓存的手工摩擦。多会话仍是 mutating 并行的唯一核心；主会话只做编排。

## 1. 为什么 C 是最优雅的终态

### 1.1 spec 的本质

spec 描述的是**已经落地的代码契约**，不是某个分支的本地意图。它有三个属性：

1. **共享**：多个任务会读同一份 spec；写它的人必须看到其他人的改动。
2. **跨任务**：一个任务的 spec 改动可能与另一个任务的代码/契约互相影响。
3. **后验**：spec 应该描述 integrate 后的结果，而不是合并前的猜测。

当前模型把 spec 当普通代码路径：

- `.phronia/spec/**` 在 `DEFAULT_ALWAYS_SERIAL` 里 → 任何任务碰 spec 都串行；
- workflow Phase 3.3 又要求每个任务更新 spec → 结构上每个任务都"碰 spec"；
- 结果只能靠"把 spec 移出 footprint"绕过，planner 的重叠检测失效。

这不是参数问题，是**平面归属错误**。

### 1.2 B 与 C 的对比

| 维度 | B：只串行实际重叠的 spec 路径 | C：post-integration 串行 spec sync |
|---|---|---|
| spec 写入位置 | 任务 worktree | 主 checkout（控制平面） |
| 冲突来源 | 两个任务改同一 spec 文件 / 共享 index | 无并行写；串行 apply，看到已落地代码 |
| planner 复杂度 | 需要精确 spec footprint + 重叠判定 + index 特殊处理 | spec 不在 footprint；只需警告"不要写 spec" |
| 与三平面架构 | 仍然把 spec 放在执行平面 | spec 明确属于控制平面 |
| 与 Phase 3.3 | 保留"任务内更新 spec" | 改为"任务内写 delta，落地后 sync" |
| 可审计性 | spec 改动随任务分支，和代码混在一起 | `chore(spec): sync <refs>` 单一提交，引用 landed 任务 |
| 失败模式 | 两个任务语义冲突但文件不重叠，集成时才发现 | 串行 apply 时立即看到当前 spec，冲突在控制平面解决 |
| 迁移成本 | 中（planner 规则细化） | 中高（新 artifact、sync 命令、workflow 变更） |

**选择 C 的核心理由**：它让 spec 的写入时机与它的语义一致——spec 描述 landed 结果。B 只是把冲突概率降低，没有改变"spec 在执行平面被并行写"的结构；C 从根本上消除并行写 spec。

### 1.3 与现有设计原则的对齐

- **控制平面 / 共享运行时 / 执行平面**（`parallel-tasks.md` §1）：spec 属于控制平面，和 `docs/requirements.md`、`.phronia/workflow.md` 同类。
- **隔离单位是任务**（§4.1）：代码隔离在 worktree；spec 是跨任务的共享知识，不应该被任务 worktree 独占。
- **串行合入**（§6）：integrate 已经串行；spec sync 复用同一把 integration lock，不新增第二套互斥。
- **显式降级**：没有 `spec-delta` 的任务 `spec_sync=none`；有 delta 但未 sync 的任务 archive 被拒绝，状态可见。
- **不启动进程**：spec sync 准备/提交由主会话驱动，Phronia 不调度 agent。

## 2. 现状与缺口（代码事实）

| 事实 | 位置 |
|---|---|
| `.phronia/spec/**` 在 always-serial | `packages/core/src/task/parallel/planner.ts` `DEFAULT_ALWAYS_SERIAL`；`state/config/readers.ts` 同名默认 |
| spec 更新是 workflow Phase 3.3 | `packages/cli/src/templates/workflow/workflow.md` |
| archive 只看 `task.json.branch` | `.phronia/scripts/common/task_store.py` `_validate_branch_metadata` |
| `worktree add` 只写 registry branch | `packages/cli/src/services/workspace.ts` `upsertRegistryEntry` |
| `task.py start` 不记录集成分支 | `.phronia/scripts/task.py` `_record_start_state` |
| wrong checkout next 是 `cd` | `packages/core/src/task/dispatch/policy.ts` `wrongCheckout` |
| not-child next 只说 start | `packages/core/src/task/dispatch/policy.ts` `checkTaskLineage` |
| integrate dirty 用 `git status --porcelain` | `packages/cli/src/adapters/git.ts` `status`；`services/integrate.ts` `localPreconditions` |
| worktree add 拒绝任何 dirty main | `packages/cli/src/services/workspace.ts` `addWorktree` |
| `--copy` / `--post-create` 已存在 | `packages/cli/src/services/workspace.ts` `applyCopyAndPostCreate` |

## 3. 架构与模块

```text
packages/core/src/
  task/spec/
    types.ts             # SpecDelta / SpecSyncState / SyncVerdict
    policy.ts            # 纯函数：canSync, verifyDelta, target matching
  task/parallel/
    planner.ts           # 移除 spec always-serial；SPEC_IS_POST_INTEGRATION
  task/integration/
    policy.ts            # SPEC_IN_CODE_TASK 门禁
  context/
    user-prompt.ts       # spec: synced|pending|none
    session-start.ts     # 同
  state/tasks/
    artifacts.ts         # specDelta artifact 检测

packages/cli/src/
  services/spec-sync.ts  # plan/commit；持有 integration lock；写 meta
  services/integrate.ts  # spec-in-code gate；ignored_inputs dirty 过滤
  services/workspace.ts  # inputs symlink/copy；依赖检测；cleanup size
  services/parallel.ts   # launch plan
  commands/spec.ts       # phronia task spec plan|commit

.phronia/scripts/
  task.py                # archive branch 解析；spec-delta 模板；--skip-spec-sync
  common/task_store.py   # registry branch / integration landing 解析
```

依赖方向：`task/spec` 纯领域；`services/spec-sync` 负责 IO/锁；`task.py` 只做状态机与 archive 门禁。

## 4. spec C 协议

### 4.1 任务工件：`spec-delta.md`

每个需要改 spec 的任务写一份 `spec-delta.md`（随任务工件提交）：

```md
# Spec Delta

## Target files
- .phronia/spec/cli/backend/parallel-tasks.md
- .phronia/spec/core/backend/index.md

## Intended changes
- 新增 "派发准入" 章节：错误码、first-match 顺序、能力降级。
- 在 core index 的 Source Map 中增加 task/dispatch/。

## Rationale
- 新模块改变了 core 的公开 API 分层。

## Verification
- `pnpm --filter @phronia/core test -- dispatch`
- `rg "DISPATCH_" .phronia/spec/`
```

约束：

- `Target files` 必须是仓库内、`.phronia/spec/**` 下的路径。
- 不要求精确 diff；spec sync 时由主会话基于 landed diff + 当前 spec 写成最终文本。
- 没有 spec 变更的任务不创建该文件；`spec_sync.status = "none"`。

### 4.2 状态机

```text
task status: planning → in_progress → completed
integration.outcome: none | landed | pushed | blocked | needs_human
spec_sync.status: none | pending | synced | failed
```

- 创建 `spec-delta.md` → `spec_sync.status = "pending"`（由 task 脚本或 integrate 检测）。
- `spec commit` 成功 → `synced`，写入 `commit`、`synced_at`、`refs`、`mode`。
- `spec plan` 失败 → `failed`，记录 `last_error`；archive 拒绝。
- 没有 `spec-delta.md` → `none`；archive 不要求。

### 4.3 命令

```bash
phronia task spec plan <ref...> --json      # 只读：delta、landed diff、目标文件、当前 spec 摘要
phronia task spec commit <ref...> --json    # 持锁：校验 main clean、目标文件已改、提交、写 meta
phronia task spec status [ref...] --json    # 读取状态
```

`plan`：

- 校验每个任务的 `meta.integration.outcome === "landed"`（remote 模式必须等 PR 合入并 `integrate --sync` 标记 landed）。
- 输出结构化 plan：
  ```json
  {
    "ok": true,
    "tasks": [
      {
        "taskRef": ".phronia/tasks/x",
        "delta": ".phronia/tasks/x/spec-delta.md",
        "targetFiles": [".phronia/spec/..."],
        "landedDiff": { "baseSha": "...", "commit": "...", "files": ["..."] },
        "currentSpec": [{ "path": "...", "sha256": "..." }]
      }
    ]
  }
  ```
- 不持锁、不写文件。

`commit`：

1. 获取 integration lock（与 integrate 同一把；顺序：task lease → workspace claim → integration lock）。
2. 校验 main checkout clean、在 base branch。
3. 对每个任务：读 delta、校验 `Target files` 是 `.phronia/spec/**` 且存在；校验这些文件在本次工作树中确实有改动（或允许 `--allow-missing` 并 warning）。
4. 若无 spec 文件改动 → 失败 `SPEC_SYNC_NO_CHANGES`，next 指向 `spec plan`。
5. 生成 `chore(spec): sync <refs>` 提交（只包含 `.phronia/spec/**`）。
6. 写每个任务的 `meta.spec_sync`；释放锁。
7. 输出 commit、文件列表、refs。

失败模式：

| 码 | 条件 | 下一步 |
|---|---|---|
| `SPEC_SYNC_NOT_LANDED` | outcome != landed | 先 integrate / 等 PR 合入后 `--sync` |
| `SPEC_SYNC_LOCK_BUSY` | integration lock 被占用 | 等待或 `--wait` |
| `SPEC_SYNC_DIRTY_MAIN` | main 有非 spec 改动 | 提交/暂存 |
| `SPEC_SYNC_TARGET_INVALID` | delta 目标越界/不存在 | 修 delta |
| `SPEC_SYNC_NO_CHANGES` | spec 文件没有变化 | 按 plan 更新 spec |
| `SPEC_SYNC_FAILED` | 其他 | 查看诊断 |

### 4.4 为什么不是 deterministic patch

`spec-delta.md` 是意图，不是 diff。原因：

- 两个任务先后落地，第二个任务的 delta 必须基于第一个任务后的 spec 文本；静态 patch 会冲突。
- spec 的写法需要判断（章节位置、术语一致性），纯 patch 无法保证质量。
- 串行 + 主会话/agent 写入 + `commit` 校验，兼顾质量和可审计性。

未来可以增加 `spec commit --apply-patch` 给完全确定性的项目，但不是本任务的终态必需。

### 4.5 integrate 的硬门禁

`task integrate` 在计算任务分支 diff 时，如果发现 `.phronia/spec/**` 有改动且任务不是 spec-only：

- 返回 `SPEC_IN_CODE_TASK`；
- 说明：spec 是 post-integration 写入，任务应把意图写到 `spec-delta.md`，并移除任务分支里的 spec 改动；
- next：`git restore --staged --worktree .phronia/spec` + 写 delta + 重新提交。

例外：

- `meta.kind=spec` 的 spec-only 任务；
- `task integrate --allow-spec-in-code` **不提供**（避免重新引入并行写 spec）。如果必须在同一 PR 审 spec，使用 `spec-delta.md` 作为审阅材料。

### 4.6 spec-only 任务

`meta.kind=spec` 或没有代码 footprint 且只有 `spec-delta.md`：

- planner 不把它放进 wave（`PARALLEL_SPEC_ONLY` info）；
- 它在主 checkout 直接更新 spec，不创建 worktree；
- integrate 不需要（或 `integrate` 直接标记 landed）；
- archive 正常。

## 5. planner 变更

1. 从 `DEFAULT_ALWAYS_SERIAL` 移除 `.phronia/spec/**`。
2. `meta.parallel.touches` 里出现 `.phronia/spec/**` 时：
   - 诊断 `SPEC_IS_POST_INTEGRATION`，severity `warn`；
   - 不因此把任务串行（spec 不是执行 footprint）；
   - next：把意图写到 `spec-delta.md`，并从 `touches` 移除 spec 路径。
3. `meta.kind=spec` 的任务：
   - 诊断 `PARALLEL_SPEC_ONLY`，severity `info`；
   - 不进 wave，和容器任务一样由控制平面处理。
4. `docs/requirements.md`、`.phronia/workflow.md`、`.phronia/config.yaml`、`.phronia/gate.yaml` 仍在 always-serial；它们不是 spec 树，更新仍走串行控制平面。

## 6. archive branch 解析

`_validate_branch_metadata` 改成：

```text
resolve_branch(data, registry, repo_root):
  1. data.branch（显式记录）
  2. registry entry for taskRef（worktree 还在）
  3. null
```

校验顺序：

1. branch 存在且 base 存在且 branch == base → 拒绝（PR 不能指向自己）。
2. branch 为空：
   - 若 `meta.integration.outcome == "landed"` 且 `meta.integration.commit` 可从 base 到达 → 接受；打印 "landed without a dedicated branch (verified by integration metadata)"。
   - 否则若 base 存在且 repo 有 remote → 拒绝（现有行为）。
3. branch 存在但本地不存在 → warning（现有行为）。
4. `--skip-branch-validation` 保持为显式逃生口。

实现要点：

- registry 读取复用 `worktrees.json`（共享运行时）；Python 侧已有 archive worktree 解析函数，复用它。
- 不写回 `task.json.branch`。
- `meta.integration.commit` 是 integrate 写入的 commit；`git merge-base --is-ancestor <commit> <base>` 验证。
- 远程模式：`outcome=pushed` 时仍拒绝，等 PR 合入后 `integrate --sync` 标记 landed。

## 7. 派发 next 文案

### 7.1 `DISPATCH_WRONG_CHECKOUT`

现在：

```text
next: ["cd <worktree>", "re-dispatch implement from that checkout"]
```

改为：

```text
next: [
  "open a new session/window in <worktree>",
  "first line: Active task: <ref>",
  "cd <worktree>   # only if your harness can move this session's cwd"
]
```

reason 保持"task has a worktree at X, current checkout is Y"。

### 7.2 `DISPATCH_TASK_NOT_CHILD`

现在：

```text
next: ["task.py start <requested>", "re-dispatch implement with Active task: <requested>"]
```

改为：

```text
reason: session is bound to <active>; <requested> is a sibling/other task
next: [
  "open a separate session for <requested> (worktree: <path or 'run workspace ensure first'>)",
  "first line: Active task: <requested>",
  "do not dispatch mutating siblings from this session",
  "on a per-task-workspace harness, coordinator mode can dispatch children with explicit cwd (not supported on <platform>)"
]
```

`details` 增加 `activeTask`、`requestedTask`、`requestedWorkspace`、`platform.subagentWorkspace`。

### 7.3 `DISPATCH_ISOLATION_REQUIRED`

保留多会话四步，增加一行：

```text
do not run multiple mutating sub-agents in the main session; ZCode/Codex inherit the parent cwd
```

## 8. 多会话 launch plan

### 8.1 命令

```bash
phronia task parallel launch [refs...] --wave <n> --json [--prepare]
```

- `--prepare`：对每个 mutating 任务执行 `workspace ensure`（有副作用）；默认不准备，只读 registry。
- 输出：
  ```json
  {
    "ok": true,
    "wave": 1,
    "tasks": [
      {
        "taskRef": ".phronia/tasks/x",
        "workspace": "/repo/.phronia/worktrees/x",
        "branch": "phronia/x",
        "activeTaskLine": "Active task: .phronia/tasks/x",
        "prepareCommand": "phronia task workspace ensure .phronia/tasks/x",
        "openInstructions": "Open a new ZCode window with working directory /repo/.phronia/worktrees/x; first line: Active task: .phronia/tasks/x",
        "inputs": { "missing": ["rust/web/node_modules"], "next": ["ln -s ..."] }
      }
    ]
  }
  ```
- 平台差异：
  - ZCode/Codex：新窗口/新 session，worktree 路径；
  - Claude Code：未来 coordinator 的 `cwd` 派发；当前仍给多会话指令，并标注 capability。
- 不启动进程、不创建 session。
- 主会话用这个 JSON 编排，并把 `openInstructions` 交给用户/上层。

### 8.2 与技能的关系

- `phronia-coordinator` skill：主会话步骤 = `parallel plan` → `parallel launch --prepare` → 打开每个 worktree 的 session → 汇总 → 串行 integrate → spec sync。
- 单会话内只允许并行 `phronia-research`；mutating 一律独立 session。
- 明确写：ZCode/Codex 的 Agent 工具没有 cwd/isolation，禁止单会话并发 mutating 子代理。

## 9. worktree 输入、依赖与构建

### 9.1 `parallel.inputs`

```yaml
parallel:
  inputs:
    - path: rust/web/node_modules
      mode: symlink
    - path: rust/xsdk-pin-v1202
      mode: symlink
    - path: .env.local
      mode: copy
```

规则：

- `path` 必须 repo-relative、不能 `..`、不能绝对路径。
- `symlink`：目标必须在 main checkout 内；创建相对 symlink（可移植）；Windows 无权限时降级 copy 并 warning。
- `copy`：`fs.cpSync`，保留现有行为。
- 目标已存在 → skip + info。
- 失败 → `WORKTREE_INPUT_FAILED`，带 path 和 next；worktree 创建不回滚（用户可修复后重试或 remove）。

### 9.2 `parallel.integration.ignored_inputs`

```yaml
parallel:
  integration:
    ignored_inputs:
      - rust/xsdk-pin-v1202
```

- integrate 的 dirty 计算：解析 `git status --porcelain`，把匹配 `ignored_inputs` 的路径剔除后再判断。
- 只剔除**显式声明**的路径；不提供 blanket `--allow-untracked`。
- 额外安全：`git check-ignore --no-index <path>` 或 `fs.lstat` 为 symlink 且目标是 repo 内；不满足则 warning 并仍判 dirty。
- 目录模式 `/dir/` 不匹配 symlink 的问题由显式列表解决；文档说明"symlink 到 gitignored 目录时，必须把该路径加入 ignored_inputs"。
- main checkout 和 task worktree 的 dirty check 都使用同一 helper。

### 9.3 依赖检测

`worktree add`/`ensure` 成功后：

- 检查 `parallel.inputs` 中每个路径是否存在；缺失 → `next` 给出配置或手工命令。
- 通用提示（不强制）：
  - `node_modules` 存在但 worktree 缺失 → `ln -s <main>/node_modules <worktree>/node_modules`（或配置 `parallel.inputs`）。
  - `rust/target` 缺失 → 提示编译会产生新 target，建议 `CARGO_TARGET_DIR`/sccache（见 9.4）。
- 不做自动安装/编译。

### 9.4 构建缓存

`parallel.build`（建议字段，非强制）：

```yaml
parallel:
  build:
    cargo_target_dir: per-worktree   # per-worktree | shared
    sccache: false
```

- `shared`：在 `launch`/`worktree add` 的 `next` 中生成：
  ```bash
  export CARGO_TARGET_DIR=/repo/.phronia/cache/cargo-target
  ```
  并提示 Cargo 的 target 目录锁会串行化并发构建。
- `sccache`：生成安装/配置建议，不自动安装。
- 文档明确：共享 target 有缓存 thrash/锁竞争；sccache 通常更适合多 worktree。
- worktree 清理：`remove`/archive 前 best-effort 计算目录大小，打印 "freed ~X GB"；失败不阻塞。

### 9.5 `worktree add` 与 `ensure`

- 抽出共享的 `assertTaskArtifactsVisible`：
  - `ensure`：现有 `TASK_ARTIFACTS_UNCOMMITTED` + scoped commit / `--copy-task`。
  - `worktree add`：main dirty 时先判断 dirty 路径是否只包含 `.phronia/tasks/<ref>`；是 → 给出同样的 scoped commit 命令或 `--copy-task` 提示；否 → 现有拒绝。
- `worktree add` 增加 `--copy-task`（与 ensure 对齐）或直接提示 `workspace ensure --copy-task`。
- 错误文案统一指向 `ensure` 作为推荐入口。

## 10. 可观测性

- breadcrumb：
  ```text
  spec: none | pending (<ref>) | synced (<commit>)
  ```
  只在有 active task 时读取；`spec-delta.md` 存在且 `spec_sync.status != synced` → pending。
- `phronia doctor`：`task.specSync` 检查；`parallel status` 列出 pending/failed。
- `finish-work` 顺序：integrate → spec plan → agent 更新 → spec commit → archive → docs/journal；spec 失败停止。

## 11. 工作流与技能

- Phase 3.3：写 `spec-delta.md`，不直接改 `.phronia/spec/**`。
- Phase 3.4：提交代码 + delta；integrate。
- Phase 3.5 / finish-work：spec sync。
- `phronia-implement`：禁止改 spec，产出 delta。
- `phronia-check`：检查 delta 的完整性和目标文件，不检查 spec 实际写入。
- `phronia-coordinator`：多会话 launch plan + 串行 integrate + spec sync。
- 模板与 dogfood 同步。

## 12. 兼容性与迁移

| 变化 | 兼容性 |
|---|---|
| `.phronia/spec/**` 移出 always-serial | planner 行为变化；已有任务重新 plan 后可能并行。文档说明。 |
| integrate 拒绝 code 任务分支里的 spec 改动 | 破坏性；新任务必须用 delta。已 landed 的历史不受影响。 |
| `spec-delta.md` 新工件 | 可选；没有则不要求 sync。 |
| archive branch 解析 | 更宽松且更正确；不需要 `--skip-branch-validation`。 |
| `parallel.inputs` / `ignored_inputs` | 可选；缺失时行为不变。 |
| launch plan | 新命令；不改变现有流程。 |
| 数据格式 | 不新增必填字段；`meta.spec_sync`、`meta.kind` 都是可选。 |

迁移：

- 已存在并 landed 的任务：如果分支里有 spec 改动，它们已经随代码落地；不需要 retroactive sync。`spec_sync.status=none`。
- 正在进行的任务：如果已经改了 spec，integrate 会拒绝；用户把 spec 改动转成 `spec-delta.md`，从任务分支移除 spec 改动。文档给出迁移命令。
- 旧 worktree registry：直接读取 branch；无迁移。

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| spec-sync 依赖 agent 质量 | spec 更新不一致 | delta 目标文件 + 串行 + review + `chore(spec)` 单一提交 |
| integrate 硬门禁误伤 | 任务无法合入 | 明确错误码/next；spec-only 例外；文档迁移 |
| ignored_inputs 配置错误 | 真改动被忽略 | 只剔除显式路径 + `git check-ignore`/symlink 二次校验；doctor 显示 |
| symlink 跨平台 | Windows 权限失败 | 降级 copy + warning |
| 共享 CARGO_TARGET_DIR | 并发锁竞争/缓存 thrash | 默认 per-worktree；shared 只生成建议并提示 |
| launch plan 被误解为自动派发 | 用户以为会自动开 session | 输出明确"不启动进程"；文档/skill 强调 |
| 移除 spec always-serial 后仍有人改 spec | planner 不警告冲突 | integrate 硬门禁 + planner warn |

## 14. 备选方案与否决

| 方案 | 否决理由 |
|---|---|
| B：只串行重叠 spec 路径 | 没有改变 spec 在执行平面被并行写的结构；共享 index 仍需特殊处理；语义冲突仍要到集成才发现 |
| 保留 always-serial，让用户移除 spec footprint | 隐藏重叠，planner 失效；bedrock 的 workaround 不可作为推荐 |
| spec-sync 用 deterministic patch | 第二个任务的 delta 必须基于第一个后的文本；patch 易冲突，无法保证章节/术语质量 |
| 允许 `--allow-spec-in-code` | 重新引入并行写 spec，和 C 的目标冲突 |
| 单会话并发 mutating 子代理 | ZCode 无 cwd/isolation；重新引入 10-28 事故 |
| integrate blanket `--allow-untracked` | 掩盖真实未提交工作 |
| 内置强制 Rust/Node 预设 | 过度 opinionated；项目差异大；只做检测/配置/文档 |

## 15. 测试策略

### 15.1 单元

- `task/spec/policy.ts`：`canSync`、delta target 校验、target matching。
- `task/parallel/planner.ts`：spec 不再 always-serial；`SPEC_IS_POST_INTEGRATION`；spec-only 不进 wave。
- `task/integration/policy.ts`：`SPEC_IN_CODE_TASK`。
- `state/tasks/artifacts.ts`：`specDelta` 检测。
- archive branch resolver：registry / landed / no-remote / remote。
- inputs：symlink/copy/越界/Windows fallback；ignored_inputs 过滤。
- launch manifest 结构。

### 15.2 集成

- `phronia task spec plan/commit`：两个任务串行 sync；未 landed 拒绝；无变化拒绝；锁冲突。
- `integrate`：code 任务带 spec 改动 → `SPEC_IN_CODE_TASK`；spec-only 通过。
- `worktree add`：main 只有 task 工件 dirty → scoped commit 指引；其他 dirty → 拒绝。
- `parallel launch`：不启动进程；输出 workspace/Active task/平台指令。
- archive：worktree 存在/已删除/分支已删。

### 15.3 端到端

bedrock 风格：

1. 三个任务，代码 footprint 不重叠，各写 `spec-delta.md`。
2. `parallel plan` 得到单 wave 三任务（spec 不再串行）。
3. 三个 worktree 并行实现、提交。
4. 串行 integrate W2 → W1 → W3。
5. `spec plan` + 主会话更新 + `spec commit`（一个 `chore(spec)` 提交）。
6. archive 三个任务，不需要 `--skip-branch-validation`。
7. 断言 final spec 包含三个 delta 的内容，且没有代码冲突。

## 16. 实施顺序与回退

| 阶段 | 内容 | 回退 |
|---|---|---|
| S1 | spec C 核心：delta artifact、planner、integrate gate、spec plan/commit、metadata、finish-work | 移除新命令/门禁；恢复 always-serial |
| S2 | archive branch 解析、dispatch next 文案、launch plan | 分别 revert |
| S3 | parallel.inputs / ignored_inputs / 依赖检测 / build 提示 / cleanup size | 配置可选；移除字段即回到旧行为 |
| S4 | docs/skills/e2e | 文档回退 |

每个阶段独立 `pnpm verify`；S1 是行为变化点，先以 `meta.kind=spec` 和显式 delta 灰度，确认后再全面启用 integrate gate。

## 17. 与既有设计的对齐

- **不违反三平面**：spec 明确属于控制平面。
- **不违反串行合入**：spec sync 复用 integration lock。
- **不违反多会话核心**：mutating 并行仍是一任务一 worktree 一 session。
- **不违反显式降级**：没有 delta、未 landed、锁冲突都有明确错误码和 next。
- **补充 `parallel-tasks.md` §12**：把 spec 从 per-turn 工作区状态扩展到 post-integration 状态。
