# 并行执行二期：spec 后置同步、派发 UX 与 worktree 运维补齐

> 来源：2610.29.2 在 `/Volumes/MagicWork/xp-non-aosp-codes/bedrock` 的真实并行实践反馈。
> 前置任务：`.phronia/tasks/archive/2026-10/10-28-parallel-dispatch-admission/`（派发准入）。
> 运行契约：`.phronia/spec/cli/backend/parallel-tasks.md`。

## Problem

派发准入已经在 bedrock 上生效：三个 worktree 并行、按 W2 → W1 → W3 串行合入，没有代码冲突。反馈暴露的不是隔离模型，而是**多会话模型的摩擦**和**几个真实回归**：

1. **spec 被当成任务 footprint**：`.phronia/spec/**` 在 `DEFAULT_ALWAYS_SERIAL` 里，而 workflow Phase 3.3 又要求每个任务更新 spec。结果是"任何碰 spec 的任务都串行"。bedrock 只能把 spec 移出 footprint 才拿到单 wave 三任务并行——这是绕过 planner，不是解决结构问题。
2. **archive 的 branch 元数据回退**：`task.py start` 不再把集成分支记成 `branch`；`worktree add` 只写共享 registry，不写 `task.json.branch`；archive 的 `_validate_branch_metadata` 只看 `task.json.branch`。于是 worktree 任务删分支后 archive 必然要求 `--skip-branch-validation`。
3. **派发 next 文案不准确**：`DISPATCH_WRONG_CHECKOUT` 让用户 `cd <worktree>`，但 agent 会话的文件工具不会因为 shell `cd` 而迁移；`DISPATCH_TASK_NOT_CHILD` 只说"start 请求的任务"，没有说明"这个 session 已绑定另一个任务，mutating 工作必须去独立 session"。
4. **worktree 构建输入/依赖/缓存全靠手工**：gitignored 的 `xsdk-pin-v1202` 用 symlink，`.gitignore` 的目录模式不匹配 symlink，integrate 判 dirty；`node_modules`、`target` 也要手工处理；三个 `rust/target` 约 21GB。
5. **worktree add 与 ensure 的入口不一致**：`worktree add` 因为整个 main checkout dirty 就拒绝，错误不如 `ensure` 的 `TASK_ARTIFACTS_UNCOMMITTED` 精确，且没有指向 scoped commit / `--copy-task`。

同时必须明确一条边界：**不做 ZCode 单会话 mutating 子代理并行**。ZCode 的 Agent 工具没有 `cwd`/`isolation` 字段，子代理继承父会话 cwd；单会话并发 mutating 子代理正是 10-28 事故的成因。终态是：

- **多会话是 mutating 并行的唯一核心**；
- **主会话只做编排**：规划 wave、准备 worktree、输出每个 worktree 的启动命令与 `Active task:`，不直接并发 mutating 子代理；
- **单会话内允许并行只读 research 子代理**；
- Claude Code 的 per-task coordinator 暂不投入（能力存在，但 live 验证和 `cwd` 派发是另一个任务）。

## Goal

把"并行"从"能用"推进到"长期可维护、低摩擦"：

1. **spec 成为控制平面投影**：任务只产出 `spec-delta` 意图；integrate 落地后，在主 checkout 用集成锁串行 apply。planner 不再把 spec 当任务 footprint。
2. **修掉归档回归**：archive 从 worktree registry / integration 元数据恢复 branch，不再要求人工 `--skip-branch-validation`。
3. **派发 next 可直接执行**：wrong checkout 指向"新开 session/window"；跨任务派发解释"session 已绑定谁 + 应该去哪里"。
4. **主会话编排可落地**：新增多会话 launch plan，输出每个任务的 worktree、`Active task:` 和平台启动指令；不启动进程。
5. **worktree 运维显式化**：gitignored 构建输入、依赖、构建缓存用配置声明；integrate 只忽略显式声明的输入，不做 blanket `--allow-untracked`。
6. **入口一致**：`worktree add` 复用 `ensure` 的 task-artifact 语义和 scoped commit / `--copy-task` 指引。

## Requirements

### R1 spec 后置同步（选项 C）

- 任务执行平面**不再直接写 `.phronia/spec/**`**。任务产出 `spec-delta.md`（意图、目标文件、理由、验收点），随任务工件提交。
- `integrate` 成功后，`finish-work`（或显式 `phronia task spec plan <ref>` + `phronia task spec commit <ref>`；合称 spec sync）在主 checkout 上、持有 integration lock 时串行 apply spec delta。
- spec-sync 的输入是：任务的 `spec-delta.md`、已 landed 的 diff、当前 spec 树。输出是 `.phronia/spec/**` 的更新 + 一个 `chore(spec): sync <refs>` 提交。
- spec-sync 必须写入任务元数据（`meta.spec_sync = {status, commit, synced_at, refs}`）；未 sync 的任务不得 archive（除非显式 `--skip-spec-sync` 且记录原因）。
- spec-only 任务（没有代码改动）允许直接在主 checkout 更新 spec，不创建 worktree；planner 把它们当控制平面任务，不进入 wave。

### R2 planner 不再 blanket 串行 spec

- 从 `DEFAULT_ALWAYS_SERIAL` 移除 `.phronia/spec/**`。
- `parallel plan` 对 `meta.parallel.touches` 里的 spec 路径给出 `SPEC_IS_POST_INTEGRATION` 警告：spec 不应出现在执行 footprint 中，应写到 `spec-delta.md`。
- `docs/requirements.md`、`.phronia/workflow.md`、`.phronia/config.yaml` 等真正的共享控制面文件仍在 always-serial 中；只移除 spec 树。

### R3 archive branch 元数据恢复

- archive 的 branch 校验顺序：
  1. `task.json.branch`（显式记录）；
  2. `worktrees.json` 中该 taskRef 的 branch（worktree 还在）；
  3. 若 worktree 已删除：`meta.integration.outcome=landed` 且 `meta.integration.commit` 可从 base branch 到达 → 接受，不再要求 branch；
  4. 否则保持现有拒绝，并给出 `set-branch` / `--skip-branch-validation`。
- 不写回 `task.json.branch`（遵守 legacy 只读规则）；只在错误/诊断里使用 registry。
- 覆盖场景：worktree 存在、worktree 已删除、分支已删、base 无 remote、base 有 remote。

### R4 派发 next 文案与可执行性

- `DISPATCH_WRONG_CHECKOUT` 的 `next` 首条改为：`open a new session/window in <worktree>`；`cd <worktree>` 只作为 shell 提示，不作为 agent 迁移指令。
- `DISPATCH_TASK_NOT_CHILD` 的 `next` 必须说明：
  - 当前 session 绑定的是哪个 active task；
  - 请求的任务属于谁（sibling/child/other）；
  - 合法路径：为该任务新开 session（给出 worktree/`Active task:`）；或在 per-task-workspace harness 上用 coordinator 模式（标注"当前平台不支持"）。
- `DISPATCH_ISOLATION_REQUIRED` 保持多会话四步，但明确"不要在 main session 里并发 mutating 子代理"。
- 所有 deny 的 reason 保持自包含，并保留 `Do not retry; report this exactly.`。

### R5 多会话 launch plan（主会话编排）

- 新增只读/准备型命令（命名待定：`phronia task parallel launch [refs...]` 或 `phronia task workspace launch-plan`）：
  - 读取 wave 或显式 refs；
  - 对每个 mutating 任务执行 `workspace ensure`（或明确提示需要先 ensure）；
  - 输出 JSON/文本：`taskRef`、`worktree`、`branch`、`Active task:` 首行、平台启动指令（ZCode/Codex/Claude 分别不同）、依赖/输入准备提示；
  - **不启动任何进程、不创建 session**。
- 主会话用这个 plan 编排：它告诉用户/上层"每个 worktree 开一个 session"，自己不做 mutating 并发。
- 单会话内仍允许并行 `phronia-research`；skill 明确这一点。

### R6 worktree 构建输入（gitignored）

- 新增 `parallel.inputs` 配置：

  ```yaml
  parallel:
    inputs:
      - path: rust/web/node_modules
        mode: symlink      # symlink | copy
      - path: rust/xsdk-pin-v1202
        mode: symlink
    integration:
      ignored_inputs:
        - rust/xsdk-pin-v1202
  ```

- `worktree add` / `workspace ensure` 按 `inputs` 创建 symlink 或 copy；`post_create` 仍然保留，用于更复杂的项目命令。
- `integrate` 的 dirty check 只忽略 `ignored_inputs` 中**显式声明且被 git 忽略**的路径；不提供 blanket `--allow-untracked`。
- 如果 symlink 的目标不在 main checkout，或路径越界，拒绝并给出明确错误。
- Windows：symlink 权限失败时降级为 copy，并打印提示。

### R7 worktree 依赖检测

- `worktree add`/`ensure` 成功后检测常见缺失输入（`node_modules`、`target`、`parallel.inputs` 中的路径），输出可直接执行的 `next`（symlink/copy/post-create 命令）。
- 不做内置 Rust/Node 强制预设；检测是提示性的，配置是项目级的。
- `phronia doctor` 增加 worktree 输入检查（只读）。

### R8 构建缓存与清理提示

- 新增 `parallel.build` 配置建议/字段：
  - `cargo_target_dir: "per-worktree" | "shared"`（shared 时通过 `post_create`/env 设置共享目录，并提示 Cargo 的 target 锁会串行化）；
  - `sccache: true|false`（只生成推荐命令/文档，不强制安装）。
- `worktree remove` / archive 清理后打印释放的目录大小提示（best effort，失败不阻塞）。
- 文档明确：worktree 不隔离端口/DB/Docker；共享 target 有并发/缓存权衡。

### R9 `worktree add` 与 `ensure` 入口一致

- `worktree add` 在 main dirty 时，先区分"只有任务工件未提交"和"其他改动"：
  - 只有任务工件 → 给出精确的 scoped commit 命令，或提示改用 `workspace ensure --copy-task`；
  - 其他改动 → 保持拒绝。
- 两者共用同一套 task-artifact 可见性检查，不复制逻辑。

### R10 spec-sync 可观测性

- breadcrumb 增加 `spec: synced | pending | none`（有 `spec-delta` 未 sync 时显示 pending）。
- `phronia doctor` / `parallel status` 显示未 sync 的任务。
- `finish-work` 的顺序变为：integrate → spec sync → archive → docs/journal；spec sync 失败则停止，不 archive。

### R11 工作流与文档

- `.phronia/workflow.md`：Phase 3.3 改为"写 `spec-delta.md`，不直接改 `.phronia/spec/**`"；Phase 3.5/finish-work 增加 spec sync。
- `parallel-tasks.md`：新增 spec 控制平面章节、launch plan、inputs/ignored_inputs、archive branch 解析顺序。
- `phronia-finish-work` / `phronia-check` / `phronia-implement` skills 同步。
- `docs/migrations/user-visible-changes.md` 记录用户可见变化。

### R12 测试

- planner：spec 不再 always-serial；spec 路径给 `SPEC_IS_POST_INTEGRATION` warn；spec-only 任务不进 wave。
- spec-sync：串行锁；多个 landed 任务按顺序 apply；失败不 archive；`meta.spec_sync` 写入。
- archive：worktree 存在/已删除/分支已删/base 无 remote/有 remote 的 branch 解析。
- dispatch next：wrong checkout / not-child 文案断言。
- launch plan：manifest 字段、不启动进程、每任务 worktree/Active task。
- inputs：symlink/copy、越界拒绝、Windows 降级、ignored_inputs 只忽略显式路径。
- 依赖检测：缺失 node_modules/target/custom input 的 next。
- 全量 `pnpm verify`。

## Non-Goals

- **不做 ZCode 单会话 mutating 子代理并行**。Agent 工具没有 cwd/isolation；子代理继承父会话 cwd。
- **不做 Claude Code coordinator 的 live 实现**（本次只保留文档和 capability 标注；另开任务）。
- **不自动修改 `.gitignore`，不自动创建 symlink 到未知路径**。
- **不提供 integrate 的 blanket `--allow-untracked`**；只按显式 `ignored_inputs` 忽略。
- **不内置强制 Rust/Node 预设**；只做检测、提示和项目级配置。
- **不把 spec 更新塞进任务分支**；spec 是控制平面投影，post-integration 串行写。
- **不改变多会话核心与派发准入的 block 语义**。
- **不解决端口/DB/Docker 的运行时隔离**。

## Constraints

- `packages/core` 保持纯：不打印、不 `process.exit`、不读 `process.cwd()`。
- 所有会改用户仓库的操作可 dry-run、可回滚、错误带可执行 next。
- spec-sync 必须持有 integration lock，且只在 main checkout 执行。
- 不新增守护进程；launch plan 不启动 session/agent。
- 跨平台：symlink/copy、路径、锁在 macOS/Linux/Windows 可运行。
- 不破坏 2610.29.2 已有的派发准入和 archive worktree guard。

## Acceptance Criteria

### A. spec C

- [ ] 任务 A 只写 `spec-delta.md`、不碰 `.phronia/spec/**`；`parallel plan` 不再因 spec 串行，wave 可包含 A/B/C。
- [ ] integrate A 后，`spec sync A` 在 main checkout 串行 apply；生成 `chore(spec): sync A`；`meta.spec_sync.status=synced`。
- [ ] 两个任务同时 integrate + spec sync：spec sync 串行，不交错写 spec。
- [ ] 未 spec sync 的任务 archive 被拒绝；`--skip-spec-sync` 可显式跳过并记录原因。
- [ ] 任务 footprint 包含 `.phronia/spec/**` 时，planner 输出 `SPEC_IS_POST_INTEGRATION` warn，并给出改为 `spec-delta.md` 的 next。
- [ ] spec-only 任务不进入 wave，直接在主 checkout 更新，archive 正常。

### B. archive

- [ ] worktree 存在：archive 从 registry 读到 branch，不需要 `--skip-branch-validation`。
- [ ] worktree 已删除、`meta.integration.outcome=landed`、commit 可从 base 到达：archive 不需要 branch。
- [ ] worktree 已删除、未 landed：archive 仍拒绝并给出 integrate/`--skip-branch-validation`。

### C. 派发 UX

- [ ] `DISPATCH_WRONG_CHECKOUT` next 首条是"open a new session/window in <worktree>"，包含 `Active task:`。
- [ ] `DISPATCH_TASK_NOT_CHILD` next 说明 active task、请求任务的关系，以及多会话路径。
- [ ] `DISPATCH_ISOLATION_REQUIRED` 明确"不要在 main session 并发 mutating 子代理"。

### D. launch plan

- [ ] `parallel launch --wave 1 --json` 输出每个任务的 workspace/branch/`Active task:`/平台指令；不启动进程。
- [ ] 缺少 workspace 时给出 `workspace ensure` next，不静默创建 session。
- [ ] skill 明确：主会话编排多 session；单会话只并行 research。

### E. worktree 运维

- [ ] `parallel.inputs` 的 symlink/copy 在 worktree 创建时生效；越界路径拒绝。
- [ ] integrate 只忽略 `ignored_inputs` 中显式声明的路径；其他 untracked 仍判 dirty。
- [ ] 缺失 node_modules/target/custom input 时，worktree 创建输出可执行 next。
- [ ] `parallel.build.cargo_target_dir=shared` 生成推荐配置/命令，不强制；`sccache` 有文档。
- [ ] worktree 清理打印释放空间提示（best effort）。

### F. 回归

- [ ] `pnpm verify` 通过。
- [ ] 2610.29.2 的派发准入、worktree claim/lease、integrate 回归测试全绿。
- [ ] bedrock 风格的 e2e：三个任务并行，spec delta 后置串行 sync，archive 无 `--skip-branch-validation`。

## Open Questions

1. spec-sync 的 apply 方式：deterministic patch 还是 agent 驱动的 spec 更新？本设计倾向"任务产出 `spec-delta.md` 意图，spec-sync 由主会话/agent 在集成后更新"，但需要确认是否接受 agent 参与。
2. `parallel launch` 是否应该直接调用 `workspace ensure`（有副作用：创建 worktree/claim），还是只输出 plan、由用户显式执行？倾向"准备型命令 + `--prepare` 显式开关"。
3. `parallel.inputs` 的 symlink 是否允许指向 main checkout 之外？倾向拒绝越界，只允许仓库内。
4. spec-only 任务的识别方式：`meta.kind=spec`、无 code footprint、或 `spec-delta` 且无代码 diff？倾向显式 `meta.kind=spec`。
