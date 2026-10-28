# 待拍板决策说明

> 用途：把 v2 设计里需要你确认的选择摊开，给出选项、代价、推荐和可逆性。
> 如果你不逐项回复，实施会采用每项的"推荐"列；这些默认都可以后续通过配置或别名调整。

## 决策总览

| # | 决策 | 推荐 | 可逆性 |
|---|---|---|---|
| 1 | 合入命令名 | `phronia task integrate`（不提供 `land` 别名） | 高（改字符串） |
| 2 | 集成模式确认频率 | `confirm: auto`：仅在"歧义"或"首次远端外向操作"时问一次 | 高（配置） |
| 3 | 单包仓库的并行前提 | 必须声明足迹（目录/模块级即可）；未知即串行 | 高（配置/任务字段） |
| 4 | 创建 worktree 前的任务工件提交 | 询问后做 scoped commit；拒绝则拒绝创建；`--copy-task` 兜底 | 中（会留下一个控制面提交） |
| 5 | linked worktree 中 `task create` | 允许 + 警告 branch-local + 跨 worktree 重名检查 | 高（改策略） |
| 6 | worktree 位置与清理 | 持久化在 `.phronia/worktrees/<task-id>`；归档时清理；永不默认 `/tmp` | 高（配置/命令） |
| 7 | coordinator 范围 | 纳入同一任务终态，不再作为后续 child task；Phase 0 先验证 harness 能力 | 中（Phase E 可开关） |

---

## 1. 合入命令名：`integrate` vs `land`

### 选项

| 选项 | 优点 | 缺点 |
|---|---|---|
| `phronia task integrate`（推荐） | 语义准确（"合入"）；与 archive/finish 区分清楚；中文用户不需要学 jargon | 比 `land` 长；和 "integration test" 共享词根，但上下文是 `task`，歧义低 |
| `phronia task land` | 短；merge-queue/Bors/Graphite 社区用这个词 | 对中文用户是生词；容易被理解成"落地页/着陆"；需要文档解释 |
| `phronia task merge` | 最熟悉 | 容易和 `git merge` 混淆；用户可能以为它会直接合并远端 PR；实际它可能 rebase/verify/ff 或只建 PR |
| `phronia task finish` | 直觉上"完成" | 与现有 `task.py finish`（清除活动任务）冲突 |

### 已拍板

只用 `integrate`，不提供 `land` 别名。理由：

- 这个命令做的是"把任务分支送入集成分支"，不是单纯的 merge；`integrate` 更准确。
- 一个命令只保留一个名字，避免文档、搜索和肌肉记忆分裂。
- 如果后续发现输入成本高，再评估别名；当前不加。

### 影响与可逆性

影响 help 文案、skills、docs、测试快照。改名是纯字符串操作，可逆。

---

## 2. 集成模式确认频率：`auto` / `always` / `never`

### 选项

| 选项 | 行为 | 适合 |
|---|---|---|
| `auto`（推荐） | 无远端 → 直接 local；有远端且首次要创建 PR/MR → 问一次；两种模式都可行且没有记录过选择 → 问一次；重试不再问 | 大多数个人/团队项目 |
| `always` | 每个任务第一次 integrate 都问 | 对"向外创建 PR"极度谨慎；团队流程要求人工确认 |
| `never` | 完全按配置/自动检测，不问 | CI、脚本、完全信任策略的团队 |

### 为什么 `auto` 还要"首次远端操作问一次"

创建 PR/MR 是**外向操作**：会通知 reviewer、触发 CI、可能产生费用。即使项目默认 remote，第一次为某个任务创建 PR 前问一次是合理的；一旦用户确认，后续重试/同步不再问。本地 fast-forward 不产生外向影响，可以不问。

### 推荐

`confirm: auto`，精确定义为：

1. 无 `origin` → local，不问。
2. 有 `origin` + forge CLI，任务还没有记录 mode → 问一次，默认推荐 remote。
3. 任务已记录 mode → 不问。
4. `--yes` → 不问；`--interactive` → 总是问。
5. `--dry-run` → 只展示解析结果，不问。

并且**无论是否询问，都输出一行解析结果和理由**（如 `mode=remote (origin=github.com, gh available)`）。用户即使没被问，也能看到决策依据，发现不对时用 `--mode` 覆盖。

### 影响与可逆性

影响 `finish-work` / `integrate` 的交互和测试快照。配置可逆；已记录在任务上的 mode 可用 `--mode` 覆盖。

---

## 3. 单包仓库的并行前提：必须声明足迹？

### 背景

多包 monorepo 可以先用 package 粗分；单包仓库里 `package` 足迹等于整仓，所有任务都会串行。要让单包仓库真正并行，必须有更细的足迹。

### 选项

| 选项 | 行为 | 风险 |
|---|---|---|
| A. 必须声明（推荐） | 没有 `touches`/`relatedFiles` → 任务单独成批；`--explain` 提示如何声明 | 用户不声明就没有并行；但不会静默制造冲突 |
| B. 允许未知 | 未知足迹也并行 | 冲突率不可控；浪费 agent 时间；违背"显式降级"原则 |
| C. 模块级默认 | 用 `scope` 或目录级足迹（如 `src/features/reports/**`）作为默认 | 需要项目定义 scope→path 映射；粒度粗但可用 |

### 推荐

**A + C 的组合**：

- 足迹优先用 `meta.parallel.touches`；其次是 `relatedFiles`；再次是 `scope` 映射；最后是 `package`。
- 单包仓库默认要求至少声明一个**目录/模块级**足迹（不需要精确到文件）。
- 未知 → 单独成批，并输出：
  ```
  Task B has no declared footprint. It will run serially.
  Declare it with:
    phronia task footprint set B src/features/reports/**
  ```
- 想冒险时显式 `--allow-unknown`（项目配置或单次命令），并在输出里标注 `risk: unknown-footprint`。

### 为什么不做 B 为默认

并行冲突的代价不是"多一个冲突文件"，而是：agent 基于错误假设写完、验证失败、回滚、重新规划。声明一个目录的成本远低于一次错误并行。

### 影响与可逆性

影响任务创建/规划 UX 和 planner 输出。配置可逆；任务字段可随时补充。

---

## 4. 创建 worktree 前的任务工件提交

### 背景

`git worktree add` 从提交创建，不复制主 checkout 的未提交文件。`.phronia/tasks/<ref>/prd.md`、`design.md`、`implement.md` 如果在主 checkout 里未提交，新 worktree 里就没有它们，agent 会失去上下文。

### 选项

| 选项 | 行为 | 优点 | 缺点 |
|---|---|---|---|
| A. 询问后 scoped commit（推荐） | `git add .phronia/tasks/<ref>` + `git commit --only -- .phronia/tasks/<ref>` | worktree 有上下文；主 checkout 干净；git 原生 | 多一个控制面提交；需要用户确认 |
| B. 拒绝直到已提交 | 直接报错，要求用户先提交 | 零惊喜 | 多一步；用户可能不理解为什么 |
| C. `--copy-task` 复制 | 把任务目录复制进 worktree，不提交主 checkout | 不产生提交 | 两份副本会分叉；task.json 合入时冲突；容易混淆 |
| D. task create 时自动提交 | 创建任务时立即提交 | 流程最顺 | 每个任务一个小提交；用户可能不希望任务元数据进历史 |

### 推荐

**A**，并明确约束：

- 只提交 `.phronia/tasks/<ref>`，用 `git commit --only -- .phronia/tasks/<ref>`，不带上其他已暂存改动。
- 提交前打印 `git status --short .phronia/tasks/<ref>`，让用户看到范围。
- 默认消息：`chore(task): plan <ref>`。
- 任务目录已提交 → 直接创建，不询问。
- `--no-commit` → 走 B（拒绝）。
- `--copy-task` → 走 C，并在输出中警告"两份任务记录可能分叉；合入前需手工对齐"。
- 不提交 `worktree_path`（v2 起不再写入 task.json）。

### 为什么不是 D

`task create` 是一个规划动作，用户可能还在改 PRD；立即提交会产生大量半成品提交。把提交绑定到"要 fan-out 了"这个时刻更自然，也只需要一次确认。

### 影响与可逆性

会留下一个控制面提交；在 push 前可 amend/revert。长期看这是任务历史的一部分，不是垃圾。

---

## 5. linked worktree 中 `task create`

### 背景

`.phronia/tasks` 随分支走。在 linked worktree 里创建的任务只存在于该分支，主 worktree 的 planner 看不到，直到它被合入。

### 选项

| 选项 | 行为 | 优点 | 缺点 |
|---|---|---|---|
| A. 允许 + 警告（推荐） | 创建成功，提示 branch-local；合入后才对 planner 可见 | 不打断实现中记录 follow-up | 用户可能误以为全局可见 |
| B. 拒绝 | 强制在主 checkout 创建 | 控制平面干净 | 打断 agent 记录 follow-up；用户体验差 |
| C. `--control-plane` 跨 worktree 写 | 直接写到主 checkout | 立即可见 | 跨 worktree 写工作树有风险；可能与主 checkout 的 git index 冲突 |

### 推荐

**A + 两个保护**：

1. **重名检查**：创建前查主控制平面和共享 registry 中所有 worktree 的任务 slug；重名则拒绝并建议加后缀。这能避免两个分支各自创建 `10-28-fix-progress`，合入时目录冲突。
2. **输出明确**：
   ```
   Created task <ref> (branch-local).
   This task is visible only in the current worktree until the branch is integrated.
   To create a task visible to the parallel planner now, run this in the main checkout: <path>
   ```

不做 C：跨 worktree 写另一个 checkout 的工作树，会和那个 checkout 的 git index/未提交状态打架，收益不抵风险。需要全局任务时，回主 checkout 创建。

### 影响与可逆性

影响 `task create` 的分支检测与提示。策略可逆。

---

## 6. worktree 位置与清理

### 位置选项

| 选项 | 持久性 | 优点 | 缺点 |
|---|---|---|---|
| A. `.phronia/worktrees/<task-id>`（推荐） | 持久 | 位置可预测；相对路径稳定；已在 `.phronia/.gitignore`；`update.ts` 已排除 `/worktrees/`；与现有 LAYOUT 一致 | 嵌套在仓库内；备份工具若未排除会变大；路径可能较长 |
| B. 仓库外持久目录（`../<repo>-worktrees/` 或 `~/phronia/worktrees/<repo>/`） | 持久 | 不污染仓库目录；备份排除容易 | 路径发现/清理复杂；跨磁盘（外置卷仓库）可能变慢；用户需要记住位置 |
| C. 系统临时目录（`/tmp`、`os.tmpdir()`） | **不持久** | 自动清理；适合 CI | **重启/OS 清理会丢未提交工作**；跨文件系统影响构建/watch；macOS `/tmp` 是符号链接需 realpath；Windows temp 路径差异 |

### 推荐

**A，持久化在 `.phronia/worktrees/<task-id>`；永不默认 `/tmp`。**

理由：

- worktree 是"可能跨重启的进行中工作"，不是临时缓存。`/tmp` 的语义与它相反。
- 现有 LAYOUT 已经是这个位置，`.phronia/.gitignore` 已忽略 `worktrees/`，`update.ts` 已经排除 `/worktrees/`；不需要新约定。
- 用户的外置卷项目（如 bedrock）在卷挂载期间工作区就在同一文件系统，构建/文件监听更快；`/tmp` 反而跨盘。
- 需要临时工作区时，显式 `--ephemeral` 或 `parallel.worktree_dir: <tmp>`，并在输出中警告"重启会丢失未提交工作"。

补充约束：

- `parallel.worktree_dir` 可配置（相对仓库根或绝对路径）。
- 目录名用截断后的 task id（如 60 字符 + 短哈希），避免 Windows 路径过长；完整 ref 存 registry。
- registry 存绝对路径；`worktree list` 显示相对仓库根的路径，便于阅读。
- 手动删除目录后，`git worktree prune` 清理元数据；`phronia task worktree list` 检测 stale 条目并提示。

### 清理选项

| 时机 | 行为 | 推荐 |
|---|---|---|
| `integrate` 成功 | 默认保留 worktree，标记 `merged`，便于排查 | 是 |
| `integrate --clean` | 成功后立即删除 worktree（保留分支） | 可选 |
| `task archive` | dirty → 拒绝；clean + landed → 自动删除；clean + 未 landed → 拒绝 | 是（默认 `cleanup: on-archive`） |
| `worktree prune` | 只删除"任务已归档/已合入且干净"的 worktree；`--dry-run`；`--older-than`；永不删 dirty/未合入 | 是 |
| 远端已推送未合并 | 不清理；状态 `pushed` | 是 |
| 有未推送提交（ahead of base） | 不清理，除非 `--force` | 是 |
| 分支 | 默认保留；`--delete-branch` 才删 | 是 |

### 清理的安全底线

1. 永不自动删除 dirty worktree。
2. 永不自动删除有未合入/未推送提交的 worktree。
3. 永不自动删除分支（除非显式 `--delete-branch`）。
4. 删除前打印路径、分支、任务 ref、磁盘占用（可选）。
5. 删除失败不阻塞 archive；留下 warning 和下一步命令。

### 磁盘与备份

- 每个 worktree 可能有独立 `node_modules`；`max_concurrent` 限制数量。
- `post_create` 可配置为轻量安装（如 `pnpm install --frozen-lockfile`）；不需要时留空。
- `update.ts` 已排除 `/worktrees/`；文档明确备份不包含 worktree。
- 可选：`worktree list --disk` 显示占用（`du` 可能慢，默认关闭）。

### 推荐默认

```yaml
parallel:
  worktree:
    dir: .phronia/worktrees      # 相对仓库根；可绝对路径
    cleanup: on-archive          # on-archive | on-integrate | manual
    location: persistent         # persistent | ephemeral（ephemeral 需显式确认）
```

`ephemeral` 使用 `os.tmpdir()/phronia/<repo-hash>/<task-id>`，并在 `workspace ensure` 输出：

```
WARNING: ephemeral worktree under /tmp. A reboot or OS cleanup will lose uncommitted work.
```

---

## 如果你不想逐项决定

实施将采用：

1. `integrate`（不提供 `land` 别名）。
2. `confirm: auto`（首次远端操作问一次）。
3. 单包仓库必须声明目录级足迹；未知串行；`--allow-unknown` 可覆盖。
4. 询问后 scoped commit；`--no-commit` 拒绝；`--copy-task` 兜底。
5. linked worktree 允许创建 + 警告 + 重名检查。
6. 持久化 `.phronia/worktrees/<task-id>`；归档清理；`/tmp` 仅显式 ephemeral。

---

## 7. Coordinator 是否纳入同一任务（v3）

**已拍板：纳入终态，不再作为"后续 child task"。**

### 为什么

- coordinator 是用户目标的一部分，不是可选增强。把它排除会让 A/B 阶段的数据模型（共享任务索引、task lease、显式 `--task`）留到以后，Phase E 很可能推翻 A/B。
- 一次性设计终态，才能保证任务、worktree、claim、lease、integrate 是同一套原语，而不是两套。
- 分开做并不会减少风险，只会把风险推迟到"以后重构"。

### 风险控制

- **Phase 0 先行**：在真实 harness 上验证并行子代理、每任务 cwd/worktree、显式 `task_ref`、嵌套子代理；未验证的能力不得假设支持。
- **能力门控**：不支持 `parallel + per-task` 的平台降级为多会话或串行，不静默 no-op。
- **可开关**：`parallel.coordinator.enabled: false` 可关闭 Phase E。
- **独立 gate**：Phase E 单独 review；Phase 0 结论若推翻假设，回到 design 修订，不进入 E。
- **不启动进程**：Phronia 只输出 dispatch manifest，由 harness 原生子代理执行。

### 保留的边界

- coordinator 不引入第二套执行模型；复用任务、worktree、claim、lease、integrate。
- 新会话中途加入任务通过共享索引 + 重新 plan 进入下一 wave；不引入全局 batch 锁。
- 远端合入、冲突治理、本地锁语义不变。

---

## 8. 平台能力结论（W0 实测）

| 平台 | execution | workspace | identity | 结论 |
|---|---|---|---|---|
| ZCode 3.16.3 | parallel | inherited | isolated | **multi-session**，不能 coordinator |
| Codex 0.149.1 | parallel | inherited | isolated | **multi-session**，不能 coordinator |
| Claude Code 2.1.217 | nested | per-task | shared | **coordinator 候选**，schema+docs，live 待跑 |

关键缺口：三款 Agent 工具都没有 `task_ref` 字段；当前 Python shim 不解析 `Active task:`。W5 必须扩展 `readTaskRef` 解析 prompt 首行，或在 Claude Code 用 `tool_input.cwd` 映射 workspace→task。没有这个桥，coordinator 会话里的 hook 注入无法区分任务 A/B。

因此：

- ZCode/Codex 上的用户场景应走 **多会话**（每个任务一个 worktree + 一个窗口），`dispatch` 返回降级计划，而不是假装支持。
- Claude Code 是唯一原生 coordinator 目标；在 live 验证通过前，能力矩阵标 `schema+docs`，不标 `supported`。
- 其他平台保持 `unknown` 或 `unsupported`，不得按"应该都支持"假设。

---

## 4-深化：主 checkout 占用判定与原子认领

这一节回答"什么时候该开 worktree"以及"如何避免两个会话同时判断 main 空闲"。

### 判定信号：claim，不是状态也不是 git diff

| 候选信号 | 问题 |
|---|---|
| `status=in_progress` | 任务可能正在用 worktree；而 `planning` 阶段就可能已有未提交的 PRD/design，需要保护 |
| `git diff` 非空 | 本地 `.env` 也会脏；任务提交后仍可能在用 main |
| 有活跃会话 | 会话可能只是问答；会话身份并非所有平台可靠 |

所以用一个显式的 **workspace claim**：它表示"主 checkout 现在归谁使用"，与文件改动、任务状态解耦。

- 位置：`<git-common-dir>/phronia/workspace.claim.json`。
- owner 先可以是 session，创建任务后改成 task。
- 心跳 + TTL（默认 2h）+ 显式 release。
- 不用 CLI 进程 pid 判断存活——每次命令都是新进程。

### 原子性：`O_EXCL`，不是"读-判断-写"

```
tryClaim(session):
  open(claimPath, 'wx') 成功 -> 拥有 main
  EEXIST -> 读 claim
    stale + owner 已 completed/archived + main 干净 -> 原子 rename 清理 -> 重试
    stale + owner 仍 planning/in_progress          -> 不自动回收，返回 stale-owned，改开 worktree
    stale + main 脏                                -> 不回收，返回 stale-dirty，改开 worktree
    无 claim + main 脏                             -> dirty-unclaimed，默认改开 worktree
    否则                                           -> busy，改开 worktree
```

- 两个会话同时启动：只有一个成功，另一个必然走 worktree。
- 没有 check-then-act 窗口。
- **不需要计数器**：main 是二元互斥；claim 文件就是"有任务在进行"的记录。
- worktree 数量上限用 `max_concurrent` 和 registry 计数，不是正确性依赖。

### 与 local integrate 的互斥

主 checkout 同时是"任务工作区"和"local 合入目标"，必须互斥：

- 任务用 main：已持有 claim；`integrate` 只做验证 + 写 outcome + 释放 claim，不需要 rebase/ff。
- 任务用 worktree：`integrate --mode local` 必须先拿到 main 的 claim，再 rebase/verify/ff；claim 被别人占用时只能等待、先结束对方、或改用 remote。
- 锁顺序固定为 **workspace claim → integration lock**，避免死锁。
- remote 模式不受 main claim 影响。

这比单独的 integration lock 更强：integration lock 只保证合入串行，workspace claim 保证工作树没有被别人使用。

### 时机：任务工作开始时，不是裸 SessionStart

- SessionStart / breadcrumb 只读，输出建议，不创建、不认领。
- 用户表达"要开始一个任务"时调用 `workspace prepare`。
- 理想情况下在启动 agent 会话**之前** prepare，然后在返回目录启动会话；或者用平台原生 worktree。
- 运行中的会话 cwd 固定；若 prepare 决定 create，只能打印路径并建议在新目录重启，或用绝对路径降级，不承诺自动迁移。

### provisional workspace：先隔离，再创建任务

用户想"先开 worktree，再想 PRD/design"是合理的。做法：

1. `workspace prepare --for-new-task "<title>"`：
   - main 空闲 → 认领 main；
   - main 被占 → 从集成分支建 provisional worktree（`phronia/wip/<short>`，`taskRef: null`）。
2. 在返回的工作区里写 PRD/design。
3. `task create "<title>"` 在同一个工作区执行，绑定 registry，任务从出生就在正确的工作区。
4. TTL 内没建任务且 clean → prune。

这样**不需要把任务工件 scoped commit 到被占用的 main 分支**。决策 4 的 scoped commit 从主路径降级为兜底：只有"任务已在 main 创建，之后才决定开 worktree"时才用。

### 直接回答你的三个问题

1. **"有任务在进行"以什么为准？** 以 claim 为准。不是 `status`，也不是 `git diff`。planning 阶段没改文件也算占用；提交完所有改动但仍然在做这个任务，也算占用。
2. **"start session 时检查，有任务就直接开 worktree 再想 PRD/design"是否更顺？** 思路上对，但要改成"任务工作开始时"而不是裸 session 开始；并且在启动会话前 prepare 最稳。任务还不存在时用 provisional workspace。
3. **是否需要文件锁/计数器？** 需要锁，但不需要计数器。`O_EXCL` 创建 claim 就是原子判定 + 占用记录；main 是二元资源。worktree 数量用 registry 计数，不是并发正确性的基础。

