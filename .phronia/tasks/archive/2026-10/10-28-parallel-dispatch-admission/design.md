# 技术设计：并行执行准入控制（Dispatch Admission）

> 版本：v1（2026-10-28）
> 前置设计：`.phronia/tasks/archive/2026-10/10-28-parallel-task-execution/design.md`
> 运行契约：`.phronia/spec/cli/backend/parallel-tasks.md`

## 0. 一句话结论

并行执行缺的不是 worktree 原语，而是**派发边界的准入决策**。本设计新增第四个纯决策函数 `evaluateDispatch`，把它接在 `buildSubagentSpawn` 上，并用一个新的平台能力维度决定"阻断 / 注入守卫"，同时补齐事实层、breadcrumb、planner 容器语义、`task.py start` 门禁和会话身份桥。

## 1. 设计原则

1. **决策与 IO 分离**：判定是纯函数；事实读取是只读适配层；渲染是 shim 的职责。与现有 `decideWorkspace` / `planParallel` / `canRunCoordinator` 完全同构。
2. **窄而硬，宽而软**：只对结构性错误 block；对"可能但不一定"的风险注入守卫。默认不破坏单任务串行路径。
3. **能力下沉，平台分支上浮**：核心不写 `if (platform === "zcode")`；平台差异只存在于能力矩阵和 shim 的 envelope 渲染。
4. **降级必须可见**：不能阻断时不能假装允许；必须注入守卫、产生诊断、在 `doctor`/`platforms` 里显示。
5. **事实只有一份**：task.json（意图）、`<git-common-dir>/phronia/`（运行时）、git（分支/工作树）三者的读取复用现有模块，不新建第二套状态。
6. **可回退**：所有阻断都能通过配置降级；所有新增都是附加的，不改现有数据格式。

### 1.1 证明强度：block 只用于可证明的违规

准入判定不是"策略偏好"，而是"事实推理"。规则按可证明性分两档：

| 档位 | 含义 | 处理 |
|---|---|---|
| **proven violation** | 事实直接违反不变量，例如父任务是实现目标、任务已有 worktree 但 cwd 是 main、main 的 claim 属于另一个任务 | block |
| **unproven ownership** | 没有证据表明独占，但也没有证据表明冲突，例如 main 没有 claim | allow + 显式警告 |

为什么"没有 claim"不 block：

- claim 证明的是**跨会话互斥**；没有 claim 只能说明"无法证明没有第二个会话"，不能说明"有第二个会话"。
- 把"未证明"当"已违规"会让所有首次使用、所有 degraded 模式（Windows / resume / hooks disabled）在第一次派发时失败，用户会直接关闭 hook——那是比误放行更糟的终态。
- 但"未证明"也不能静默：守卫块把 `claim: none` 直接写进 prompt，模型和用户都能看到；下一次 `workspace ensure` 就会补上。

因此本设计不是"先放行、以后收紧"的补丁，而是**两档证明强度**的终态：可证明的违规硬拒绝，不可证明的归属软提示。任何新增规则都必须先回答"它属于哪一档、证据是什么"。

## 2. 现状与缺口

### 2.1 四个决策函数

```text
decideWorkspace(task, ctx)      → reuse-current | attach | create | refuse      （已有）
planParallel(tasks, opts)       → waves + reasons                              （已有）
canRunCoordinator(capabilities) → available | fallback                         （已有）
evaluateDispatch(facts)         → allow | block + next                         （本设计新增）
```

前三个分别回答"在哪里"、"哪些能同批"、"平台能不能自动派发"。第四个回答"**这一次派发现在能不能发生**"。没有它，前三者的约束都可以被"直接调用 harness 原生子代理"绕过。

### 2.2 调用链现状

```text
ZCode PreToolUse(Agent|Task)
  → .zcode/plugins/phronia/hooks/bridge.mjs
    → phronia hook --platform zcode --event subagent-spawn
      → .zcode/hooks/phronia-hook.py
        → phronia context --event subagent-spawn --json
          → buildSubagentSpawn()          ← 只解析活动任务 + 注入上下文
        → _render_mutation()              ← 永远 permissionDecision:"allow" + updatedInput
```

缺口的精确位置：`buildSubagentSpawn` 在 `packages/core/src/context/subagent/index.ts:59`，它调用 `state.sessions.active()` 和 `state.tasks.read()`，但从不读取 claim / lease / worktree registry，也不检查 `children`、`status`、checkout 身份。

### 2.3 为什么事实层要放在 core

`packages/core/src/state/shared-runtime.ts` 已经有纯路径计算（`sharedRuntimePaths`、`taskLeasePath`、`resolveCommonDir`），`packages/core/src/state/git.ts` 已经有 `GitExec` 注入和 `mainWorktreeRoot`。缺的只是"读文件 + 组装事实"这一层，它属于 `state/`（只读状态层），不属于 `task/`（纯领域），也不属于 CLI。

## 3. 分层与模块

```text
packages/core/src/
  state/
    runtime-facts.ts          # 新增：只读事实（claim/lease/worktrees/checkout）
    git.ts                    # 扩展：gitCommonDir()
    session/tickets.ts        # 扩展：phronia CLI 的 ticket 匹配
    config/readers.ts         # 扩展：parallel.dispatch.enforce
  task/
    dispatch/
      types.ts                # 新增：DispatchFacts / DispatchVerdict / codes
      policy.ts               # 新增：evaluateDispatch()（纯函数）
    parallel/
      types.ts                # 扩展：PlannerTask.container / childCount
      planner.ts              # 扩展：容器不进入 wave
  context/
    types.ts                  # 扩展：Mutation 增加 deny
    subagent/
      facts.ts                # 新增：把 state+runtime 映射成 DispatchFacts
      guard.ts                # 新增：verdict → deny mutation / WORKSPACE_GUARD 块
      index.ts                # 接入：先准入，再物化上下文
    user-prompt.ts            # 扩展：runtime-state 块
    session-start.ts          # 扩展：current-state 的 workspace 行
  platform/
    capabilities.ts           # 扩展：hookPolicy

packages/cli/src/
  services/
    workspace.ts              # 扩展：openState 传 argv；错误给可执行 session key
    lease.ts                  # 同上
    parallel.ts               # 扩展：container 标记 + 父任务提示
  commands/doctor.ts          # 扩展：task.dispatchAdmission
  templates/
    shared-hooks/phronia-hook.py
    opencode/adapters/v1/plugins/inject-subagent-context.js
    _generated/shims/**       # 由 build:shims 重新生成

.phronia/scripts/task.py      # 扩展：start 父任务门禁 + --coordinator
```

依赖方向：

```text
task/dispatch   ←  context/subagent   ←  shim
      ↑                   ↑
task/parallel    state/runtime-facts
      ↑                   ↑
      └──── state/git ────┘
```

`task/dispatch` 只依赖 `state/diagnostics`（类型）；`state/runtime-facts` 不依赖 `task/dispatch`，返回中性事实；映射在 `context/subagent/facts.ts`。

## 4. 领域契约

### 4.1 代理分类

```ts
export type AgentMutation = "mutating" | "read-only" | "unknown";
```

| 输入 | 分类 | 依据 |
|---|---|---|
| `phronia-implement`, `phronia-check`, `trellis-*` | `mutating` | 实现/自修复会写文件 |
| `phronia-research` | `read-only` | 只读调研 |
| `session` | `read-only` | 只物化上下文，不派发工作 |
| 其它/未知 | `unknown` | 不在 Phronia 契约内 |

只有 `mutating` 走完整判定；`read-only` 直接 allow；`unknown` 在 v1 中直接 allow（不做跨平台猜测），诊断记录 `DISPATCH_OUTSIDE_CONTRACT`。

### 4.2 DispatchFacts

```ts
export interface DispatchFacts {
  readonly platform: {
    readonly id: PlatformId;
    readonly hookPolicy: HookPolicy;         // block | inject | unknown
    readonly subagentWorkspace: SubagentWorkspace;
  };
  readonly agent: AgentMutation;
  readonly enforce: "block" | "warn" | "off";

  /** 会话当前指向的任务（可能为 null）。 */
  readonly activeTaskRef: string | null;
  /** prompt/tool_input 显式声明的任务（`Active task:` 首行或 task_ref 字段）。 */
  readonly requestedTaskRef: string | null;
  /** 判定对象：requested ?? active。 */
  readonly effectiveTask: TaskFacts | null;
  readonly checkout: {
    readonly root: string;                   // projectRoot（hook 的 .phronia 根）
    readonly mainRoot: string | null;
    readonly isLinkedWorktree: boolean;
    readonly branch: string;
    /** 当前 cwd 在 worktree registry 里登记的任务，null 表示未登记。 */
    readonly registeredTaskRef: string | null;
    /** mainRoot 是否有未提交改动；null 表示读取失败。 */
    readonly mainDirty: boolean | null;
  };

  readonly workspace: {
    /** 有效任务是否已有自己的 worktree。 */
    readonly taskWorktree: string | null;
    readonly taskBranch: string | null;
  } | null;

  readonly claim: ClaimFacts | null;         // workspace.claim.json（main checkout）
  readonly lease: LeaseFacts | null;         // leases/<hash>.json（有效任务）
  readonly siblings: {
    readonly total: number;
    readonly inProgress: number;
    readonly planning: number;
  } | null;
  readonly factsReliable: boolean;           // 读取失败时为 false
}

export interface TaskFacts {
  readonly ref: string;
  readonly id: string;
  readonly status: string | null;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly branch: string | null;
  readonly parallel: {
    readonly worktree: "auto" | "always" | "never" | null;
    readonly exclusive: boolean;
    readonly dependsOn: readonly string[];
  };
}

export interface ClaimFacts {
  readonly taskRef: string | null;
  readonly ownerRef: string;
  readonly sessionKey: string | null;
  readonly stale: boolean;
  readonly heartbeatAt: string | null;
}

export interface LeaseFacts {
  readonly ownerType: "session" | "subagent" | "task";
  readonly ownerId: string;
  readonly sessionKey: string | null;
  readonly stale: boolean;
}
```

**必须解析两次活动任务。** `state.sessions.active(input, {taskRef})` 会用显式 ref 覆盖会话指针；如果只调用一次，就丢掉了"会话当前是谁"，`DISPATCH_TASK_NOT_CHILD` 无法实现。事实层必须：

```ts
const sessionActive  = state.sessions.active(input, { platform });             // 会话指针
const effectiveActive = state.sessions.active(input, { platform, taskRef });   // 显式 ref 优先
```

`activeTaskRef = sessionActive.taskPath`，`effectiveTaskRef = effectiveActive.taskPath`。`requestedTaskRef` 只来自 payload/prompt，不由 `sessionActive` 推断。

### 4.3 DispatchVerdict

```ts
export interface DispatchVerdict {
  readonly decision: "allow" | "block";
  readonly code: DispatchCode;
  readonly severity: "info" | "warn" | "error";
  readonly reason: string;
  /** 可直接执行的命令，顺序稳定。 */
  readonly next: readonly string[];
  /** deny 时的结构化事实，供 shim/审计使用。 */
  readonly details: Readonly<Record<string, unknown>>;
  /** allow 时附加的守卫块（可能为空）。 */
  readonly guard: GuardBlock | null;
}

export interface GuardBlock {
  readonly code: DispatchCode;
  readonly severity: "info" | "warn" | "error";
  readonly lines: readonly string[];   // 已排版，直接拼进 prompt
}
```

### 4.4 错误码

稳定、英文、大写；`next` 永远是可直接执行的命令。

| 码 | 决策 | 触发条件 |
|---|---|---|
| `DISPATCH_PARENT_TASK` | block | 有效任务 `children.length > 0`，agent 为 mutating |
| `DISPATCH_TASK_NOT_IN_PROGRESS` | block | 有效任务状态不是 `in_progress`（planning/blocked/completed） |
| `DISPATCH_TASK_NOT_CHILD` | block | 显式 ref 既不是活动任务本身，也不是其子任务 |
| `DISPATCH_WRONG_CHECKOUT` | block | 有效任务已有 worktree，但 checkout root 不是它 |
| `DISPATCH_CHECKOUT_OWNED_BY_OTHER` | block | checkout 是 linked worktree，且 registry 登记在另一个任务名下 |
| `DISPATCH_ISOLATION_REQUIRED` | block | 任务要求隔离，但 checkout 是 main |
| `DISPATCH_MAIN_CLAIMED` | block | main 的 claim 属于另一个任务或另一个未过期会话 |
| `DISPATCH_STALE_CLAIM_DIRTY` | block | main 的 claim 已过期，但 main 有未提交改动 |
| `DISPATCH_NO_CLAIM` | allow + guard | main 未被有效任务认领 |
| `DISPATCH_LEASE_OTHER_OWNER` | allow + guard | 有效任务的 lease 属于另一个未过期会话 |
| `DISPATCH_NO_ACTIVE_TASK` | allow（诊断） | 无法解析任何任务；保持 pull-based 降级 |
| `DISPATCH_ISOLATION_DISABLED` | allow + guard | 需要隔离但 `parallel.worktree=never` |
| `DISPATCH_CHECKOUT_UNREGISTERED` | allow + guard | cwd 是 linked worktree，但未在 registry 登记 |
| `DISPATCH_PLATFORM_CANNOT_BLOCK` | allow + guard | 判定为 block，但平台 `hookPolicy != block` 或 `enforce=warn` |
| `DISPATCH_FACTS_UNRELIABLE` | allow + guard | 事实读取部分失败 |
| `DISPATCH_OUTSIDE_CONTRACT` | allow（诊断） | 非 Phronia 代理或 read-only |
| `DISPATCH_OK` | allow | 满足全部前置条件 |

### 4.5 判定顺序（first match wins）

顺序本身是契约；改变顺序会改变错误码，必须在测试里锁死。

```text
1. agent != mutating                      → DISPATCH_OUTSIDE_CONTRACT (allow)
2. enforce == off                         → dispatch ok (diagnostic only)
3. effectiveTask == null                  → DISPATCH_NO_ACTIVE_TASK (allow, diagnostic; no guard)
   （会话指针 stale 时按 null 处理，绝不拿一个失效的父任务去 block）
4. requested != null && requested != active
   && requested.parent != active.ref      → DISPATCH_TASK_NOT_CHILD (block)
5. effective.children.length > 0          → DISPATCH_PARENT_TASK (block)
6. effective.status != "in_progress"      → DISPATCH_TASK_NOT_IN_PROGRESS (block)
7. checkout.isLinkedWorktree:
   7a. registeredTaskRef != null
       && registeredTaskRef != effective.ref → DISPATCH_CHECKOUT_OWNED_BY_OTHER (block)
   7b. taskWorktree != null
       && taskWorktree != checkout.root     → DISPATCH_WRONG_CHECKOUT (block)
   7c. registeredTaskRef == null            → DISPATCH_CHECKOUT_UNREGISTERED (allow+guard)
   7d. otherwise                           → continue
8. checkout is main:
   8a. taskWorktree != null                → DISPATCH_WRONG_CHECKOUT (block)
   8b. requiresIsolation && worktree==never → DISPATCH_ISOLATION_DISABLED (allow+guard)
   8c. requiresIsolation                    → DISPATCH_ISOLATION_REQUIRED (block)
   8d. claim != null && !claim.stale:
        claim.taskRef == effective.ref      → continue
        claim.sessionKey == currentSession  → continue
        otherwise                            → DISPATCH_MAIN_CLAIMED (block)
   8e. claim != null && claim.stale && mainDirty
                                            → DISPATCH_STALE_CLAIM_DIRTY (block)
   8f. claim == null || claim.stale         → DISPATCH_NO_CLAIM (allow+guard)
9. lease != null && !lease.stale
   && lease.sessionKey != currentSession
   && lease.ownerId != currentOwner       → DISPATCH_LEASE_OTHER_OWNER (allow+guard)
10. otherwise                            → DISPATCH_OK (allow)
```

`requiresIsolation`：

```ts
task.parallel.worktree === "always"
|| task.parallel.exclusive === true
|| siblings.inProgress >= 2
```

`requiresIsolation` 不看 `touches`：声明足迹只说明"可以并行"，不说明"正在并行"。父任务的 `meta.parallel.worktree=always` 也向下继承。

**ref 比较必须规范化。** `task.json.parent` / `children` 可能是目录名（`10-28-foo`）、相对路径（`.phronia/tasks/10-28-foo`）或绝对路径。判定前统一用 `canonicalTaskRef` / `taskRefsMatch`（`packages/core/src/state/tasks/refs.ts`），不要做字符串相等。父任务识别用 `children.length > 0`，不依赖 `parent` 字段。

### 4.6 为什么这些规则是安全的

| 规则 | 防止的事故 | 为什么不会误伤 |
|---|---|---|
| `DISPATCH_PARENT_TASK` | 父任务的 PRD 被当作实现规格，多个子任务共用一个 base | 父任务没有任何合法实现场景；协调用途通过 `--coordinator` 只影响 `task.py start`，不影响派发 |
| `DISPATCH_TASK_NOT_IN_PROGRESS` | `planning` 任务被实现，验收标准未定 | 工作流本来就要求先知会用户再 start；`enforce=warn` 可放行 |
| `DISPATCH_TASK_NOT_CHILD` | 会话 A 的实现代理读到任务 B 的上下文并改 B 的文件 | 协调场景下显式 `Active task: <child>` 是唯一合法跨任务通道 |
| `DISPATCH_WRONG_CHECKOUT` | 任务代码写进 main，worktree 永远为空 | 任务已有 worktree 时，唯一正确 cwd 就是它 |
| `DISPATCH_CHECKOUT_OWNED_BY_OTHER` | 两个任务在同一 worktree 里互相覆盖 | 一个 worktree 一条分支，git 本身也不允许两个分支同时检出 |
| `DISPATCH_ISOLATION_REQUIRED` | 两个 in_progress 子任务在 main 里并发编辑 | 只有确实存在并行意图时才触发；串行子任务仍是 1 个 in_progress |
| `DISPATCH_MAIN_CLAIMED` | 上一会话未释放的 claim 被无声抢占 | TTL 过期后不 block；stale + dirty 时要求显式 reclaim |
| `DISPATCH_STALE_CLAIM_DIRTY` | 上一个任务留下的未提交改动被新任务混入 | 与 `decideWorkspace` 的"stale-dirty 绝不自动回收"一致；提交/暂存或显式 reclaim 即可解除 |
| `DISPATCH_NO_CLAIM` 只警告 | 首次使用/单任务的最常见路径 | 保持 allow，避免把所有人挡在门外 |

## 5. 事实层

### 5.1 新增 `state/runtime-facts.ts`

只读、容错、可注入：

```ts
export interface RuntimeFactsOptions {
  readonly root: string;
  readonly exec?: GitExec;
  readonly io?: FsLike;
  readonly now?: number;          // epoch seconds
}

export interface RuntimeFacts {
  readonly mainRoot: string | null;
  readonly isLinkedWorktree: boolean;
  readonly branch: string;
  readonly claim: ClaimRecord | null;
  readonly worktrees: readonly WorktreeRecord[];
  readonly leases: readonly LeaseRecord[];
  readonly diagnostics: readonly Diagnostic[];
}
```

实现要点：

- **纯文件系统快路径**：先读 `<root>/.git`。目录 → `commonDir = <root>/.git`；文件 → 解析 `gitdir: <path>`，再读 `<gitdir>/commondir`（存在则解析，否则等于 gitdir）。`toplevel = root`；分支从 `<gitdir>/HEAD` 的 `ref: refs/heads/<name>` 读取。标准 checkout 与 linked worktree 都 **零 git 进程**。
- **git 兜底**：`.git` 缺失、不可读或布局非常规（bare、submodule `modules`、commonDir 不以 `.git` 结尾）时，只调用一次 `git rev-parse --git-common-dir --show-toplevel`（两行），再用 `resolveCommonDir` 解析；不要调用 `branch --show-current`。
- `paths = sharedRuntimePaths(commonDir)`；只读 `workspaceClaim`、`worktrees`、`leases/*.json`。
- 所有 JSON 用 `readJson`（容错），校验 `schemaVersion`（`isSupportedSchemaVersion`），未知版本视为不可靠。
- worktree 所属任务：按路径 `realpath` 比较，`taskRef` 为空/`provisional` 视为未登记。
- **登记的 worktree 路径不存在时，视为未登记**并产生 `state.runtime.worktree_missing` 诊断；不要用它触发 `DISPATCH_WRONG_CHECKOUT`，否则一个删掉的目录会把任务永久锁死。`next` 给出 `phronia task worktree prune` 或重新 `ensure`。
- **`mainDirty` 按需读取**：`readRuntimeFacts({includeMainDirty})` 默认 `true`；breadcrumb 显式传 `false`，永远不跑 `git status`。dispatch 事实用默认值，且只有读到 claim 时才跑 `git status --porcelain`。没有 claim 时 `mainDirty=null` 是预期值，不是不可靠；有 claim 且 status 失败时 `factsReliable=false`（不能让 stale-claim 决策静默穿透）。
- **成本**：标准 checkout + 无 claim = 0 次 git 进程；有 claim 时 +1 次 `status`；非常规布局 +1 次 `rev-parse`。见 §5.3。

### 5.2 与 CLI 适配器的关系

`packages/cli/src/adapters/shared-runtime.ts` 继续负责写（registry、claim、log）。`state/runtime-facts.ts` 只读。两者共用 `sharedRuntimePaths` 与 `taskLeasePath`，不会产生第二套路径规则。

### 5.3 git 调用预算

初版实现用 4 次 git spawn，本机实测 `readRuntimeFacts` 中位数 **81.6ms**（git 17ms/次，status 39ms），远超 user-prompt 的 25ms 预算。**这不是可以接受的终态。**

终态：

| 场景 | git 进程 |
|---|---|
| 标准 checkout + 无 claim（每轮最常见） | 0 |
| 标准 checkout + 有 claim | 1（`status --porcelain`） |
| linked worktree + 无 claim | 0 |
| 非常规布局 | 1（`rev-parse --git-common-dir --show-toplevel`）+ 可能 1 次 status |

分支从 `HEAD` 文件读，不再 spawn `git branch`。目标：`readRuntimeFacts` 中位数 ≤10ms；bench 门槛保持 25ms。

`mainRoot` 可由 `commonDir` 推导：`commonDir` 的父目录就是 main 工作树根（当 `commonDir` 以 `/.git` 结尾时），否则用 `worktree list` 首行兜底。避免为 hook 增加第 3、4 次 git 调用。实现时先在 `bench/hook-bench.mjs` 记录基线，目标：subagent-spawn 增量 ≤ 30ms。

> 注意：`mainWorktreeRoot` 有模块级缓存，测试必须调用 `resetGitCache()`；新的 `gitCommonDir` 不要引入跨进程缓存（hook 是一次性进程）。

### 5.4 失败模式

| 失败 | 行为 |
|---|---|
| 不是 git 仓库 | `factsReliable=false`，`DISPATCH_FACTS_UNRELIABLE` allow+guard |
| `rev-parse` 超时（3s） | 同上 |
| claim/worktrees JSON 损坏 | 对应字段 null + 诊断；不 block |
| lease 目录不可读 | lease=null + 诊断；不 block |
| task.json 读取失败 | `effectiveTask=null` → `DISPATCH_NO_ACTIVE_TASK` allow（诊断，无守卫） |

原则：**读取失败不能变成"安全通过"的借口，也不能变成"全部拒绝"的地狱。** 前者靠 guard 显式暴露，后者靠不 block。

## 6. 平台能力与渲染

### 6.1 新能力维度

```ts
export type HookPolicy = "block" | "inject" | "unknown";

export interface PlatformCapabilities {
  // ...existing
  /** Whether a PreToolUse-equivalent hook can prevent the action. */
  readonly hookPolicy: HookPolicy;
}
```

初始值（必须与 `research/prior-art.md` 的证据一致）：

| 平台 | hookPolicy | 依据 |
|---|---|---|
| claude-code | `block` | 官方文档：exit 2 / `permissionDecision:"deny"`；hook 必须同步 |
| zcode | `block` | 真实运行验证（2026-10-28，3.16.3）：Agent 工具返回 `state.status=error`，未创建子会话；deny 以工具错误结果交付 |
| opencode | `block` | `tool.execute.before` 抛错中止 |
| codex | `inject` | `SubagentStart` 不可阻断 |
| cursor | `unknown` | `preToolUse` 存在，deny 形状未验证 |
| 其它有 subagent hook 的 | `unknown` | 未验证 |
| 无 subagent hook 的 | `inject`（实际上永远走不到判定） | `subagentContext.kind === "none"` |

`unknown` 的渲染行为与 `inject` 相同，但诊断文案不同（"未验证" vs "平台不支持"）。

**ZCode 的 deny 交付通道（重要）。** 实测结果是：`permissionDecision:"deny"` 会阻止派发（不创建子会话），但父模型收到的不是权限层拒绝，而是 Agent 工具的结果：

```json
{ "state": { "status": "error", "error": "ZCODE_DENY_PROBE: ... Do not retry; report this exact message." } }
```

这带来两条实现约束：

1. `permissionDecisionReason` 必须**自包含**：错误码、原因、`next`、以及 "Do not retry; report this exactly"。父模型不会看到权限弹窗，只会看到这段文本。
2. 不要依赖 `updatedInput`：deny 时 ZCode 会丢弃 `modifiedInput`，所以子代理既不会运行，也不会收到 guard。guard 只用于 allow + 风险场景。

UI 仍会先渲染子代理卡片，那是工具调用的可视化，不是子代理已运行的证据；判定以 `part.state.status` 和 `session.parent_id` 为准。

### 6.2 Mutation

```ts
export type Mutation =
  | { op: "set-prompt"; value: string; marker: string }
  | { op: "prepend-prompt"; value: string; marker: string }
  | { op: "set-env"; name: string; value: string }
  | { op: "deny"; code: string; reason: string; next: readonly string[] };
```

deny 是一个**中立的决定**，不是 envelope；由 shim 翻译成平台的拒绝形状。

### 6.3 渲染矩阵

| 平台 | deny 渲染 |
|---|---|
| ZCode | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>\n<next>\nDo not retry; report this exactly."}}`；实测以 Agent 工具的 `state.status=error` 交付 |
| Claude Code | 同 ZCode（Claude 兼容形状） |
| OpenCode | `throw new Error("[<code>] <reason>\n<next>")`（在 `tool.execute.before` 内） |
| Codex | 不输出 deny；把 `WORKSPACE_GUARD` 前置到 `additionalContext` |
| Cursor / 未验证 | 不输出 deny；守卫块走 `additionalContext` 或 `updatedInput.prompt` |

渲染规则：

- deny 时**不得**同时输出 `updatedInput`（避免模型以为 prompt 已被接受；ZCode 也会丢弃 `modifiedInput`）。
- allow 时保持现有 `permissionDecision:"allow"` + `updatedInput`，不改用户已有权限流。
- `reason` 必含错误码、任务、缺失条件和 `next` 的第一条命令；详细列表放在 `permissionDecisionReason` 的多行文本里。
- `reason` 末尾固定追加 `Do not retry; report this exactly.`：ZCode 把 deny 作为 tool error 返回，父模型只看到这段文本。
- `renderContext()` 的 `mutation-plan` envelope 同步支持 deny，保证 `--render` 与 shim 行为一致。

### 6.4 降级矩阵

| 判定 | hookPolicy=block | hookPolicy=inject/unknown | enforce=warn | enforce=off |
|---|---|---|---|---|
| block | deny | allow + guard（`PLATFORM_CANNOT_BLOCK`） | allow + guard | allow，无 guard |
| allow + guard | allow + guard | allow + guard | allow + guard | allow，无 guard |
| allow | allow | allow | allow | allow |

## 7. 守卫块

### 7.1 格式

```text
<workspace-guard code="DISPATCH_NO_CLAIM" severity="warn">
task: .phronia/tasks/10-28-join-code-only (in_progress)
active: .phronia/tasks/10-28-backlog-batch (parent, children 6)
workspace: main (unclaimed)
claim: none
lease: none
parallel: 1 in_progress child (planning 5)
risk: main is not claimed; a second session or a parallel implement sub-agent will share this tree
next:
  1. phronia task workspace ensure .phronia/tasks/10-28-join-code-only --json
  2. re-dispatch implement after the workspace is recorded
</workspace-guard>
```

### 7.2 放置位置

- **注入路径**：守卫块放在最终 prompt 的最前面（`buildImplementPrompt` 的 `<!-- phronia-hook-injected -->` 之前），因为模型对开头最敏感。
- **deny 路径**：完全替换 prompt，不再注入 PRD；deny 原因本身就是给模型的指令。
- **不重复**：同一 dispatch 只输出一个守卫块；多个条件合并到 `code`（主因）+ `also:` 行（次因）。

### 7.2.1 触发条件（防止误伤非派发事件）

`handleContext` 在 `pre-tool-use` 且 payload 没有 `tool_name` 时会回落到 `buildSubagentSpawn`。准入判定只在该请求确实是**子代理派发**时执行：

```ts
const isDispatch =
  request.event === "subagent-spawn"
  || (request.event === "pre-tool-use" && toolName ∈ toolNames.subagent)
  || (request.event === "pre-tool-use" && payloadCarriesAgentType(request.input));
```

`payloadCarriesAgentType` 只接受 `readAgentType()` 能从 payload 解析出值的场景（Kiro/Gemini 的顶层 agent 字段）。否则不判定、不 deny，保持现有行为。

### 7.3 内容契约

必须包含：

1. 错误码；
2. 有效任务 ref + 状态；
3. 活动任务（若不同）；
4. `workspace / claim / lease / parallel` 四行事实；
5. 一条具体的风险说明；
6. 按顺序的 `next` 命令；
7. 平台限制（仅当 `hookPolicy != block`）：
   ```text
   platform: zcode (subagentWorkspace=inherited)
   this harness cannot dispatch into a different checkout; use multi-session:
     1. ... workspace ensure
     2. open a new ZCode window in <path>
     3. first line: Active task: <ref>
     4. phronia task integrate <ref> when done
   ```

**不可阻断平台的额外要求**：当 block 被降级为守卫（`hookPolicy != block`）时，守卫块的第一行必须是停止指令，而不是建议：

```text
STOP: do not edit any file until the workspace contract is satisfied.
You are already running in the parent checkout; report this guard to the parent session.
```

原因：Codex `SubagentStart` 这类"先派发、后注入"的平台上，子代理已经在运行。守卫块是最后一道防线，必须让子代理自己停下，否则"降级"等于放行。

## 8. Breadcrumb 可观测性

### 8.1 新块

在 `buildUserPrompt` 中追加独立块 `runtime-state`（不修改 workflow.md 生成的 breadcrumb 文本，避免污染用户可编辑内容）：

```text
<runtime-state>
workspace: main (unclaimed) | worktree <path> | none | unknown (read failed)
claim: task <ref> | session <ref> | none
lease: session <ref> | subagent <ref> | none
parallel: serial | 2 in_progress children (planning 4)
next: start a child before dispatching implement/check
</runtime-state>
```

`buildSessionStart` 的 `<current-state>` 追加同样四行（少 `next`）。

### 8.2 计算方式

- `workspace`：有效任务的 registry 条目；没有则 `main`；读取失败 `unknown`。
- `claim`：`runtime-facts.claim`；stale 时显示 `claim: stale (<owner>)`。
- `lease`：有效任务的 lease。
- `parallel`：父任务 -> children 统计；叶子任务 -> `serial` 或 "sibling of N"。
- 父任务时 `next` 固定为 "start a child before dispatching implement/check"。

### 8.3 成本控制

`user-prompt` 每轮都跑。为控制成本：

- 只在存在活动任务时读取 runtime facts；
- 一次 git 调用 + 最多 3 个 JSON 文件；
- 结果不做跨进程缓存；
- 在 `bench/hook-bench.mjs` 增加 user-prompt 场景，P95 ≤ 25ms。

## 9. Planner 容器语义

### 9.1 类型

```ts
export interface TaskSnapshot {
  // ...existing
  /** 父任务：协调容器，不是执行单元。 */
  readonly container?: boolean;
  readonly childCount?: number;
}
```

### 9.2 规则

- `planParallel` 在分波前把 `container === true` 的任务移出：不进入 `waves`，进入 `diagnostics`。
- 诊断码 `PARALLEL_CONTAINER_TASK`，severity `info`，`details.next` 给出子任务启动命令。
- 如果 `--refs` 显式包含容器任务，severity 升为 `warn`，但仍不排波：这是"选择错了执行单元"，不是图错误。
- `--explain` 对每个容器输出 `container (children: N): coordinator only; start a child to execute`。
- `parallel status` 保留容器行（它是协调视图的一部分）。

### 9.3 父任务 + planning 子任务提示

`services/parallel.ts` 在加载记录后检查：如果任一容器任务有 `planning` 子任务，且这些子任务在本次 included 集合里（`--include-planning` 或显式 `--refs`），追加 `PARENT_HAS_PLANNING_CHILDREN` warn：

```text
parent .phronia/tasks/X has 6 planning children; they cannot be scheduled until started
next: python3 ./.phronia/scripts/task.py start .phronia/tasks/<child>
```

默认 `parallel plan` 只看 `in_progress`，所以这条提示主要出现在 `--include-planning` 和显式 refs 时。**不自动把 planning 子任务纳入波次**：状态门禁仍然成立。

## 10. `task.py start` 父任务门禁

### 10.1 行为

```text
$ task.py start .phronia/tasks/10-28-backlog-batch
Error: this is a parent/coordinator task (6 children); it cannot be an implementation target.
Children:
  - 10-28-join-code-only        [planning]
  - 10-28-run-progress-bar      [planning]
  ...
Next:
  python3 ./.phronia/scripts/task.py start .phronia/tasks/10-28-join-code-only
  ...
Coordination only? Re-run with --coordinator.
```

- 默认返回 1，不写 session pointer，不改 status。
- `--coordinator`：允许设为活动任务，**同时跳过 implement/check 的 context-manifest 门禁**（父任务不应有子代理读 jsonl）。
- 子任务/叶子任务行为不变。
- 检查顺序：children 检查在 context-manifest 检查之前，避免父任务先报"manifest 为空"的误导错误。
- `--coordinator` 是显式意图；`DISPATCH_PARENT_TASK` 仍然会阻止对父任务的实现派发，二者不冲突。

### 10.2 为什么不在 `task.py start` 里做完整 workspace 判定

Python 是任务指针的写入者，不是工作区策略的所有者。工作区判定依赖 shared runtime、git worktree registry 和平台能力，这些只在 TS 侧有单一实现。`task.py start` 只做**状态机规则**（父任务不是实现单元），不做路径/租约决策。

## 11. 会话身份桥

### 11.1 问题

`workspace ensure` 通过 `resolveSessionKey` → `openState(...).sessions.resolveKey()` 取身份，但：

1. `services/workspace.ts` 的 `loadContext` 调用 `openState({root, env})`，**没有传 `argv`**；
2. 即使传了，`pendingTicketMatchesArgs` 只接受 basename `task.py`。

所以 ZCode 上 `phronia task workspace ensure` 必然落到 `WORKSPACE_SESSION_UNKNOWN`。而 deny 的 `next` 第一条就是这个命令——不修它，准入控制会把用户引到一个死路。

### 11.2 方案

扩展 ticket 契约，而不是引入新的身份通道。**这是 `08-05-shell-ticket-bridge` 的下游扩展**：那个任务把 ticket 泛化到 7 个 hook 平台并建立单一命令提取路径；本任务只把同一路径的语汇扩展到 `phronia task workspace|lease`，不新增第二个 matcher，也不加平台分支。

1. `extractTaskSubcommands(command)` 增加识别：
   - `phronia task workspace <prepare|ensure|bind|release|reclaim> <ref>`；
   - `phronia task lease <acquire|release|heartbeat> <ref>`；
   - `python3 .../task.py <start|current|finish>`（现有）。
2. ticket 的 `subcommands` 记录 `{name: "<task.py verb>" | "workspace" | "lease", action, task_ref}`。
3. `pendingTicketMatchesArgs(argv)`：
   - `basename(argv[0]) === "task.py"` → 现有逻辑；
   - `basename(argv[0]) ∈ {"phronia","trellis"}` && `argv[1] === "task"` → 解析 `argv[2]`（workspace/lease）与 `argv[3]`（verb），与 ticket 的 `name/action/task_ref` 匹配。
4. `services/workspace.ts` / `services/lease.ts` 的 `openState` 传 `argv: process.argv.slice(2)`。
5. 仍然解析不到时：
   - 扫描 `.phronia/.runtime/sessions/*.json`（只读），如果恰好一个 session 的 cwd 属于当前 checkout，打印它的 key；
   - 否则打印：
     ```text
     next: phronia task workspace ensure <ref> --session-key <key>
     hint: set PHRONIA_CONTEXT_ID=<key> for non-hook shells
     ```

如果 `08-05-shell-ticket-bridge` 尚未合入，步骤 1–3 必须以它的最终形状为准 rebase；如果冲突无法避免，优先复用它的提取函数，把 `phronia task` 作为一种新的 command shape 传进去，而不是复制一份解析逻辑。

### 11.3 安全性

- ticket 仍然要求 30s TTL、同仓库 cwd、恰好一个候选；多个候选时返回 null 并诊断。
- 只读取 ticket，不写；不引入新的可伪造长期身份。
- CLI 的 argv 来自用户实际执行的命令，不来自模型；ticket 的 subcommand 来自 hook 看到的同一条命令。

## 12. 配置

```yaml
parallel:
  dispatch:
    enforce: block     # block | warn | off
```

- 默认 `block`。
- 非法值 → `block` + `state.config.invalid_value` warn。
- `warn`：所有 block 变成 allow + guard；guard 的 `severity` 升为 `error`（让模型必须处理）。
- `off`：不产生 guard，不阻断；breadcrumb 与 doctor 仍显示事实和"admission disabled"。
- 该配置**只影响派发准入**，不影响 `parallel plan`、`workspace ensure`、`integrate`。

## 13. 兼容性与迁移

| 变化 | 兼容性 |
|---|---|
| 新增 `deny` mutation | 旧 shim 不识别 → 会走 `_render_mutation` 的默认分支。必须同步 regenerate shims；`phronia update` 负责。 |
| 新增 `hookPolicy` | 旧的 `platforms --json` 消费者会多一个字段；不删不改旧字段。 |
| breadcrumb 新块 | 用户可见；写入 `docs/migrations/user-visible-changes.md`。 |
| `task.py start` 父任务 | 行为变更；`--coordinator` 提供显式通道。 |
| planner 容器 | 父任务以前可能出现在 wave 里；现在不会。属于 bug 修复。 |
| 数据格式 | 不变。不新增 task.json 字段；配置是可选键。 |

迁移策略：

- 已存在的父任务（如 bedrock 的 `10-28-backlog-batch`）不需要迁移；`start` 会提示改用子任务。
- 已存在的无 claim 会话：第一次派发会收到 guard，不阻断。
- 已存在的 worktree registry 条目：直接使用；缺失的按未登记处理。

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 误伤：claim 陈旧/跨机器 | 合法派发被拒 | TTL 判定；`next` 给出 `workspace reclaim --force`；`enforce=warn` 全局降级 |
| ZCode deny 在真实版本不生效 | 守卫静默失效 | acceptance 真实运行；失败则把 `hookPolicy` 降为 `inject` 并发布变更说明 |
| hook 延迟 | 每轮变慢 | 1 次 git 调用 + 小文件；bench 门槛 30ms |
| 事实读取与 CLI 写入竞态 | 读到半写 JSON | 现有 `writeRuntimeJson` 是原子写；读取容错；不 block 读取失败 |
| registry 漂移 | 误判 worktree | registry 可重建；只在 task.branch/cwd 明确冲突时 block；否则 warn |
| 过度阻断阻塞用户 | 用户绕过 Phronia | `enforce=warn/off`；guard 文案明确；doctor 显示当前模式 |
| 规则顺序被后续改动破坏 | 错误码漂移 | 表驱动测试锁死顺序；错误码是公开契约 |
| 非 Phronia agent 绕过 | 契约外行为 | 明确 Non-Goal；文档说明；未来可扩展 `unknown` 分类 |

## 15. 备选方案与否决

| 方案 | 否决理由 |
|---|---|
| 只改 Python shim，加几个 if | 无法复用；无法覆盖 OpenCode/Claude；能力不可见；测试只能黑盒 |
| 在 hook 里自动创建 worktree | 运行中会话 cwd 固定，无法迁移；违反"hooks 只读"；会留下半创建状态（前置设计 §15 已否决） |
| 在 hook 里自动 acquire claim/lease | hook 变成写者，与 CLI 的锁顺序（lease → claim → integration）脱节；失败会留下脏状态；只读契约被破坏 |
| 所有没有 `workspace ensure` 的派发一律 block | 破坏最常见的单任务串行路径；用户会关闭 hook |
| 用 `git index.lock` 当互斥 | 只保护 index 操作，不保护工作树内容；两个 agent 仍可先后写同一文件 |
| 把父/子任务当依赖 | 交付拆分 ≠ 执行顺序；会错误串行化可并行的子任务（前置设计已否决） |
| 在 core 里读 `process.cwd()` | 违反 core 边界；hook 的 cwd 可能被重置；必须用 `projectRoot` |
| 为 ZCode 造多会话启动器进程 | 越界：Phronia 不启动/调度 agent；只打印命令与路径 |

## 16. 测试策略

### 16.1 单元

| 目标 | 文件 | 覆盖 |
|---|---|---|
| 判定顺序与码 | `packages/core/test/task/dispatch.test.ts` | 每个码至少 1 正 1 反；顺序表驱动 |
| 事实读取 | `packages/core/test/state/runtime-facts.test.ts` | fake fs/exec；缺失/损坏/未知版本/非 git |
| 能力矩阵 | `packages/core/test/platform/capabilities.test.ts` | 每个平台都有 `hookPolicy`；unknown 默认 inject |
| planner 容器 | `packages/core/test/task/parallel.test.ts` | 容器不入波；父子混合；显式 refs |
| 渲染 | `packages/core/test/context/*.test.ts` | deny mutation；allow + guard；envelope |

### 16.2 集成

| 目标 | 文件 | 场景 |
|---|---|---|
| `phronia context` 子代理事件 | `packages/cli/test/commands/context-shim.integration.test.ts` | 父任务 deny；无 claim allow+guard；错误 worktree deny |
| Python shim 渲染 | 同上（spawn python） | ZCode deny JSON；Codex guard additionalContext |
| OpenCode shim | `packages/cli/test/commands/context-shim.integration.test.ts` | throw |
| `task.py start` | `packages/cli/test/scripts/task-start-parent.integration.test.ts` | 父任务拒绝/`--coordinator`/子任务正常 |
| workspace session key | `packages/cli/test/commands/workspace.integration.test.ts` | ticket fixture → 无 `--session-key` 成功；双 ticket → 失败且提示 |
| 配置 | `packages/core/test/state/config.test.ts` | 非法 enforce 回落 |

### 16.3 基准

- `bench/hook-bench.mjs` 增加 subagent-spawn 与 user-prompt 场景；增量门槛 30ms / 25ms。
- 对比 opencode / zcode 两条 shim 路径。

### 16.4 手工验收

1. 在测试仓库创建父 + 子任务，父任务 `--coordinator` 启动。
2. ZCode 派发 `phronia-implement`（无 `Active task:`）→ 期望 `Agent` 工具的 `state.status=error`、`session.parent_id` 无子会话、模型不重试。已用 deny-probe 在 2026-10-28 验证平台行为（见 `research/prior-art.md` §3.1）；实施后用真实 `DISPATCH_*` reason 复跑。
3. 按 next 启动子任务 → 再派发 → 收到 `DISPATCH_NO_CLAIM` 守卫并执行。
4. `workspace ensure` → 再派发 → 无守卫。
5. 开第二个 worktree 窗口 → 派发 → 无 deny，breadcrumb 显示 `worktree <path>`。
6. Codex：同一父任务派发 → 不 deny，提示语出现在子代理上下文。

## 17. 实施顺序与回退点

| 阶段 | 内容 | 可观测结果 | 回退 |
|---|---|---|---|
| 0 | 本文档 + 规则表 + 错误码 | 评审通过 | — |
| 1 | `task/dispatch` 纯函数 + 单测 | 无行为变化 | 删除模块 |
| 2 | `state/runtime-facts` + breadcrumb | 只增可观测性 | 移除块 |
| 3 | `context/subagent` 接入 + deny mutation + shim 渲染 | 开始阻断 | `enforce=warn/off` |
| 4 | planner 容器 + `task.py start` + session key | 规划与启动修正 | 分别 revert |
| 5 | spec/docs/skill 同步 + live acceptance | 完整 | 文档回退 |

每个阶段都必须独立通过 `pnpm verify`；阶段 3 是唯一改变派发行为的阶段，直接默认 `block`，不做灰度（单一用户项目；误伤时用 `parallel.dispatch.enforce: warn|off` 降级）。

## 18. 与既有设计的对齐

- **不违反 §4.3**："SessionStart hook 只读；不创建、不切换" —— 本设计只在派发时读事实并给出拒绝/守卫，不移动会话。
- **不违反 §4.1**："隔离单位是任务" —— 所有判定都以 task ref 为主键。
- **不违反 §5.3**："parent/child 不是依赖" —— 容器语义只把父任务排除出执行波次，不把子任务串行化。
- **不违反 §22.3**："ZCode/Codex 降级为多会话" —— `DISPATCH_ISOLATION_REQUIRED` 的 next 就是多会话四步。
- **补充 §12**："per-turn breadcrumb 增加工作区与集成状态" —— 前置设计已要求但未实现；本任务补上工作区部分。
