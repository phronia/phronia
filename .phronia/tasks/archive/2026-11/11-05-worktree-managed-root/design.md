# Design: Centralized worktree root with managed gitignore

## 1. Problem restatement

worktree 根目录当前由六处独立字面量共同决定，且没有任何机制保证新位置被 git 忽略。这既是清理困难的根因，也是"改一处常量就够"这个直觉不成立的原因。

本设计要解决的三个技术问题：

1. 根目录解析必须收敛为单一入口，且能同时服务 TypeScript、Python 与模板三类消费者。
2. 任意配置的根目录都必须被 git 忽略，且不得覆盖用户文件内容。
3. 既有 worktree（旧根、外部 attach、`task.json.worktree_path`）位置不得改变。

## 2. 分层与职责

```
┌─────────────────────────────────────────────────────────────┐
│ core/layout/index.ts          LAYOUT.paths.worktrees         │  ← 常量真相
│ core/state/config/readers.ts  parallel.worktreeDir（配置值）  │
└──────────────────────────┬──────────────────────────────────┘
                           │  解析（唯一入口）
┌──────────────────────────▼──────────────────────────────────┐
│ core/task/workspace/policy.ts : resolveWorktreeRoot()        │  ← 纯函数
│   输入 (configuredDir, mainRoot) → { absolute, relative }    │
└──────────────────────────┬──────────────────────────────────┘
        ┌──────────────────┼──────────────────┬───────────────┐
        ▼                  ▼                  ▼               ▼
  cli/services        cli/services       python layout     templates
  workspace.ts        coordinator.ts     paths.py/safe_   gitignore.txt
                                          commit.py
```

原则：**下游只消费解析结果，不重新拼接**。当前 `workspace.ts:2620` 与 `coordinator.ts:619` 各自做了一次 `path.join(mainRoot, dir)`，属于重复实现，本任务统一为调用 `resolveWorktreeRoot`。

### 2.1 关于 `LAYOUT.paths.worktrees`

`LAYOUT` 是"相对项目根的 POSIX 路径"真相，Python 通过 `scripts/gen-layout.mjs` 生成 `layout.json` 消费它，CI 会校验两者一致。

默认根目录改为 `.phronia-workspace` 后，`LAYOUT.paths.worktrees` 同步改为 `".phronia-workspace"`。这只是"默认值"，不是"实际位置"——实际位置由配置覆盖。两者语义必须区分清楚：

- `LAYOUT.paths.worktrees`：默认相对路径，供 Python 侧作为 fallback 与文档展示。
- `resolveWorktreeRoot()`：运行时实际解析结果，是 CLI/service 唯一可信来源。

Python 侧无法读取用户配置（`config.yaml` 由 CLI 解析），因此 Python 只使用默认值或消费 CLI 落在共享运行时里的派生结果。**本设计选择让 Python 只依赖默认值 + 显式传入路径**，理由见 §6.3。

### 2.2 `WORKSPACE_DEFAULT_ROOT` 常量

新增导出常量，位于 `core/layout/index.ts`：

```ts
export const WORKTREE_ROOT_DIR_NAME = ".phronia-workspace" as const;
```

`LAYOUT.paths.worktrees` 与 `readers.ts` 的 `DEFAULT_PARALLEL_WORKTREE_DIR` 都从它派生。这是 R1 的落点：删掉 `readers.ts:27` 与 `policy.ts:23` 的重复字面量。

## 3. 根目录解析

### 3.1 签名

```ts
// core/task/workspace/policy.ts
export interface WorktreeRoot {
  /** Absolute path where new worktrees are created. */
  readonly absolute: string;
  /** POSIX relative path from the repo root, null for outside-repo roots. */
  readonly relativeFromRepo: string | null;
  /** True when the root lives outside the repository working tree. */
  readonly outsideRepo: boolean;
  /** Which layer supplied the value. */
  readonly source: "config" | "default" | "ephemeral";
}

export function resolveWorktreeRoot(input: {
  readonly configuredDir: string;
  readonly mainRoot: string;
  readonly location: "persistent" | "ephemeral";
  readonly tmpDir?: string;
}): WorktreeRoot;
```

行为：

- `location === "ephemeral"` → `/tmp` 下的稳定子目录，`outsideRepo: true`，`source: "ephemeral"`。
- 绝对路径 → 原样解析，`outsideRepo` 由 `path.relative(mainRoot, absolute)` 是否以 `..` 开头判定。
- 相对路径 → `path.join(mainRoot, configured)`，`relativeFromRepo` = 规范化后的相对形式。
- `configuredDir` 为空 → 使用 `WORKTREE_ROOT_DIR_NAME`，`source: "default"`。

`relativeFromRepo` 必须是 POSIX 形式且不含 `..`，用于 gitignore 与 JSON 输出；否则为 `null`。

### 3.2 调用点改造

| 调用点 | 现状 | 改为 |
|---|---|---|
| `services/workspace.ts:2620` `worktreeDirectory()` | 自行 join | 返回 `resolveWorktreeRoot(...).absolute` |
| `services/coordinator.ts:619` dry-run 拼接 | 自行 join | 同左 |
| `services/workspace.ts` 的 `hardenedPath` | 接受 directory | 不变（只消费绝对路径） |

`policy.ts` 内部的 `resolveTarget` 也改为接收已解析的绝对根，不再接受 `worktreeDir` 相对值。这一步让 `policy.ts` 的 `DEFAULT_WORKTREE_DIR` 常量彻底删除。

### 3.3 为什么不把 `relative` 传进 `policy.ts`

`decideWorkspace` 当前接收 `worktreeDir?: string`（`types.ts:77`）。该字段同时承担"根目录"与"是否已解析"两种含义，是歧义来源。改为：

```ts
readonly worktreeRoot?: { readonly absolute: string };  // 已解析
```

缺省时回退到 `joinPath(currentCheckout, WORKTREE_ROOT_DIR_NAME)`，保持 core 单测可以只传 checkout 就能跑。向后兼容 `worktreeDir` 字段一个版本，标记 deprecated，值为相对路径时先 join 再使用。

## 4. 受管 gitignore

### 4.1 目标

对解析后的根目录，保证 `git check-ignore` 对它返回 0（即被忽略），且不破坏用户文件。

### 4.2 写入策略

新增 `packages/cli/src/utils/ensure-gitignore.ts`：

```ts
export interface EnsureGitignoreResult {
  readonly changed: boolean;
  readonly path: string;          // 写入的文件
  readonly pattern: string | null; // 写入的模式；null = 未写
  readonly reason: string | null;  // 未写的理由
}

export function ensureWorktreeIgnored(options: {
  readonly mainRoot: string;
  readonly root: WorktreeRoot;
  readonly dryRun?: boolean;
}): EnsureGitignoreResult;
```

规则，按顺序：

1. `root.outsideRepo === true` → 不写，`reason: "outside-repo"`。
2. 已忽略（`git check-ignore --quiet -- <relative>` 返回 0）→ 不写，`reason: "already-ignored"`。
3. 选取目标文件：
   - 若 `<mainRoot>/.gitignore` 存在 → 写它。
   - 否则若 `<mainRoot>/.phronia/.gitignore` 存在 → 写它。
   - 否则创建 `<mainRoot>/.gitignore`。
4. 写入方式：
   - 若目标文件已含 Phronia 受管块（复用 `managed-paths.ts` 的 `PHRONIA_BLOCK_START`），在块内追加该模式（去重）。
   - 否则在文件末尾追加一个受管块，内容为注释行 + 模式。
5. 模式形式：
   - 相对仓库根：`/<relative>/`（前导斜杠锚定到仓库根，避免匹配子目录同名目录）。
   - 相对 `.phronia/`：`/../<relative>/` 不可用，因此改用 `/<relative>/` 同样锚定仓库根——`.phronia/.gitignore` 的锚定点是 `.phronia/` 本身，所以必须写成相对于 `.phronia` 的 `../<relative>/`。**此路径不可用，因此当 `root.relativeFromRepo` 存在但不在 `.phronia/` 之下时，只写仓库根 `.gitignore`。** 若用户在无写权限场景下只能写 `.phronia/.gitignore`，则放弃写入并报告 `reason: "no-usable-gitignore"`。

     > 设计决定：不在 `.phronia/.gitignore` 里写 `../` 模式。git 支持这种写法，但它把忽略规则的语义跨越了目录边界，用户排查 `git check-ignore` 时很难理解，且 `update` 覆盖模板时有被清除的风险。宁可要求仓库根 `.gitignore`。

6. `dryRun` 时只计算不写。

### 4.3 调用时机

| 命令 | 时机 | 失败处理 |
|---|---|---|
| `init` | 写完配置文件后 | 警告，不阻断 |
| `update` | 与 `ensureGitattributes` 并列，在 "nothing to do" 早返回之前 | 警告，不阻断 |
| `workspace ensure` / `worktree add` | **创建 worktree 之前** | 警告并继续创建（见下） |
| `doctor` | 只读检查，报告是否被忽略 | 不写 |

`ensure` / `add` 的失败处理是刻意的：不因为写不了 gitignore 就拒绝创建 worktree——那会让 root 目录不可写但 git 可写这种边缘场景彻底无法工作。改为：创建成功 + `warnings: ["worktree root is not gitignored; add it manually: ..."]` + `--json` 里 `gitignore.ignored === false`。

### 4.4 与 `templates/workflow/gitignore.txt` 的关系

模板中第 14 行 `worktrees/` 保留（用于旧根目录的兼容忽略），但新增块由 `ensureWorktreeIgnored` 在运行时写入。模板本身不硬编码 `.phronia-workspace`，因为用户可能配置其他目录。

模板同时移除对 `worktrees/` 的"自动提交排除"语义依赖以外的任何假设——`safe_commit.py` 的 `PHRONIA_IGNORED_SUBPATHS` 保留旧模式（旧目录仍需排除），并追加新默认值。

## 5. 旧路径只读兼容

### 5.1 读取链路（保持不变）

```
registry (<git-common-dir>/phronia/worktrees.json)
  └─ 无匹配条目 ─→ task.json.worktree_path（B11 legacy）
```

`task_store.py:_resolve_task_worktree()` 与 `workspace.ts:legacyWorktreePath()` 已经实现这个回退，本任务不改变其优先级。

### 5.2 写入链路（新增约束）

新建 worktree 只写新根目录。但**不得**因为"注册表里有旧路径条目"而重建该条目到新位置。具体约束落在 `shared-runtime.ts` 的注册表重建路径：

`rebuildFromGit()`（`shared-runtime.ts:517` 附近）用 `git worktree list` 重建条目。重建出的 `path` 来自 git 的真实输出，天然是原位置，**不存在被默认值污染的风险**。需要在测试里锁定这一行为，避免未来有人"优化"成按默认根拼接。

### 5.3 归档回收

`task_store.py:_guard_worktree_before_archive()` 已按注册表解析出的绝对路径执行 `git worktree remove`，与根目录默认值无关。唯一需要确认的是"释放空间"输出在旧位置同样生效（现有实现已做 best-effort 测量）。

## 6. 可观测与命令面

### 6.1 `--json` 输出扩展

`workspace ensure --json`、`worktree add --json`、`worktree list --json` 增加：

```json
{
  "worktreeRoot": {
    "absolute": "/repo/.phronia-workspace",
    "relativeFromRepo": ".phronia-workspace",
    "outsideRepo": false,
    "source": "default"
  },
  "gitignore": {
    "ignored": true,
    "file": ".gitignore",
    "pattern": "/.phronia-workspace/",
    "reason": null
  }
}
```

`gitignore.ignored` 由 `git check-ignore --no-index --quiet` 判定，与写入逻辑使用同一判定函数，避免"写了但没生效"。

### 6.2 `doctor`

`taskConfigReport`（`commands/doctor.ts:211`）增加 `worktreeRoot` 与 `legacyWorktrees`：

```ts
worktreeRoot: {
  absolute: string;
  relativeFromRepo: string | null;
  outsideRepo: boolean;
  source: "config" | "default" | "ephemeral";
  ignored: boolean;
  gitignoreFile: string | null;
}
legacyWorktrees: {
  count: number;
  entries: { taskRef: string; path: string; state: "landed-clean" | "dirty" | "unlanded" | "missing" }[];
}
```

`legacyWorktrees` 的选择标准：注册表路径不在 `worktreeRoot.absolute` 之下。这些条目只报告，不自动处理。

### 6.3 Python 侧如何知道实际根目录

Python 无法解析 `config.yaml`（那是 CLI 的职责，且 YAML 解析在 Python 侧是独立实现）。三个选项：

| 选项 | 优点 | 缺点 |
|---|---|---|
| A. Python 读 `layout.json` 的默认值 | 零改动 | 用户配置自定义根时，Python 认为默认值 —— 仅影响"扫描残留目录"这类只读展示 |
| B. CLI 把解析结果写进共享运行时 | 准确 | 新增状态文件，多一处同步点 |
| C. Python 调用 CLI 子命令 | 准确 | 引入进程依赖，慢 |

**选择 A + 限定用途。** Python 侧当前对 worktree 根目录的唯一用途是 `safe_commit.py` 的"不自动暂存"排除列表，属于保守白名单——多排除一个旧目录没有危害，漏排除新目录才有危害。因此 Python 保留旧模式并追加新默认模式，即可安全覆盖默认配置场景；自定义根目录场景下 Python 的排除列表会漏掉，但因为 gitignore 已生效，`git add .phronia/` 不会捡到它们（`safe_commit` 本来就只 add 指定路径，见 `safe_phronia_paths_to_add`）。

这个取舍写进 spec，避免未来有人误以为 Python 需要知道实际根目录。

## 7. 兼容矩阵

| 场景 | worktree 位置 | commit/integrate/archive | doctor |
|---|---|---|---|
| 旧根 `.phronia/worktrees/x`，升级前创建 | 不变 | 正常 | 列入 legacyWorktrees |
| 外部 attach `../repo-x`，升级前创建 | 不变 | 正常（归档不自动删） | 列入 legacyWorktrees |
| `task.json.worktree_path` 遗留，无注册表 | 不变 | 正常 | 列入 legacyWorktrees |
| 新任务 | 新根 | 正常 | 计入当前根 |
| 配置 `.custom-wt` | 该目录 | 正常 | 计入当前根 |
| 配置绝对路径/库外 | 该目录 | 正常 | `outsideRepo: true`，不写 gitignore |
| `location: ephemeral` | `/tmp/...` | 正常 | `source: "ephemeral"` |

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 注册表重建被改成按默认根拼接 | 旧 worktree 被映射到新位置，`git worktree remove` 删错目录 | 测试锁定"重建路径来自 git 输出"；design 记录 |
| `update` 覆盖用户 `.gitignore` | 用户丢失自定义规则 | 只用受管块 + 追加；绝不整文件写；已有 `ensureGitattributes` 作为同型先例 |
| `.phronia/.gitignore` 被模板整体覆盖 | 旧 `worktrees/` 模式丢失 | 模板更新时保留该行；受管块写在仓库根 |
| 用户根目录在库外 | gitignore 无法覆盖 | `outsideRepo` 明确报告，不假装成功 |
| `policy.ts` 移除 `DEFAULT_WORKTREE_DIR` 破坏 core 单测 | 测试失败 | 保留 `worktreeDir` 入参一个版本，转换逻辑在 core 内做 |
| 新默认目录名与已有用户目录冲突 | 创建到用户数据目录里 | 创建前 `fs.existsSync` 检查：存在且非 Pharonia 创建（无 `.phronia/.runtime` 标记）时报 `WORKSPACE_TARGET_EXISTS` 并要求显式确认 |

## 9. 明确不做

- 不迁移旧目录。
- 不删除旧目录。
- 不在 `.phronia/.gitignore` 写跨目录模式。
- 不让 Python 解析 `config.yaml`。
- 不改变 `git worktree add` 的调用方式。
