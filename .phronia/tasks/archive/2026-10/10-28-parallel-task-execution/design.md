# 技术设计 v2：并行任务执行

> v2 推翻了 v1 的三个结构性决定：协调状态的位置、隔离的单位、以及"新会话自动开 worktree"的时机。
> 本文是实施依据；v1 的历史内容不再保留。

## 0. 本版推翻与保留

### 推翻

1. **协调状态不再放在 `.phronia/.runtime`。** 该目录是每个 worktree 各自的（gitignored），锁、队列、worktree registry 放在那里会导致不同 worktree 互相看不见。改为仓库级共享运行时：`<git-common-dir>/phronia/`。
2. **隔离单位从"会话"改为"任务"。** 一个任务对应一条分支和一个工作区；会话只是附着在任务上。两个会话做同一个任务应共享工作区，而不是各开一个 worktree。
3. **不在会话启动时静默创建 worktree。** 运行中的 agent 会话 cwd 是固定的，中途创建 worktree 无法真正把会话移过去。工作区决定发生在"认领任务/启动会话之前"，SessionStart 只做只读建议。
4. **队列不再是任务状态的一部分。** 任务记录只保存合入的**结果**；谁在排队、谁在合入由共享运行时回答。消除两套状态机。
5. **不把"每次都问用户"作为默认。** 集成模式先按项目策略解析；只在有歧义时问一次，并把选择记在任务上。
6. **模块按 policy / application / adapter 分层**，不再把 planner、锁、git 执行混在 `core/parallel.ts` 与 `cli/land.ts` 两个大文件里。
7. **命令名统一为 `integrate`（不提供 `land` 别名）**，避免语义发散。

### 保留

- worktree 不是默认路径，`auto` 策略按需创建。
- 本地串行合入 + 远端 MR 两种后端，`auto` 检测。
- 并行判定保守：显式依赖 + 足迹 + always-serial，未知即串行。
- 冲突只分类和路由，语义冲突永不自动解决。
- 零守护进程、无新运行时依赖、dry-run、可回滚。

### 纳入本次终态

1. **Coordinator 模式**：单会话读取积压、规划批次、准备 worktree、通过 harness 原生子代理派发、聚合状态、串行合入；新会话可中途加入。它不是第二套执行模型，复用同一套任务、worktree、claim、lease、integrate。
2. **Phase 0 能力验证**：在真实 harness 上验证并行子代理、每任务 cwd/worktree、显式 `task_ref` 转发、嵌套子代理；未验证的能力不得假设支持。
3. **共享任务索引 + 任务租约**：从 Phase A/B 就实现，而不是"以后预留"；否则 coordinator 无法看到跨会话任务，也无法防止重复领取。

## 1. 架构总览：三个平面 + 一份持久记录

```
┌─────────────────────────────────────────────────────────────────────┐
│ Control plane：主 worktree                                           │
│   .phronia/tasks/**            任务意图、规划、父/子关系              │
│   .phronia/config.yaml         并行/集成策略                         │
│   docs/requirements.md         任务投影（生成物）                    │
│   职责：plan、queue 决策、local 合入、docs generate                   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────┴─────────────────────────────────────┐
│ Shared runtime：<git-common-dir>/phronia/  （所有 worktree 共享、不跟踪）│
│   integration.lock             当前合入租约 + 阶段 + pre/post SHA     │
│   integration.json             等待队列 + 最近一次结果                │
│   worktrees.json               任务 ↔ worktree 路径映射              │
│   workspace.claim.json         主 checkout 占用租约                  │
│   tasks.index.json             任务摘要投影（可重建）                │
│   leases/<task>.json           任务租约（谁在做这个任务）            │
│   职责：跨 worktree 的互斥与发现                                      │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────┴─────────────────────────────────────┐
│ Execution plane：linked worktrees（每个任务一个）                     │
│   .phronia/tasks/<task>/task.json   该任务分支上的任务快照            │
│   .phronia/.runtime/sessions/**     该 worktree 内的会话指针          │
│   代码、测试、日志、agent 会话                                        │
│   职责：实现、验证、冲突修复                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.1 为什么必须这样分

| 事实 | 后果 |
|---|---|
| `.phronia/.runtime/` 在 `.gitignore` 中，且每个 worktree 各有一份 | 锁/队列/registry 放这里，worktree A 看不到 worktree B 的锁，串行合入失效 |
| `.phronia/tasks/**` 是跟踪文件，随分支走 | 在 worktree 里新建的任务只存在于该分支，主 worktree 的 planner 看不到 |
| 会话指针在 `<worktree>/.phronia/.runtime/sessions/` | 每个 worktree 的会话互相不可见；跨 worktree 的状态必须显式聚合 |
| `git worktree` 共享 object database/refs | 可以用 `git worktree list` 和分支名重建 registry，不需要把 registry 当事实来源 |

结论：**协调状态属于仓库，不属于某个 checkout。** 用 `git rev-parse --git-common-dir` 得到共享目录，所有 worktree 都解析到同一处。

### 1.2 事实来源

| 问题 | 事实来源 |
|---|---|
| 分支是否存在、是否已合入 | git |
| 某任务用哪个 worktree | 共享 `worktrees.json`，可由 `git worktree list` 重建 |
| 任务的 worktree 路径/分支 | 共享 `worktrees.json`；`task.json.worktree_path` 是 B11 旧字段，只读兜底，不再写入 |
| 谁在合入 | 共享 `integration.lock` |
| 主 checkout 归谁使用 | 共享 `workspace.claim.json` |
| 谁在排队 | 共享 `integration.json` 的 `queue` |
| 任务意图/依赖/足迹 | 任务分支上的 `task.json`（主 worktree 的副本用于规划） |
| 任务最终是否合入 | `task.json.meta.integration.outcome` + git 祖先关系 |

不存在第四份状态。

## 2. 分层与模块

### 2.1 分层

| 层 | 职责 | 约束 |
|---|---|---|
| Domain（`packages/core/src/task/{parallel,integration,workspace}`） | 纯策略：足迹、依赖图、批次、模式解析、冲突分类、工作区决策 | 无 IO、无进程、无打印、无 `process.cwd()` |
| Application（`packages/cli/src/services`） | 编排流程：plan、workspace ensure、integrate、recover | 只通过端口调用外部世界 |
| Adapter（`packages/cli/src/adapters`） | git、gh/glab、锁文件、共享运行时解析、时钟/主机 | 可替换、可测试、错误转为结构化结果 |
| Command（`packages/cli/src/commands`） | 参数解析、文本/JSON 输出、退出码 | 不写业务规则 |

### 2.2 只有三个端口

不要为每个函数造接口。只需要三个真正会替换的实现：

```ts
interface GitPort {
  status(cwd): { clean: boolean; dirtyPaths: number };
  branch(cwd): string;
  head(cwd): string;
  resolveRef(cwd, ref): string;
  isAncestor(cwd, maybeAncestor, ref): boolean;
  isBare(cwd): boolean;
  worktreeList(cwd): WorktreeInfo[];
  worktreeAdd(opts): void;
  worktreeRemove(opts): void;
  rebase(cwd, onto): RebaseResult;
  mergeFf(cwd, ref): void;
  fetch(cwd, remote, ref): void;
  push(cwd, remote, branch): void;
}

interface ForgePort {
  kind: "github" | "gitlab" | "generic";
  available(): boolean;
  createChangeRequest(opts): { url: string } | null;
  viewChangeRequest(branch): ChangeRequestState | null;
  compareUrl(opts): string | null;
}

interface LeaseStore {
  acquire(record): Lease | "busy";
  heartbeat(record): void;
  release(): void;
  read(): Lease | null;
}
```

`WorkspaceProvider` 不需要接口：只有两个纯函数结果（复用当前 checkout / 使用 worktree），由 application 层直接执行。`IntegrationBackend` 也不需要接口：local 和 remote 的流程差异大，硬套一个 interface 只会制造空实现。用两个独立函数 `integrateLocal` / `integrateRemote`，共享前置检查和结果写入。

### 2.3 目录

```
packages/core/src/task/
  parallel/
    types.ts          # TaskSnapshot, Footprint, Wave, Explain
    footprint.ts      # normalize + overlap
    graph.ts          # depends_on + cycle + levels
    planner.ts        # planWaves
  integration/
    types.ts          # IntegrationOutcome, Mode, ConflictKind
    policy.ts         # resolveMode, classifyConflict
    queue.ts          # ordering + selection（纯函数）
  workspace/
    types.ts          # WorkspaceDecision
    policy.ts         # decideWorkspace
  coordinator/
    types.ts          # Batch, DispatchManifest, CoordinatorState
    policy.ts         # capability gate, batch status, new-task scheduling
  index.ts

packages/core/src/state/
  shared-runtime.ts   # 共享运行时路径类型（不执行 git）
  config/readers.ts   # parallel 配置视图

packages/cli/src/
  adapters/
    git.ts            # GitPort 的 execFile 实现
    forge.ts          # gh/glab/generic 检测与调用
    lease.ts          # O_EXCL 租约
    shared-runtime.ts # git-common-dir 解析 + JSON 原子读写
  services/
    parallel.ts       # plan / status 聚合
    workspace.ts      # ensure / attach / release
    integrate.ts      # local / remote / recover
    coordinator.ts    # batch / dispatch / monitor
    lease.ts          # task lease acquire/release/status
  commands/
    parallel.ts
    integrate.ts
    dispatch.ts       # parallel dispatch --batch
    lease.ts          # task lease ...
    worktree.ts       # 扩展现有命令
```

## 3. 状态模型

### 3.1 task.json（持久、随分支走）

```json
{
  "meta": {
    "parallel": {
      "depends_on": ["10-28-other-task"],
      "touches": ["packages/cli/src/commands/worktree.ts"],
      "exclusive": false,
      "worktree": "auto",
      "allow_unknown_footprint": false
    },
    "integration": {
      "mode": null,
      "outcome": "none",
      "base_sha": null,
      "commit": null,
      "pr_url": null,
      "verified": false,
      "last_error": null,
      "log_ref": null,
      "updated_at": null
    }
  }
}
```

`outcome` 只有四个值：

| 值 | 含义 |
|---|---|
| `none` | 未合入 |
| `landed` | 已进入集成分支 |
| `pushed` | 分支已推送/PR 已创建，等远端 |
| `blocked` | 冲突/验证失败/竞态 |
| `needs_human` | 语义冲突或重复实现，需要人决定 |

**没有 `queued` / `landing`。** 这两个是共享运行时的瞬时状态，不写进任务记录。这样任务记录不会因为进程崩溃而停留在假状态。

**`worktree_path` / `branch` 的处理**：这两个是 B11 留在 `task.json` 的字段。`branch` 可移植，`worktree_path` 不可移植（绝对路径、机器相关）。v2 起：

- 运行时映射只写共享 `worktrees.json`；
- 不再写 `task.json.worktree_path`，避免主 checkout 在创建 worktree 后变脏、避免把机器路径提交给其他开发者；
- 旧字段保留读取（registry 缺失时兜底），不迁移、不删除；
- `parallel status` 以 registry 为准，读取旧字段时标注 `legacy`。

### 3.2 共享运行时 `<git-common-dir>/phronia/`

`integration.json`：

```json
{
  "schemaVersion": 1,
  "queue": [
    {
      "taskRef": ".phronia/tasks/10-28-a",
      "enqueuedAt": "2026-10-28T10:00:00Z",
      "mode": "local",
      "baseBranch": "main"
    }
  ],
  "last": {
    "taskRef": ".phronia/tasks/10-28-a",
    "outcome": "landed",
    "commit": "def456",
    "at": "2026-10-28T10:05:00Z"
  }
}
```

- `queue` 只保存**等待中**的条目。当前合入者由锁文件表示，不在队列里。
- 队列顺序由 `enqueuedAt` 决定；没有可变的 per-entry 状态机。
- 任务完成/失败后从队列移除；结果写回 task.json。

`integration.lock`：

```json
{
  "schemaVersion": 1,
  "owner": ".phronia/tasks/10-28-a",
  "host": "macbook",
  "pid": 48213,
  "phase": "rebasing",
  "baseBranch": "main",
  "preLandSha": "abc123",
  "postLandSha": null,
  "acquiredAt": "2026-10-28T10:00:00Z",
  "heartbeatAt": "2026-10-28T10:00:30Z",
  "ttlSeconds": 1800
}
```

`phase` 是恢复的关键：`acquiring → rebasing → verifying → merging → done`。崩溃后从 phase + git 状态判断是重试、补齐还是人工处理。

`worktrees.json`：

```json
{
  "schemaVersion": 1,
  "worktrees": [
    {
      "taskRef": ".phronia/tasks/10-28-a",
      "path": "/repo/.phronia/worktrees/parallel-task-execution",
      "branch": "phronia/parallel-task-execution",
      "kind": "phronia",
      "createdAt": "2026-10-28T09:00:00Z"
    }
  ]
}
```

- `kind`：`phronia`（Phronia 创建）或 `platform`（Claude Code/Conductor 等原生创建）。
- registry 可由 `git worktree list --porcelain` + 分支名重建；丢失不阻塞。
- 读取失败时回退到旧位置 `.phronia/.runtime/worktrees.json` 并迁移，兼容 B11 已创建的工作区。

`workspace.claim.json`：主 checkout 占用租约。它不是"任务状态"的副本，而是"这个工作树现在归谁使用"的原子记录；schema、认领算法和 stale 规则见 §4.6。

`tasks.index.json`：跨会话任务摘要投影（taskRef/title/status/priority/footprint/dependsOn/owner/workspace/updatedAt）。它是可重建的，不是第二份事实来源；schema 见 §17.4。

`leases/<task>.json`：任务租约，回答"谁在做这个任务"。用 `O_EXCL` 原子获取，与 workspace claim、integration lock 分属三个不同的互斥；schema 见 §17.5。

### 3.3 日志

验证/合入日志放**主 worktree** 的 `.phronia/.runtime/integration-logs/<task>-<ts>.log`。日志不需要跨 worktree 共享，放主 checkout 便于用户直接打开；`log_ref` 存相对路径。

## 4. 工作区策略与交互

### 4.1 隔离单位是任务，不是会话

- 一个任务 = 一条分支 = 最多一个 worktree。
- 一个会话 = 附着在一个任务上；会话可以有多个，但同一任务共享同一个工作区。
- 并行来自**不同任务**，不是"不同会话做同一任务"。
- Git 本身限制同一分支只能在一个 worktree 检出；这也是任务级隔离的自然结果。

### 4.2 决定函数

`decideWorkspace(task, context) -> WorkspaceDecision`：

| 条件 | 决定 | 理由 |
|---|---|---|
| 任务已有 worktree（shared registry 优先，旧 task.json 兜底） | `attach` | 复用，不重复创建 |
| 当前 checkout 被另一个活动任务占用 | `create` | 避免两个任务互相污染 |
| 任务在并行批次中（>1） | `create` | 并行执行需要独立工作树 |
| `meta.parallel.worktree=always` 或 `exclusive` | `create` | 显式隔离 |
| 当前 checkout 干净且无其他活动任务 | `reuse-current` | 串行任务不需要 worktree |
| 当前 checkout 有未提交改动 | `refuse` 或 `create` | 默认拒绝；`--force` 才复用 |
| 目标路径/分支已被占用 | `refuse` | 给出占用者路径 |

`WorkspaceDecision` 是纯数据：

```ts
type WorkspaceDecision =
  | { kind: "reuse-current"; reason: string }
  | { kind: "attach"; path: string; branch: string; reason: string }
  | { kind: "create"; path: string; branch: string; base: string; reason: string }
  | { kind: "refuse"; reason: string; next: string };
```

### 4.3 会话交互：在启动前决定，而不是启动后

运行中的 agent 会话 cwd 是固定的。中途创建 worktree 并不能把会话移过去（文件工具仍以会话根目录为基准）。因此：

**优先使用平台原生 worktree**（Claude Code `--worktree`、Conductor、Cursor 等），Phronia 只做 `attach`；`create` 是平台不支持时的跨平台兜底。这样既不与平台争抢能力，也减少 Phronia 需要维护的创建逻辑。

1. **SessionStart hook 只读。** 注入当前任务、当前 checkout 的占用者、建议的下一步；不创建、不切换。
2. **认领任务时决定工作区。** 用户在会话里执行 `task start <ref>`（Python，负责指针）后，agent 按 `phronia-continue` 的指引执行：
   ```bash
   phronia task workspace ensure <ref> --json
   ```
   它返回 `reuse-current` / `attach` / `create` / `refuse`。
3. **需要新工作区时，先确认再创建。** 输出：
   ```
   Task B is not isolated yet.
   Current checkout is owned by task A (worktree: /repo).
   Create worktree at .phronia/worktrees/B on branch phronia/B? [Y/n]
   ```
   确认后创建，并打印：
   ```
   Worktree ready: /repo/.phronia/worktrees/B
   Start a new agent session in that directory (or use your platform's worktree launch).
   ```
4. **同一任务的新会话**直接 `attach`，不创建第二个 worktree。
5. **平台原生 worktree**（Claude Code `--worktree`、Conductor、Cursor 等）由平台创建；Phronia 用 `phronia task worktree attach <ref> [--path]` 校验分支并登记，不重复创建。
6. **多个会话同一任务**允许，但 `workspace ensure` 输出警告："this task already has an active session; edits share one working tree"。

这条交互的关键：**Phronia 不会假装能移动一个已经运行的会话。** 它负责把工作区准备好，并告诉用户/平台在哪里启动会话。

### 4.4 任务创建的控制平面规则

- `.phronia/tasks` 随分支走，因此 worktree 里新建的任务是**分支局部**的。
- **任务工件必须先进入集成分支，worktree 才能看到它。** `git worktree add` 从提交创建，不会复制主 checkout 的未提交文件。`workspace ensure` 在创建前检查 `.phronia/tasks/<ref>` 是否已在集成分支：
  - 已提交 → 直接创建；
  - 未提交且主 checkout 只有该任务目录的改动 → 提供一次 scoped commit（`git add .phronia/tasks/<ref>` + `chore(task): plan <ref>`），确认后创建；
  - 未提交且有其他改动 → 拒绝，或 `--copy-task` 把任务目录复制进 worktree（不提交主 checkout），并警告两边可能分叉。
  没有这条规则，agent 在 worktree 里会找不到 PRD/design/implement，整个工作流断掉。
- `parallel plan` 是控制平面操作，默认在**主 worktree** 运行，读取主 worktree 的任务记录。
- 在 linked worktree 里执行 `phronia task create`：
  - 允许，但打印警告："this task is branch-local until integrated; create it in the main checkout if it should be planned in parallel."
  - 不跨 worktree 写文件（避免惊喜）。
- `parallel status` 会同时展示：
  - `control-plane tasks`：主 worktree 中可见的任务；
  - `branch-local tasks`：从共享 registry 中各 worktree 读到的、尚未合入主分支的任务。
- 推荐流程：先在主 checkout 创建/规划任务，再 fan-out 创建 worktree。

### 4.5 工作区位置与清理

**默认持久化在 `.phronia/worktrees/<task-id>`，永不默认 `/tmp`。**

理由：

- worktree 是可能跨重启的进行中工作，不是临时缓存；`/tmp` 的语义相反，重启/OS 清理会丢未提交工作。
- 该位置已在 `.phronia/.gitignore`（`worktrees/`），`update.ts` 也已排除 `/worktrees/`，不需要新约定。
- 与仓库同一文件系统；外置卷项目（如 bedrock）不会因为 worktree 在 `/tmp` 而跨盘，构建/文件监听更快。
- 目录名用截断后的 task id（60 字符 + 短哈希），避免 Windows 路径过长；完整 ref 存 registry。

配置：

```yaml
parallel:
  worktree:
    dir: .phronia/worktrees      # 相对仓库根；可绝对路径
    cleanup: on-archive          # on-archive | on-integrate | manual
    location: persistent         # persistent | ephemeral
```

清理规则：

| 时机 | 行为 |
|---|---|
| `integrate` 成功 | 默认保留，标记 `merged`，便于排查；`--clean` 才立即删除 |
| `task archive` | dirty → 拒绝；clean + landed → 自动删除；clean + 未 landed → 拒绝 |
| `worktree prune` | 只删除已归档/已合入且干净的 worktree；`--dry-run`、`--older-than`；永不删 dirty/未合入/未推送 |
| 远端 `pushed` 未合并 | 不清理 |
| 分支 | 默认保留；`--delete-branch` 才删 |

安全底线：永不自动删除 dirty worktree、有未合入/未推送提交的 worktree、或分支（除非显式 `--delete-branch`）。删除失败不阻塞 archive，留下 warning 和下一步命令。

`ephemeral` 模式使用 `os.tmpdir()/phronia/<repo-hash>/<task-id>`，必须显式开启，并在 `workspace ensure` 输出"重启会丢失未提交工作"的警告。

决策选项与完整权衡见 `decisions.md` §6。

### 4.6 主 checkout 占用判定与原子认领

这是"什么时候该开 worktree"的核心。结论：**占用信号既不是任务状态，也不是 `git diff`，而是一份显式的 workspace claim。**

#### 为什么不用任务状态或 git diff

| 信号 | 为什么不够 |
|---|---|
| 任务 `status=in_progress` | 任务可能正用 worktree，不该占用主 checkout；也可能在 `planning` 阶段就已经有未提交的 PRD/design，需要保护 |
| `git status` 有改动 | 有未提交改动不等于有任务在用它（可能是本地 `.env`）；任务把改动提交后仍然在占用主 checkout |
| 有活跃会话 | 会话可能只是在问答，没有任务；会话身份也不是所有平台都可靠 |
| 目录里有 `.phronia/tasks/<ref>` | 任务可能存在但没人正在工作；也可能刚归档 |

claim 表达的是"这个工作树现在归谁使用"，与有没有改文件、任务是什么状态解耦。

#### claim 记录

位置：`<git-common-dir>/phronia/workspace.claim.json`（与 integration 锁同一个共享运行时）。

```json
{
  "schemaVersion": 1,
  "ownerType": "session",
  "ownerRef": "session:zcode:abc123",
  "sessionKey": "zcode:abc123",
  "taskRef": null,
  "workspace": "/repo",
  "branch": "main",
  "host": "macbook",
  "pid": 48213,
  "state": "planning",
  "acquiredAt": "2026-10-28T10:00:00Z",
  "heartbeatAt": "2026-10-28T10:05:00Z",
  "ttlSeconds": 7200
}
```

- `ownerType=session`：已开始任务工作但还没创建任务。
- 创建任务后，在同一把 claim 上把 `ownerType` 改为 `task`、写入 `taskRef`；不是重新抢锁。
- `pid` 只用于诊断。**不能用 CLI 进程 pid 判断存活**：每次 `phronia` 命令都是新进程，命令结束就"死"了。存活靠 `sessionKey` + 心跳 + TTL。
- `workspace` 是主 checkout 的绝对路径；从 linked worktree 也能判断主 checkout 是否被占用。

#### 原子认领

不要"先读、再判断、再写"。用 `O_EXCL` 创建 claim，创建成功即拥有主 checkout：

```
tryClaim(owner):
  loop:
    try open(claimPath, 'wx') -> write claim -> return "claimed-main"
    catch EEXIST:
      current = read(claimPath)
      if current.stale():
        try rename(claimPath, claimPath + ".stale." + now + "." + rand)
        catch ENOENT: continue          # 别人先清理了
        catch: return "busy"            # 无法安全清理
        continue                        # 重新尝试独占创建
      return "busy"                     # 主 checkout 已被占用
```

- 两个会话同时启动：只有一个 `open('wx')` 成功；另一个得到 `busy`，走 worktree。
- 没有"检查后到写入之间"的窗口。
- 不需要计数器：主 checkout 是二元资源（0/1），claim 文件本身就是"有任务在进行"的记录。

#### 什么时候认领

不要在裸 SessionStart 认领——用户可能只是问问题。认领发生在**"要做任务工作"**的时刻：

1. `phronia task workspace prepare`（规划/新建任务前）；
2. 或 `task create` / `task start` 的包装流程。

SessionStart / breadcrumb 只读，输出建议："main is owned by task A; if you start task work, prepare a worktree."

#### 认领失败后的流程

```
prepare:
  result = tryClaim(session)
  if result == "claimed-main":
      return reuse-main
  if result == "busy":
      return create-or-attach-worktree
  if result == "stale-dirty":
      return create-worktree + warn "main has uncommitted work from <old owner>"
```

- `busy`：为主 checkout 的占用者创建/复用 worktree；如果任务还没创建，创建一个 **provisional workspace**（见下）。
- `stale-dirty`：旧 claim 过期，但主 checkout 有未提交改动。**绝不回收**，否则会踩掉别人的工作；新会话改用 worktree，并提示旧占用者。

#### stale 判定

- `heartbeatAt + ttlSeconds < now` → stale。
- owner task 已 `completed`/archived → 可回收。
- 同 host 且 owner session 的 runtime 文件明确不存在 → 可作为辅助信号，但不单独作为依据（平台可能不暴露 session 身份）。
- **stale + owner task 仍是 `planning`/`in_progress` → 默认不回收**，返回 `stale-owned`，新会话改用 worktree；只有显式 `workspace reclaim` 或交互确认才回收。理由：claim 过期不等于任务结束，可能只是 agent 长时间思考；抢走 main 会让原会话下次写入时踩到别人。
- **stale + owner 已 completed/archived + main 干净 → 自动回收**，打印 warning。
- **stale + main 脏 → 永不自动回收**，返回 `stale-dirty`，新会话改用 worktree，并提示旧占用者。
- **无 claim 但 main 脏 → 返回 `dirty-unclaimed`**，默认建 worktree；用户显式 `--reuse-dirty` 才复用。

#### 与 local integrate 的关系

主 checkout 同时是"某个任务的工作区"和"local 合入的目标"，两者必须互斥。

- **任务本身用 main（reuse-current）**：它已经持有 claim。`integrate` 不需要 rebase/ff（提交已经在集成分支上），只做验证、写 outcome、释放 claim。
- **任务用 worktree**：`integrate --mode local` 必须先取得主 checkout 的 claim，再做 rebase/verify/ff。claim 被其他任务占用时，local integrate 不能执行：
  - `--wait`/`--queue` 等待；
  - 或提示"main is in use by task B; integrate/finish B first, or use --mode remote"。
- **锁顺序固定为 workspace claim → integration lock**，任何路径都不反过来，避免死锁。
- 合入完成后释放 claim，除非任务要继续在 main 工作（`--keep-claim`）。
- remote 模式不受 main claim 影响：push/建单在任务 worktree 内完成。

这条规则消除了"任务 A 在 main 上改文件、任务 B 同时 ff main"的竞态。它比单独的 integration lock 更强：integration lock 只保证合入串行，workspace claim 保证工作树没有被别人使用。

心跳来源：每次 `phronia task/workspace` 命令刷新；per-turn hook 可选刷新。TTL 默认 2 小时，足够覆盖长时间思考；显式 `workspace release` 立即释放。

#### provisional workspace：任务还不存在时怎么隔离

用户想"先隔离，再想 PRD/design"，此时任务还不存在。做法：

1. `phronia task workspace prepare --for-new-task "<title>"`：
   - 尝试认领主 checkout；
   - 失败则从集成分支创建 worktree，分支 `phronia/wip/<short-session-key>`，registry 记为 `taskRef: null, provisional: true`；
   - 返回 worktree 路径。
2. 用户/agent 在该目录里写 PRD/design。
3. `phronia task create "<title>"` 在 worktree 内执行：
   - 检测当前 worktree 是 provisional；
   - 创建任务目录；
   - 绑定 registry：`taskRef`、`provisional: false`；
   - 可选把分支从 `phronia/wip/<short>` 重命名为 `phronia/<task-id>`（无提交时安全；有提交时保留原名，registry 记录真实分支）。
4. 如果 TTL 内没有创建任务，且 worktree clean、无提交、无 taskRef → `prune` 清理。

这样避免了"在主 checkout 里创建任务、再把它 scoped commit 到被占用的分支"的尴尬。**scoped commit 从主路径降级为兜底**：只有"任务已经在 main 创建，之后才决定要 worktree"时才需要。

#### 运行中会话的 cwd 约束

这是无法用协议消除的物理约束：

- **理想流程**：在启动 agent 会话**之前**执行 `workspace prepare`，然后在返回的目录启动会话；或使用平台原生 worktree 启动。
- **会话已运行在主 checkout**：如果 `prepare` 决定 `create`，Phronia 可以创建 worktree 并打印路径，但不能保证 agent 的文件工具跟着切换。此时有两种降级：
  1. agent 用绝对路径继续操作 worktree（部分平台可行，但不保证 `.phronia` 解析和上下文注入）；
  2. 提示用户在新目录重启会话（推荐，行为可预测）。
- 不在文档里承诺"中途自动迁移会话"。

#### 计数器要不要

- **主 checkout**：不需要。claim 是二元互斥。
- **worktree 数量上限**：`max_concurrent` 由 planner 控制；需要硬上限时数 registry 里的存活条目即可，不需要独立计数器。即使计数短暂不准，最坏是多创建一个 worktree，不影响正确性。
- **跨机器**：claim 只在一个仓库对象库内有效；不同 clone 之间不共享。多人协作的串行化仍由远端 merge queue 负责。

#### 多仓/子模块

每个仓库有自己的 `git-common-dir` 和 claim。跨仓任务按仓库路径排序依次 `tryClaim`，避免两个任务以相反顺序抢锁造成死锁；部分成功时返回 `partial`，不假装原子。



## 5. 并行判定

### 5.1 足迹来源

按优先级：

1. `meta.parallel.touches`（显式 glob/路径）；
2. `relatedFiles`；
3. `scope`（如果配置了 scope→path 映射）；
4. `package` → `packages.<package>.path + "/**"`；
5. 否则 `unknown`。

新增命令，降低声明门槛：

```bash
phronia task footprint set <ref> <path-or-glob>... [--clear] [--json]
```

Planner 在 `--explain` 里提示未声明足迹的任务："run `phronia task footprint set ...` to allow parallel scheduling"。

### 5.2 单包仓库的现实

单包仓库里 `package` 足迹等于整仓，所有任务都会串行。为避免功能形同虚设：

- 单包仓库默认要求用户声明 `touches`，或用 `--allow-unknown` 显式接受风险；
- 多包 monorepo 先按 package 粗分，包内任务再按 `touches` 细分；
- `parallel plan` 在没有可并行任务时，输出"为什么"和建议命令，而不是一个空列表。

### 5.3 依赖与批次

- `depends_on` 是唯一依赖来源；父/子任务不是依赖。
- 缺失依赖引用 → 报错并列候选，不猜。
- 环 → 输出环路径并拒绝。
- 同 level 内按优先级、创建时间排序，贪心装箱到 `max_concurrent`。
- 未知足迹、`exclusive`、always-serial 冲突 → 单独成批。
- 跨 level 不装箱。

### 5.4 重叠判定

保守的前缀规则（不实现完整 glob 交集）：

- 相等字面路径 → 重叠；
- 一个是另一个的目录前缀 → 重叠；
- `**` → 任何同前缀路径重叠；
- 任一侧 unknown → 重叠；
- 两个 package 级足迹相同 → 重叠；
- 文件级、不同路径 → 不重叠；
- 大小写不敏感文件系统：比较前统一小写。

### 5.5 always-serial 默认

```yaml
parallel:
  conflicts:
    always_serial:
      - pnpm-lock.yaml
      - package-lock.json
      - yarn.lock
      - Cargo.lock
      - poetry.lock
      - "**/migrations/**"
      - "**/migration/**"
      - docs/requirements.md
      - .phronia/config.yaml
      - .phronia/workflow.md
      - .phronia/spec/**
      - .phronia/gate.yaml
    generated:
      - pnpm-lock.yaml
      - package-lock.json
      - yarn.lock
      - Cargo.lock
      - poetry.lock
      - "**/dist/**"
      - "**/generated/**"
```

`docs/requirements.md` 是 `phronia docs generate` 的共享投影；`archive` 与 `integrate` 都必须持有同一把共享锁写它。

## 6. 集成模式与交互

### 6.1 模式解析

优先级：

1. 任务 `meta.integration.mode`（本次覆盖）；
2. `--mode` 命令行；
3. 项目 `parallel.integration.mode`；
4. `auto` 检测：有 `origin` + forge CLI → remote；有 `origin` 无 CLI → remote（只推送）；无 origin → local。

### 6.2 什么时候问用户

配置：

```yaml
parallel:
  integration:
    mode: auto
    confirm: auto   # auto | always | never
```

- `never`：完全按解析结果，不问。
- `always`：每次 `finish-work`/`integrate` 第一次尝试时问一次。
- `auto`（默认）：只在**两种模式都可行且有实质差异**时问；否则直接说明并继续。
  - 无 origin → 只有 local，不问。
  - 有 origin + 必需 review/CI → 推荐 remote，若 local 也可行则问一次。
  - 用户已为任务记录过 mode → 不再问。

无论是否询问，`integrate` 都输出一行解析结果和理由，例如：

```
mode=remote (origin=github.com, gh available; confirm=auto)
mode=local  (no origin; confirm=auto)
```

这样用户能在不被打断的情况下发现"为什么它选了远端/本地"，并可用 `--mode` 覆盖。

提示内容必须包含后果，而不是只给两个选项：

```
Task <ref> is ready to integrate.
Base: main @ abc123
Verification: passed (pnpm lint && pnpm test)

[1] remote MR (recommended)
    push phronia/<id>, open PR/MR, remote merge queue decides merge order.
    Phronia will not merge.
[2] local merge
    rebase onto main, fast-forward locally. Linear history, no PR.
    The lock only coordinates this machine.
[3] dry-run
```

选择写入 `meta.integration.mode`，后续重试不再问。`--yes` 跳过确认；`--interactive` 强制询问。

### 6.3 本地合入

由主 worktree 执行（即使命令从 linked worktree 发起）：

1. 解析主 worktree 根与集成分支。
2. 前置检查：主 checkout 干净、在集成分支、非 detached/bare、任务 worktree 干净。
3. 获取共享锁；忙则入队并返回位置。
4. `fetch`（有远端时，失败仅警告）。
5. 记录 `preLandSha`。
6. 任务 worktree 内 `rebase <base>`；冲突 → abort + 分类。
7. 在 rebase 后的 worktree 内执行验证；失败 → 不碰 base。
8. CAS：base 仍等于 `preLandSha`；否则重试（最多 3 次）。
9. 主 worktree `merge --ff-only <task-branch>`。
10. 写 task.json outcome + 共享 `last`；释放锁；`--drain` 继续。
11. 为保证主 checkout 干净，landed 后只提交该任务目录的 `task.json`（`chore(task): record integration state`）。这是 metadata-only commit，不改变已验证的代码树；代码提交仍是验证时的分支头。

rebase 后的树与 ff 合并后的树一致；CAS 保证验证与合并之间 base 未移动。这是"验证合入结果"的最小实现，不需要额外临时分支。

### 6.4 远端合入

由任务 worktree 执行：

1. `push -u origin <branch>`。
2. 有 forge CLI：创建 PR/MR，记录 URL；已存在则复用。
3. 无 CLI：打印 compare URL（GitHub/GitLab 的 compare 页面）和手工命令。
4. 写 outcome=`pushed`。
5. **不调用任何 merge API。**
6. `integrate --sync`：fetch base，`merge-base --is-ancestor` 判断；有 CLI 时查询 PR 状态；失败降级 `unknown`。

远端模式不 rebase 已推送分支，避免 force-push。

### 6.5 切换模式的边界

- 任务用 main（reuse-current）时没有独立分支；`--mode remote` 拒绝，提示改用 local，或在新工作区中重新开始该任务。不要从 main 直接推一个“feature 分支”，否则 main 和远端分支同时拥有提交，语义混乱。
- local → remote：如果本地已 rebase 但未合并，推送；如果已合并，远程分支可能落后，提示重新推送或直接以已合并为准。
- remote → local：已推送分支可能与其他人的基線分叉；必须显式 `--mode local` 并警告会改写本地分支（不 force-push）。
- 同一任务不允许两个模式并行执行；共享锁保证。

## 7. 共享锁、队列与恢复

### 7.1 锁

- 位置：`<git-common-dir>/phronia/integration.lock`。
- 获取：`open(path, 'wx')`；EEXIST → 读锁判断。
- stale：默认只看心跳 + TTL；`pid` 只用于诊断。只有 integration lock 可以显式启用 `ttl-or-pid`（长驻合入进程），workspace claim/task lease 一律 TTL-only。
- 心跳：合入过程中每 30s 更新；写临时文件 + rename。
- 释放：关闭句柄后 unlink（Windows 兼容）。
- 锁的作用域在输出中标注 `scope: repository`（不是 machine）。跨机器仍无效，但至少同仓所有 worktree 一致。
- 多仓/子模块任务：每个仓库有自己的 `git-common-dir` 和锁；按仓库路径排序获取，避免死锁；部分成功标 `partial`。

### 7.2 队列

- `integrate <ref> --queue`：无锁时把 `{taskRef, enqueuedAt, mode, baseBranch}` 写入共享 `queue`，按 `enqueuedAt` 排序。
- `integrate --drain`：循环取队首、获取锁、执行、移除、继续。
- `integrate --wait [--timeout]`：等待自己的条目成为队首且拿到锁。
- 队列条目没有状态机；等待就是"在数组里"，执行就是"持有锁"。

### 7.3 恢复

`integrate --recover`：

1. 读锁；stale → 清除并报告。
2. 按 `phase`：
   - `rebasing`/`verifying`：base 应仍等于 `preLandSha` → 可重试；若不等 → `needs_human`。
   - `merging`：base 等于 `postLandSha` 或任务 commit 是 base 祖先 → 写 `landed`；base 仍等于 `preLandSha` → 重试；其他 → `needs_human`。
   - `done`：清理锁。
3. `--rollback` 才允许 `reset --hard preLandSha`，且需显式确认。

## 8. 冲突治理

### 8.1 分类

| 条件 | 分类 | 处理 |
|---|---|---|
| 冲突文件全部命中 `generated` | `generated` | abort rebase → 执行 `regenerate` → 重试；仍冲突 → `needs_human` |
| add/add 同一路径 | `duplicate` | 人工选一个实现 |
| 命中 always-serial（非 generated） | `needs_human` | 共享策略文件，人决定 |
| 冲突都在任务足迹内且文件数 ≤ 阈值 | `mechanical` | 交给任务 agent 在 worktree 解决 |
| 含共享契约/超出足迹 | `needs_human` | 语义风险高 |
| clean rebase + 验证失败 | `semantic` | 写报告，人决定目标行为 |
| ff 失败/base 移动 | `race` | 重试；耗尽后 `blocked` |

### 8.2 Handoff，而不是自动修复

`integrate --handoff` 写 `.phronia/.runtime/integration-handoff.md`（主 worktree），内容：

- 任务、base、task head、分类；
- 冲突文件列表；
- 验证命令与输出尾部；
- 重叠任务；
- 明确的下一步 prompt（给任务 agent）。

terminal 输出：

```
Rebase conflict in 3 files (mechanical).
Next: resolve in /repo/.phronia/worktrees/B, commit, then run:
  phronia task integrate <ref>
Handoff prompt: .phronia/.runtime/integration-handoff.md
```

Phronia 的代码路径中不存在读取/改写冲突标记的逻辑。

## 9. 边界场景

| 场景 | 行为 |
|---|---|
| 无 `origin` | local；`--mode remote` 明确失败并提示 local |
| 有 origin 离线 | local 可用；remote push 失败原样输出 stderr |
| detached HEAD | ensure/integrate 拒绝，要求 `--base` 或先切分支 |
| bare repo | 拒绝 worktree/integrate |
| shallow clone | 允许；merge-base/rebase 失败时明确报错 |
| 主 checkout 脏 | `workspace ensure` 默认 refuse；`integrate` 一律拒绝 |
| 无 claim 且主 checkout 脏 | `dirty-unclaimed`：默认建 worktree；`--reuse-dirty` 才复用 |
| claim stale 但 owner 仍 `planning`/`in_progress` | `stale-owned`：默认不回收，新会话用 worktree；显式 `reclaim` 才回收 |
| 任务用 main 但选择 remote | 拒绝；提示改用 local 或在新工作区开始，避免 main 与远端分支同时有提交 |
| 分支已被其他 worktree 检出 | `git worktree list --porcelain` 预检，给出路径 |
| submodule（`docs-site`） | 不自动 init；`post_create` 可 init；integrate 检测指针变更并要求 `--include-submodules` |
| polyrepo 包（`git: true`） | `integrate --all-repos` 按路径排序逐仓；每仓独立锁；部分成功标 `partial` |
| 归档时有 worktree | dirty → 拒绝；clean+landed → 自动清理；clean+未 landed → 拒绝 |
| `docs/requirements.md` 并发写 | 与 archive 共用共享锁；always-serial |
| 多机器 | 共享锁只在同一仓库对象库内有效；多人项目推荐 remote |
| 两个 integrate 同时启动 | O_EXCL 只允许一个；另一个入队 |
| 验证很久 | 心跳续租；`--timeout`；超时视为失败 |
| agent 仍在写 worktree | worktree dirty → 拒绝；打印活跃会话警告 |
| Windows | `open('wx')`；unlink 前关闭；路径 `path.resolve`；PID 探测 best-effort |
| 大小写不敏感 FS | 重叠判定前统一小写 |
| 空仓库/无提交 | 明确报错 |
| 任务工件未提交就创建 worktree | ensure 提供 scoped commit；拒绝或 `--copy-task` 兜底 |
| 任务在主 worktree 创建前就已 fan-out | 该任务在 worktree 分支上可见；主 planner 看不到，status 标为 branch-local |
| 平台原生 worktree | `worktree attach` 校验并登记，不重复创建 |
| 多个会话同一任务 | 共享工作区，警告并发写 |
| 会话无法切换 cwd | 打印 worktree 路径，要求在新目录启动会话或使用平台原生 worktree |

## 10. CLI

```
phronia task footprint set <ref> <path-or-glob>... [--clear] [--json]

phronia task parallel plan [refs...] [--include-planning] [--max N]
                           [--json] [--explain]
phronia task parallel status [--json]

phronia task workspace ensure <ref> [--create|--attach|--reuse] [--path <dir>]
                                  [--yes] [--json]
phronia task worktree add <ref> [--base <ref>] [--branch <name>]
                                [--copy <path>]... [--post-create <cmd>]...
                                [--force] [--json]
phronia task worktree attach <ref> [--path <dir>] [--json]
phronia task worktree list [--json]
phronia task worktree remove <ref> [--force] [--delete-branch] [--json]

phronia task integrate <ref> [--mode auto|local|remote]
                             [--base <branch>]
                             [--queue] [--wait] [--drain]
                             [--verify <cmd>]... [--no-verify]
                             [--timeout <duration>] [--interactive] [--yes]
                             [--handoff] [--dry-run] [--recover] [--rollback]
                             [--force] [--json]
```

约定：

- `integrate` 不等于 archive；归档仍由 `finish-work` / `task archive`。
- 所有命令 `--json`；错误也返回结构化 `{ok:false, code, message, next}`。
- `--dry-run` 打印解析出的模式、锁状态、将执行的 git 命令、验证命令。
- 每个错误都包含下一步命令。

## 11. 配置

```yaml
parallel:
  enabled: true
  max_concurrent: 3
  worktree: auto                 # auto | always | never
  worktree_dir: .phronia/worktrees
  worktree_cleanup: on-archive   # on-archive | on-integrate | manual
  worktree_location: persistent  # persistent | ephemeral
  copy: [.env, .phronia/.developer]
  post_create: [pnpm install]
  integration:
    mode: auto                   # auto | local | remote
    confirm: auto                # auto | always | never
    branch: null                 # null → task.base_branch
    verify: []
    timeout: 30m
    lock_ttl: 30m
    max_attempts: 3
  conflicts:
    always_serial: [...]
    generated: [...]
    regenerate: [pnpm install --lockfile-only]
    mechanical_max_files: 5
```

配置读取走 `packages/core/src/state/config/readers.ts`；未知值 warn + 回退，不静默。

## 12. 与 Phronia 工作流的集成

并行能力必须进入 workflow/skill，而不是作为一个孤立命令。

- **Phase 1（Plan）**：可选步骤 `parallel plan`，决定批次；把批次写进任务的 `meta.parallel` 或 PRD 的 "Parallel batch" 段。
- **Phase 1.4（Activate）**：`task.py start` 之后，`phronia-continue` 调用 `workspace ensure`；需要新工作区时确认并提示在新目录启动会话。
- **Phase 2（Execute）**：每个会话一个任务；`check` 在任务 worktree 内运行。
- **Phase 3（Finish）**：`finish-work` 调用 `phronia task integrate`；根据 `confirm` 询问或直接执行；成功后 `archive`。
- **Per-turn breadcrumb**：增加任务的工作区与集成状态（`workspace: worktree|current`、`integration: none|blocked|pushed|landed`），数据来自共享运行时 + task.json。
- **`phronia-continue`**：无活动任务时列出 active tasks 让用户选择；有任务时先 ensure workspace。
- **`phronia-finish-work`**：先 integrate，再 archive；integrate 失败时停止，不归档。
- **`workflow.md`**：把并行执行写成可选模式，不改变三阶段主流程。

## 13. 迁移与兼容

- **worktree registry**：从 `.phronia/.runtime/worktrees.json` 读取并迁移到 `<git-common-dir>/phronia/worktrees.json`；两个位置都读，写只写新位置。
- **停止写 `task.json.worktree_path` / `branch`**：运行时映射只写共享 registry；旧字段只读兜底，避免主 checkout 变脏和机器路径进入提交历史。
- **任务工件提交**：创建 worktree 前要求 `.phronia/tasks/<ref>` 已在集成分支；未提交时提供 scoped commit 或 `--copy-task`。
- **`task worktree add` 默认 base**：从 `HEAD` 改为解析后的集成分支；`--base HEAD` 保留旧行为。写 migration note。
- **task.json**：不新增必填字段；新数据在 `meta`，旧任务无需迁移。
- **`worktree.yaml`**：不恢复；配置进 `config.yaml` 的 `parallel.*`。
- **旧 `parallel.prompt.md`**：不恢复；后续确认无用再删。
- **`parallel.enabled: false`**：只关闭 planner 和 auto workspace；`worktree add/attach` 与 `integrate` 仍是通用原语。

## 14. 分期实施

| 阶段 | 内容 | 风险 | 回滚 |
|---|---|---|---|
| 0 | 能力验证：并行子代理、每任务 cwd/worktree、显式 task_ref、嵌套子代理 | 中 | 只读研究，无回滚 |
| A | shared-runtime + task index + domain planner + `parallel plan/status` | 低 | 删除命令 |
| B | workspace claim + task lease + `workspace prepare/ensure` + `worktree attach` + base/copy/post_create | 中 | 保留 `--base HEAD` |
| C | 共享锁/队列 + local integrate + `task commit` + recover | 高 | `parallel.enabled: false` |
| D | remote integrate + conflict 分类 + handoff | 中 | 强制 local |
| E | coordinator 会话 + dispatch manifest + 能力门控 + monitor/failure + 新会话加入 | 高 | `parallel.coordinator.enabled: false` |
| F | workflow/skill 集成 + archive 守卫 + 文档/spec + coordinator dogfood | 低 | 文档/技能回滚 |

每个阶段都不改数据格式，回滚无需迁移。Phase 0 的结论可能改变 Phase E 的平台支持范围，但不改变 A–D 的接口。

## 15. 备选方案与否决

| 方案 | 为什么不用 |
|---|---|
| 协调状态放 `.phronia/.runtime` | 每个 worktree 一份，锁失效（本版修正） |
| 把 `worktree_path` / `branch` 写进 task.json | 绝对路径不可移植；创建后主 checkout 立刻变脏；registry 才是运行时事实 |
| 把任务记录移到 `<common>/phronia/tasks` | 所有 worktree 可见，但丢失"任务随代码版本化"的历史，破坏现有 workflow/docs 生成；控制平面规则更小 |
| 用专用 integration worktree 代替主 checkout | git 不允许同一分支在两个 worktree 检出；直接 `update-ref` 风险高；要求主 checkout 干净更简单 |
| 会话级 worktree | 同一任务两会话会争同一分支；git 不允许 |
| 会话启动时自动创建 worktree | 运行中会话 cwd 固定，无法真正迁移；且 hooks 不应改变环境 |
| 队列状态写进 task.json | 两套状态源，崩溃后留下假状态 |
| 每任务都开 worktree | 安装/构建成本高，串行任务收益为负 |
| Phronia 自己实现远端 merge queue | 重复且跨平台复杂；远端已有 |
| LLM 自动解冲突 | 丢改动、编造逻辑、提交坏标记 |
| 父/子任务视为依赖 | 交付拆分≠执行顺序 |
| 用 `git merge` 提交代替 rebase | 历史分叉，回滚需 revert merge |
| 为所有 IO 造端口 | 过度抽象；只保留 Git/Forge/Lease 三个真实替换点 |

## 16. 待确认问题

1. 命令名 `integrate` 已拍板；不提供 `land` 别名。
2. `parallel.integration.confirm` 默认 `auto` 是否符合预期？`always` 更保守但更啰嗦。
3. 单包仓库是否强制要求 `touches` 才能并行？本设计默认"是，除非 `--allow-unknown`"。
4. `workspace ensure` 由 `phronia-continue` 自动调用，还是要求用户手动执行？本设计倾向自动调用 + 确认。
5. `task create` 在 linked worktree 中是否需要直接拒绝？本设计选择"允许但警告"，避免打断工作。
6. 创建 worktree 前是否允许 Phronia 自动做 scoped commit（只提交 `.phronia/tasks/<ref>`）？本设计选择"询问后提交；拒绝则拒绝创建，或用 `--copy-task` 兜底"。

## 17. Phase E：协调者模式（单会话多任务，纳入本次终态）

> 本阶段纳入本次任务；先执行 Phase 0 能力验证，再按 Phase E 实现。这里的缺口和接口是实施依据，不再是"以后再说"。

### 17.1 场景

一个 orchestrator 会话读取一个积压目录（例如 bedrock 的多个问题文件夹），分析耦合与优先级，创建多个任务，准备各自的工作区，然后通过 harness 的子代理并行执行；期间还可能有新的会话加入新任务。

### 17.2 可行性结论

**基础原语够用，但需要一层 coordinator；本版把它纳入实施，Phase 0 先验证 harness 能力。** 具体地说：

- 任务↔分支↔worktree、planner、共享运行时、workspace claim、串行 integrate 都可以复用。
- 缺四样东西：共享任务索引、任务租约、协调者会话模型、子代理能力门控。
- 另有一个现成基础：`buildSubagentSpawn` 已经能从 `hints.taskRef` / `input.task_ref` / `tool_input.taskRef` 读取显式任务引用，不必依赖会话的活动任务指针。但 orchestrator 必须显式传，不能假设子代理继承。
- **W0 实测缺口**：ZCode、Codex、Claude Code 的 Agent 工具都没有 `task_ref` 字段；当前 Python shim 也不解析 `Active task:`。因此 W5 必须扩展 `readTaskRef`：在上述字段之后解析 prompt 首行 `^Active task:\s*(.+)$`；Claude Code 还可以把 `tool_input.cwd` 映射到 workspace→task。没有这个桥，coordinator 会话里的 hook 注入无法区分任务 A/B。

### 17.3 缺口一：子代理能力并非普遍可用

当前 `PlatformCapabilities.behavior.subagentContext` 只描述"能否注入子代理上下文"，不描述：

- 是否支持并行子代理；
- 是否支持嵌套子代理；
- 是否能给每个子代理独立的 cwd/worktree；
- 子代理是否有独立会话身份。

按现有矩阵（22 个平台）：

- 有子代理上下文注入面的：Claude Code、Cursor、OpenCode、Codex、Kiro、CodeBuddy、Droid、Pi、ZCode、OMP、Snow，共 11 个；
- 明确 `none` 的：Kilo、Gemini、Antigravity、Devin、Qoder、Copilot、DSH、Reasonix、Trae、Grok、Kimi，共 11 个。

"有上下文注入面"不等于"能并行跑多个子代理并各用各的 worktree"。目前没有任何平台条目验证过后面三点。因此 coordinator 模式必须门控，不能默认所有 harness 都支持。

新增能力维度：

```ts
subagentExecution: "none" | "single" | "parallel" | "nested";
subagentWorkspace: "inherited" | "per-task";
subagentIdentity: "shared" | "isolated";
```

`coordinator.mode` 的可用条件：

- `subagentExecution` 至少 `parallel`；
- `subagentWorkspace = per-task`；
- 否则降级为"多会话"（每个任务一个会话）或"串行子代理"。

### 17.4 缺口二：共享任务索引

orchestrator 需要看到其他会话/worktree 新建的任务。v2 的共享运行时只有 worktree registry，没有任务索引。

在共享运行时增加一个**可重建的投影**（不是第二份事实来源）：

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "taskRef": ".phronia/tasks/10-28-a",
      "title": "进度条状态不匹配",
      "status": "in_progress",
      "priority": "P1",
      "footprint": ["src/ui/progress/**"],
      "dependsOn": [],
      "owner": { "type": "subagent", "id": "agent-3", "sessionKey": "..." },
      "workspace": "/repo/.phronia/worktrees/a",
      "updatedAt": "2026-10-28T10:00:00Z"
    }
  ]
}
```

- 可由主 worktree + 各 worktree 的 `task.json` 重建；丢失不阻塞。
- 新会话创建任务时登记；orchestrator 用它做跨会话规划。
- 完整任务工件仍在任务分支上，索引只存协调所需的摘要。

### 17.5 缺口三：任务租约

orchestrator、子代理、新会话可能同时看到同一个任务。需要 **task lease** 防止重复领取：

```json
{
  "taskRef": ".phronia/tasks/10-28-a",
  "ownerType": "subagent",
  "ownerId": "agent-3",
  "sessionKey": "...",
  "workspace": "...",
  "acquiredAt": "...",
  "heartbeatAt": "...",
  "ttlSeconds": 3600
}
```

- 与 workspace claim（主 checkout）、integration lock（合入）是三个不同的互斥：
  - task lease：谁在做这个任务；
  - workspace claim：主 checkout 归谁；
  - integration lock：谁在合入。
- 租约获取与 workspace prepare 可以合并为一个原子步骤；租约过期由 orchestrator 回收。
- 没有租约时，两个子代理可能同时做同一个任务，最后 add/add 冲突。

### 17.6 缺口四：协调者会话模型

当前会话模型假设"一个会话一个活动任务"。协调者会话没有单一任务，而是一个 batch。

采用：

- 会话可以有 `mode: coordinator`，活动任务指针为空，batch id 存在会话 runtime。
- per-turn breadcrumb 显示 `coordinator: N tasks (running/blocked/landed)`。
- 所有任务命令接受显式 `--task <ref>`；coordinator 模式下禁止依赖环境指针。
- orchestrator 不持有 main 的 workspace claim；它读共享索引、准备 worktree、派发子代理。main 留给 local integrate。

### 17.7 派发清单，而不是进程编排

Phronia 不启动子代理。它输出一个稳定的 manifest，由 orchestrator 用 harness 原生能力派发：

```json
{
  "batch": "bedrock-20261028",
  "tasks": [
    {
      "taskRef": ".phronia/tasks/10-28-progress-bar",
      "workspace": "/repo/.phronia/worktrees/progress-bar",
      "branch": "phronia/progress-bar",
      "lease": "lease-token",
      "dependsOn": [],
      "promptPrefix": "Active task: .phronia/tasks/10-28-progress-bar\nWork only in /repo/.phronia/worktrees/progress-bar.\nCommit your changes in this worktree when done."
    }
  ]
}
```

配套命令：

```
phronia task parallel dispatch --batch <id> --json
phronia task lease acquire|release|status <ref>
phronia task index rebuild|status --json
```

### 17.8 提交归属

当前 implement 子代理 prompt 明确说"Do NOT execute git commit"。在 worktree 并行模式下，必须有一步提交，否则 integrate 会拒绝 dirty worktree。

采用：

- 每个任务的 implement 子代理完成后，由 **task agent 或 orchestrator** 在该任务 worktree 内提交；
- 或提供 `phronia task commit <ref>`，只在任务 worktree 内运行；
- orchestrator 绝不在 main 上替 worktree 任务提交。

### 17.9 合入与 main claim 的协调

orchestrator 如果占用 main，local integrate 无法执行。采用：

- orchestrator 以"无 workspace"或控制面模式运行，不 claim main；
- 批量结束后 `integrate --drain` 串行合入；
- 或整批使用 remote 模式，完全绕开 main；
- 如果 orchestrator 必须用 main，则在 integrate 前释放 claim。

### 17.10 新会话中途加入任务

- 新会话创建任务 → 登记共享索引 → 如果 main 空闲可 claim，否则 provisional worktree。
- orchestrator 重新运行 `parallel plan`：新任务进入下一 wave，或在当前 wave 有空位且足迹不重叠时立即加入。
- 不要引入全局 batch 锁；只保留 task lease 和 integration lock。
- 新任务与运行中任务足迹重叠 → 等下一 wave。

### 17.11 落地顺序

Coordinator 纳入本次任务，按 Phase 0 → A–F 推进：

1. **Phase 0** 先验证 harness 能力；未验证的能力不得假设支持。
2. **Phase A/B** 把共享任务索引和 task lease 一并落地，不要留到"以后预留"；否则 Phase E 会推翻 A/B 的数据模型。
3. **Phase C/D** 交付 local/remote integrate、commit 归属、冲突 handoff。
4. **Phase E** 交付 coordinator 会话、dispatch manifest、能力门控、monitor/failure、新会话加入。
5. **Phase F** 做 workflow/skill、archive 守卫、文档/spec，并在 bedrock 类积压目录上做 coordinator dogfood。

先在支持并行子代理 + per-task workspace 的 harness 上验证（Claude Code / Codex / ZCode 等），其余平台降级为多会话或串行。

### 17.12 手工验证路径（Phase E 完成前）

即使 coordinator 层还没实现，在支持"每个子代理独立 worktree/cwd"的 harness 上，可以手工走：

1. orchestrator 读取积压目录，人工/LLM 分析耦合，创建任务并声明 `touches`/`depends_on`；
2. `parallel plan --json` 得到 wave；
3. 对每个任务 `workspace prepare --create`，拿到 worktree 路径；
4. 用 harness 原生 subagent 派发，prompt 显式带 `task_ref` 和 worktree 路径；
5. 子代理在 worktree 内实现、检查、提交；
6. orchestrator 轮询 `parallel status --json`；
7. 全部完成后 `integrate --drain` 串行合入；
8. 新会话加入的任务先走独立 worktree；等共享索引实现后再自动进入 planner。

这能验证 coordinator 的价值，但跨会话任务可见性、任务去重、能力门控仍然需要后续实现。

## 18. 接口契约

以下接口是 core 与 cli 之间的稳定契约。实现可以调整内部结构，但不能改变这些语义。

### 18.1 领域类型

```ts
export type IntegrationMode = "auto" | "local" | "remote";
export type IntegrationOutcome = "none" | "landed" | "pushed" | "blocked" | "needs_human";
export type ConflictKind =
  | "mechanical" | "semantic" | "generated" | "duplicate" | "race" | "needs_human";

export interface Footprint {
  readonly raw: readonly string[];
  readonly kind: "declared" | "related" | "package" | "unknown";
}

export interface TaskSnapshot {
  readonly ref: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly footprint: Footprint;
  readonly dependsOn: readonly string[];
  readonly exclusive: boolean;
  readonly workspace: string | null;
}

export interface Wave {
  readonly index: number;
  readonly tasks: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
}

export interface ParallelPlan {
  readonly waves: readonly Wave[];
  readonly diagnostics: readonly Diagnostic[];
}

export type WorkspaceDecision =
  | { kind: "reuse-current"; code?: string; reason: string }
  | { kind: "attach"; code?: string; path: string; branch: string; reason: string }
  | {
      kind: "create";
      code?: string;
      path: string;
      branch: string;
      base: string;
      reason: string;
    }
  | { kind: "refuse"; code: string; reason: string; next: string };

export interface TaskIndexEntry {
  taskRef: string;
  title: string;
  status: string;
  priority: string;
  footprint: readonly string[];
  dependsOn: readonly string[];
  owner: { type: "session" | "subagent" | "task"; id: string; sessionKey?: string } | null;
  workspace: string | null;
  updatedAt: string;
}

export interface TaskLease {
  taskRef: string;
  ownerType: "session" | "subagent" | "task";
  ownerId: string;
  sessionKey?: string;
  workspace: string;
  acquiredAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
}

export interface DispatchManifest {
  batch: string;
  tasks: ReadonlyArray<{
    taskRef: string;
    workspace: string;
    branch: string;
    lease: string;
    dependsOn: readonly string[];
    promptPrefix: string;
  }>;
}
```

### 18.2 端口

只保留三个真实替换点。不要为每个函数造接口。

```ts
export interface GitPort {
  status(cwd: string): { clean: boolean; dirtyPaths: number };
  branch(cwd: string): string;
  head(cwd: string): string;
  resolveRef(cwd: string, ref: string): string;
  isAncestor(cwd: string, ancestor: string, ref: string): boolean;
  isBare(cwd: string): boolean;
  isShallow(cwd: string): boolean;
  commonDir(cwd: string): string;
  mainWorktreeRoot(cwd: string): string;
  worktreeList(cwd: string): readonly WorktreeInfo[];
  worktreeAdd(opts: WorktreeAddOptions): void;
  worktreeRemove(opts: WorktreeRemoveOptions): void;
  rebase(cwd: string, onto: string): { ok: boolean; conflicts: readonly string[]; detail?: string };
  mergeFf(cwd: string, ref: string): { ok: boolean; detail?: string };
  fetch(cwd: string, remote: string, ref: string): { ok: boolean; detail?: string };
  push(cwd: string, remote: string, branch: string): { ok: boolean; detail?: string };
}

export interface ForgePort {
  readonly kind: "github" | "gitlab" | "generic";
  available(): boolean;
  createChangeRequest(opts: CreateChangeRequestOptions): { url: string } | null;
  viewChangeRequest(branch: string): ChangeRequestState | null;
  compareUrl(opts: CompareUrlOptions): string | null;
}

export interface LeaseStore {
  acquire(record: LeaseRecord): LeaseHandle | { busy: LeaseRecord };
  heartbeat(handle: LeaseHandle): void;
  release(handle: LeaseHandle): void;
  read(): LeaseRecord | null;
}
```

约定：

- `GitPort` 所有方法失败返回结构化结果或抛出带 `code` 的错误；不在 core 中打印。
- `ForgePort` 所有外部调用超时 3s；不可用返回 `null`，由上层降级。
- `LeaseStore` 只负责原子获取/心跳/释放；不解释业务状态。
- 时钟、hostname、PID 由 adapter 注入，不作为独立端口。

### 18.3 CLI JSON 契约

```jsonc
// parallel plan --json
{ "ok": true, "waves": [{ "index": 0, "tasks": ["..."], "reasons": { "...": "..." } }], "diagnostics": [] }

// parallel status --json
{ "ok": true, "tasks": [{ "ref": "...", "status": "...", "scope": "control-plane|branch-local",
  "workspace": "...", "owner": "...", "integration": { "outcome": "..." }, "queuePosition": 0 }],
  "runtime": { "sharedRoot": "...", "claim": {...}, "leases": [...] },
  "capabilities": { "coordinator": { "available": true, "reason": null } } }

// workspace prepare --json
{ "ok": true, "decision": { "kind": "create", "path": "...", "branch": "...", "base": "..." }, "claim": {...}, "lease": {...} }

// integrate --json
{ "ok": true, "mode": "local", "outcome": "landed", "baseSha": "...", "commit": "...",
  "prUrl": null, "conflict": null, "logPath": "...", "next": null }

// 统一错误
{ "ok": false, "code": "INTEGRATE_VERIFY_FAILED", "message": "...", "next": "...", "details": {...} }
```

## 19. 运行时文件 Schema

### 19.1 通用规则

- 所有 JSON 写入使用同目录 temp + rename；不跨文件系统。
- 锁文件用 `open('wx')` 创建，不用 rename 覆盖。
- 所有文件带 `schemaVersion`；未知版本拒绝并提示升级。
- 索引、registry 是可重建投影；丢失不阻塞主流程。
- `leases/` 文件名使用 task ref 的稳定短哈希，避免路径长度和非法字符。

### 19.2 `tasks.index.json`

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-28T10:00:00Z",
  "tasks": [
    {
      "taskRef": ".phronia/tasks/10-28-a",
      "title": "进度条状态不匹配",
      "status": "in_progress",
      "priority": "P1",
      "footprint": ["src/ui/progress/**"],
      "dependsOn": [],
      "owner": { "type": "subagent", "id": "agent-3", "sessionKey": "..." },
      "workspace": "/repo/.phronia/worktrees/a",
      "updatedAt": "2026-10-28T10:00:00Z"
    }
  ]
}
```

必填：`taskRef`、`title`、`status`、`priority`、`updatedAt`。其余缺失用默认值。重建来源：主 worktree + 各 worktree 的 `task.json`。

### 19.3 `leases/<hash>.json`

```json
{
  "schemaVersion": 1,
  "taskRef": ".phronia/tasks/10-28-a",
  "ownerType": "subagent",
  "ownerId": "agent-3",
  "sessionKey": "zcode:abc",
  "workspace": "/repo/.phronia/worktrees/a",
  "acquiredAt": "2026-10-28T10:00:00Z",
  "heartbeatAt": "2026-10-28T10:05:00Z",
  "ttlSeconds": 3600
}
```

### 19.4 `workspace.claim.json`

见 §4.6。必填：`ownerType`、`ownerRef`、`workspace`、`host`、`state`、`acquiredAt`、`heartbeatAt`、`ttlSeconds`。

### 19.5 `integration.lock` / `integration.json`

见 §3.2 / §7。`integration.lock` 必填 `phase`、`preLandSha`；`integration.json` 的 queue 只存等待条目。

### 19.6 `worktrees.json`

```json
{
  "schemaVersion": 1,
  "worktrees": [
    {
      "taskRef": ".phronia/tasks/10-28-a",
      "path": "/repo/.phronia/worktrees/a",
      "branch": "phronia/a",
      "kind": "phronia",
      "provisional": false,
      "createdAt": "2026-10-28T09:00:00Z"
    }
  ]
}
```

`kind`: `phronia | platform`。`provisional`: 任务尚未创建时为 `true`。

### 19.7 `batches/<id>.json`

```json
{
  "schemaVersion": 1,
  "id": "bedrock-20261028",
  "wave": 1,
  "tasks": [".phronia/tasks/10-28-a"],
  "maxConcurrent": 3,
  "createdAt": "2026-10-28T10:00:00Z",
  "manifestHash": "…",
  "workspaces": { ".phronia/tasks/10-28-a": "/repo/.phronia/worktrees/a" },
  "leases": { ".phronia/tasks/10-28-a": "lease-token" }
}
```

这是 coordinator 的**投影**，不是第二份事实来源；`coordinator status` 读取它做 batch 聚合，丢失可由 task index + leases 重建。`wave` 从 1 开始，与人类输出一致。

## 20. 状态机与并发规则

### 20.1 三个互斥

| 互斥 | 文件 | 回答的问题 | 获取方式 |
|---|---|---|---|
| task lease | `leases/<hash>.json` | 谁在做这个任务 | O_EXCL |
| workspace claim | `workspace.claim.json` | 主 checkout 归谁 | O_EXCL |
| integration lock | `integration.lock` | 谁在合入 | O_EXCL |

**固定获取顺序：task lease → workspace claim → integration lock。** 释放按相反顺序。任何代码路径不得反过来；这是死锁避免的唯一规则。

**默认 staleness 是 TTL-only。** `pid` 只用于诊断，不能作为短命 CLI 进程的存活依据；只有 integration lock 可以显式使用 `ttl-or-pid`。

### 20.2 workspace claim 状态

```
free
  --prepare/claim--> claimed(session)
claimed(session)
  --task create--> claimed(task)
  --release/TTL--> free / stale
claimed(task)
  --archive/release--> free
  --TTL--> stale
stale
  --owner completed/archived + clean--> free (auto reclaim)
  --owner in_progress/planning--> stale-owned (no auto reclaim)
  --dirty--> stale-dirty (no reclaim)
```

### 20.3 task lease 状态

```
free --acquire--> leased --release--> free
leased --TTL/heartbeat stale--> expired --reclaim--> free
```

- `expired` 不自动转给另一个 agent；orchestrator 必须显式 reclaim。
- reclaim 前检查 workspace 是否仍有该任务的未提交/未推送工作；有则提示，不静默覆盖。

### 20.4 integration 状态

```
idle --enqueue--> queued --acquire(claim+lock)--> landing
landing: acquiring -> rebasing -> verifying -> merging -> done
  rebasing conflict -> blocked_conflict -> (agent fix) -> landing
  verifying fail -> blocked_verify -> (fix) -> landing
  merging fail/base moved -> retry -> landing | blocked_race
  crash -> recover -> landing | landed | needs_human
done -> landed
```

注意：这些是**运行时 phase**，不写进 task.json。task.json 只写最终 outcome。

### 20.5 coordinator batch 状态

```
planning --dispatch--> running --drain--> draining --done--> done
running: tasks can be queued/running/blocked/landed
blocked task -> stays blocked; other tasks continue
new task added -> planning (re-plan) -> running
```

### 20.6 崩溃恢复矩阵

| 崩溃点 | 锁状态 | 恢复动作 |
|---|---|---|
| 获取 task lease 后、prepare 前 | lease 存在，workspace 未变 | 复用 lease；workspace prepare 重试 |
| 创建 worktree 后、登记 registry 前 | worktree 存在，registry 缺失 | `git worktree list` 重建；绑定任务 |
| rebase 中 | lock phase=rebasing，base=preLandSha | 重新 rebase；base 未动 |
| 验证中 | lock phase=verifying，base=preLandSha | 重新验证；base 未动 |
| ff 后、写 outcome 前 | lock phase=merging，base=postLandSha | 任务 commit 是 base 祖先 → 写 landed |
| 写 outcome 后、释放锁前 | lock 存在，outcome 已写 | 清理锁；不重复合入 |
| task lease 心跳失败 | lease 过期 | orchestrator 决定 reclaim 或标记 blocked |

## 21. 错误码与诊断

| Code | 含义 | 退出码 | `next` 示例 |
|---|---|---|---|
| `PARALLEL_DISABLED` | `parallel.enabled=false` | 2 | `set parallel.enabled: true` |
| `DEPENDENCY_MISSING` | `depends_on` 引用不存在 | 2 | 列出候选 task ref |
| `DEPENDENCY_CYCLE` | 依赖环 | 2 | 打印环路径，要求拆除 |
| `FOOTPRINT_UNKNOWN` | 未知足迹且未 `--allow-unknown` | 2 | `phronia task footprint set <ref> <dir>` |
| `WORKSPACE_CLAIM_BUSY` | 主 checkout 被占 | 3 | 显示占用者；建议 worktree 或等待 |
| `WORKSPACE_CLAIM_STALE_OWNED` | stale 但 owner 仍 in_progress | 3 | `workspace reclaim` 或保持 worktree |
| `WORKSPACE_CLAIM_STALE_DIRTY` | stale 且主 checkout 脏 | 3 | 不回收；用 worktree；提示旧占用者 |
| `WORKSPACE_DIRTY_UNCLAIMED` | 无 claim 但主 checkout 脏 | 3 | 用 worktree，或 `--reuse-dirty` |
| `WORKSPACE_WORKTREE_DISABLED` | `worktree=never` 但任务需要并行隔离 | 2 | 改 `auto/always`，或串行执行 |
| `WORKSPACE_SESSION_UNKNOWN` | 无法解析会话身份 | 2 | 传 `--session-key` 或设置 `PHRONIA_CONTEXT_ID` |
| `LEASE_OWNER_UNKNOWN` | task lease 缺少 ownerId/sessionKey | 2 | 传 `--owner-id` 或 `--session-key` |
| `WORKSPACE_ATTACH_INVALID` | 路径不是 worktree/分支不匹配 | 2 | 打印期望分支与实际分支 |
| `WORKSPACE_TARGET_EXISTS` | 目标路径已存在 | 2 | `worktree remove` 或换路径 |
| `TASK_ARTIFACTS_UNCOMMITTED` | 任务工件未进入集成分支 | 2 | 询问 scoped commit，或 `--copy-task` |
| `LEASE_BUSY` | 任务已被领取 | 3 | 显示 owner/workspace；换任务或等待 |
| `COMMIT_WRONG_WORKSPACE` | 在 main 替 worktree 任务提交 | 2 | 进入任务 worktree 再提交 |
| `INTEGRATE_LOCK_BUSY` | 合入锁被占 | 3 | `--queue`/`--wait` |
| `INTEGRATE_DIRTY_CHECKOUT` | 主 checkout/worktree 脏 | 2 | commit/stash；列出 dirty 文件 |
| `INTEGRATE_VERIFY_FAILED` | 验证失败 | 1 | 查看日志；修复后重试 |
| `INTEGRATE_CONFLICT` | rebase 冲突 | 1 | 分类 + 冲突文件 + handoff |
| `INTEGRATE_BASE_MOVED` | CAS 失败重试耗尽 | 1 | 重新 integrate |
| `INTEGRATE_NO_VERIFY` | 未配置验证且未 `--no-verify` | 2 | 配置 verify 或显式 `--no-verify` |
| `INTEGRATE_REMOTE_UNAVAILABLE` | 无 origin/离线 | 2 | `--mode local` |
| `INTEGRATE_REMOTE_UNSUPPORTED` | 有 origin 但无 forge CLI | 3 | 打印 compare URL + 手工命令 |
| `INTEGRATE_MODE_INVALID` | main 任务选 remote 等 | 2 | 改 local 或新工作区 |
| `COORDINATOR_UNSUPPORTED` | 平台不满足 parallel+per-task | 2 | 多会话/串行替代命令 |
| `COORDINATOR_DISPATCH_INVALID` | manifest/lease 不一致 | 2 | 重新 `lease acquire` |
| `RUNTIME_SHARED_UNAVAILABLE` | 无法解析 common dir | 2 | 检查 git 仓库/权限 |
| `CONFIG_INVALID` | 配置值非法 | 2 | 打印字段与合法值 |
| `GIT_UNAVAILABLE` | git 不存在/超时 | 2 | 检查 PATH/仓库 |

约定：所有错误同时输出 `code` 和 `next`；`--json` 用统一错误对象；不得只打印堆栈。实现可以在 `INTEGRATE_*` / `TASK_RECORD_*` 前缀下增加子错误码，但必须沿用相同的退出码映射并带 `next`。

## 22. 能力矩阵与降级

### 22.1 新增维度

```ts
export type SubagentExecution = "none" | "single" | "parallel" | "nested";
export type SubagentWorkspace = "none" | "inherited" | "per-task";
export type SubagentIdentity = "none" | "shared" | "isolated";
```

### 22.2 目标平台初始状态

Phase 0 已由 W0 完成首轮验证（见 `capability-report.md`）；未验证的维度仍标 `unknown`，不得标 `supported`。

| 平台 | subagentContext | execution | workspace | identity | coordinator |
|---|---|---|---|---|---|
| Claude Code | hook | nested | per-task | shared | coordinator（schema+docs，live 待跑） |
| Codex | hook | parallel | inherited | isolated | multi-session |
| ZCode | hook | parallel | inherited | isolated | multi-session |
| Cursor | hook | unknown | unknown | unknown | Phase 0 决定 |
| OpenCode | plugin | unknown | unknown | unknown | Phase 0 决定 |
| Kiro | hook | unknown | unknown | unknown | Phase 0 决定 |
| CodeBuddy | hook | unknown | unknown | unknown | Phase 0 决定 |
| Droid | hook | unknown | unknown | unknown | Phase 0 决定 |
| Pi | extension | unknown | unknown | unknown | Phase 0 决定 |
| OMP | extension | unknown | unknown | unknown | Phase 0 决定 |
| Snow | hook | unknown | unknown | unknown | Phase 0 决定 |
| Gemini | none | none | none | none | 不支持 |
| Copilot | none | none | none | none | 不支持 |
| Qoder | none | none | none | none | 不支持 |
| Trae | none | none | none | none | 不支持 |
| Grok | none | none | none | none | 不支持 |
| Kimi | none | none | none | none | 不支持 |
| DSH | none | none | none | none | 不支持 |
| Kilo | none | none | none | none | 不支持 |
| Antigravity | none | none | none | none | 不支持 |
| Devin | none | none | none | none | 不支持 |
| Reasonix | none | none | none | none | 不支持 |

### 22.3 降级矩阵

| execution | workspace | 推荐模式 |
|---|---|---|
| `parallel` | `per-task` | coordinator（原生） |
| `parallel` | `inherited` | 多会话：每个任务一个会话/worktree |
| `single` | 任意 | coordinator 串行子代理，或手工多会话 |
| `none` | 任意 | 纯 planner + 多会话；不提供 dispatch |

`subagentIdentity=shared` 时，所有命令必须显式 `--task`；不能依赖活动任务指针。

### 22.4 Phase 0 证据要求

每个标记为 `supported` 的维度必须有：

- 真实 harness 版本号；
- 执行命令/截图/日志；
- 至少一次正例和一次反例；
- 失败时的降级行为。

## 23. 模块依赖与文件所有权

### 23.1 依赖方向

```
core/task/*（纯策略）
  <- core/state/*（状态读取/路径）
  <- cli/adapters/*（git/forge/lease/runtime）
  <- cli/services/*（编排）
  <- cli/commands/*（参数/输出）
```

规则：

- `core` 不 import `cli`；不打印、不 `process.exit`、不读 `process.cwd()`。
- `adapters` 只 import core 的类型/纯函数；不 import commands。
- `services` 可以 import core + adapters；不直接解析 argv。
- `commands` 只做参数、输出、退出码；业务规则在 services/core。
- 禁止循环依赖；用 `pnpm typecheck` + eslint 规则检查。
- 新 core 公共 API 必须在 `packages/core/package.json` 显式导出（优先从 `./task` 子路径）。

### 23.2 工作流文件所有权（避免子代理冲突）

| 工作流 | 拥有文件 |
|---|---|
| W0 能力验证 | `capability-report.md`、能力矩阵草稿（不写生产代码） |
| W1 core 领域 | `packages/core/src/task/{parallel,integration,workspace,index-*}/**`、`packages/core/test/task/{parallel,integration-policy,workspace-policy,index-policy}.test.ts` |
| W2 共享运行时/适配器 | `packages/core/src/state/shared-runtime.ts`、`packages/core/src/state/config/readers.ts`、`packages/cli/src/adapters/**`、对应测试 |
| W3 CLI 基础命令 | `packages/cli/src/commands/{parallel,worktree,lease}.ts`、`packages/cli/src/services/{parallel,workspace,lease}.ts`、对应测试 |
| W4 合入/远端/冲突 | `packages/cli/src/commands/{integrate,commit}.ts`、`packages/cli/src/services/integrate.ts`、对应测试 |
| W5 coordinator | `packages/core/src/task/coordinator/**`、`packages/core/src/platform/{capabilities,features}.ts`、`packages/cli/src/commands/dispatch.ts`、`packages/cli/src/services/coordinator.ts`、对应测试 |
| W6 工作流/文档/归档 | `.phronia/workflow.md`、`.agents/skills/**`、`task_store.py` archive 守卫、`docs/**`、README |

跨流文件（`packages/cli/src/cli/index.ts`、`packages/core/src/task/index.ts`、`package.json` 导出）由当前会话在集成时统一修改，避免多个子代理同时改同一文件。

## 24. 测试与验收映射

### 24.1 测试层级

| 层级 | 范围 | 工具 |
|---|---|---|
| Unit | 纯策略：footprint/overlap/graph/planner/policy/state machine | Vitest，无 IO |
| Integration | 临时 git 仓库、linked worktree、bare origin、mock forge、fault injection | Vitest + `mktemp` |
| E2E | 当前仓库 dogfood、真实 harness 手工验证 | 脚本 + 手工 |

### 24.2 必测矩阵

| 模块 | Unit | Integration | E2E |
|---|---|---|---|
| footprint/overlap | 10 种路径组合 | — | — |
| graph/planner | 依赖/环/wave | — | — |
| claim/lease | stale/并发 | 双进程 O_EXCL | — |
| workspace | 决策矩阵 | prepare/attach/provisional | 平台原生 attach |
| integrate | 状态机/分类 | 并发/回滚/recover | 无远端完整流程 |
| remote | 模式解析 | mock gh/compare URL | 真实 forge（可选） |
| conflict | 分类矩阵 | generated/duplicate/semantic | 手工语义冲突 |
| coordinator | capability gate/batch | dispatch manifest/新任务/失败 | 真实 harness |

### 24.3 验收映射

PRD 的 `Acceptance Scenarios` 每条至少对应一个 integration 测试；无法自动化的（平台能力、交互）标记为 manual，并在 Phase F dogfood 中执行。

## 25. 非功能性设计

### 25.1 超时与重试

| 操作 | 超时 | 重试 |
|---|---|---|
| git status/rev-parse | 3s | 0 |
| git worktree add/remove | 15s | 0 |
| git fetch/push | 60s | 0（用户重试） |
| forge CLI | 3s 探测；30s 建单 | 0 |
| verify 命令 | `parallel.integration.timeout`（默认 30m） | 0 |
| 锁获取 | 立即失败或 `--wait` 超时 | `--wait` 轮询 |

### 25.2 原子写入与锁

- JSON：同目录 temp + `rename`。
- 锁：`open('wx')`；心跳用 temp+rename 更新内容。
- Windows：关闭句柄再 unlink；路径 `path.resolve`。
- 任何写入失败都返回结构化错误，不留半文件。

### 25.3 日志与脱敏

- 验证/合入日志写到主 worktree `.phronia/.runtime/integration-logs/`。
- 单文件默认上限 10 MB，超出保留尾部。
- handoff/日志/PR body 脱敏：token、`*_TOKEN`、`*_KEY`、`*_SECRET`、完整私有 URL。
- 不记录环境变量全量；只记录命令名和退出码。

### 25.4 路径与安全

- task ref / path 参数拒绝 `..`、绝对路径越界（显式 `--path` 除外）。
- worktree 路径必须在仓库根或配置的 `parallel.worktree.dir` 下。
- 不使用 shell 拼接；所有 git/forge 调用用 `execFile`。
- 远端 push 前不自动配置凭证；失败原样输出。

### 25.5 性能预算

- `parallel plan` 100 任务 < 1s（不含 git 读取）。
- `parallel status` 20 worktree < 2s。
- claim/lease 获取 < 100ms。
- 索引重建 20 worktree < 2s；超过时输出 progress。

### 25.6 可观测性

- `parallel status --json` 暴露 sharedRoot、claim、leases、queue、capabilities。
- `doctor` 增加 parallel/coordinator 检查：shared runtime 可写、git 可用、forge 可用、capability gate。
- 每个错误有 `code` 和 `next`；日志路径可点击。

### 25.7 迁移

- 旧 registry 迁移：读旧位置，写新位置，冲突时以 git worktree list 为准。
- `task.json.worktree_path/branch` 只读兜底；新写入不再更新。
- 配置只新增 `parallel.*`；旧配置无影响。
- 回滚：删除新命令/关闭开关；旧字段仍可读。
