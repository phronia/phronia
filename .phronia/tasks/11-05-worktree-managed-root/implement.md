# Implementation plan: Centralized worktree root with managed gitignore

> 顺序按"先立真相、再改消费、最后接命令"排列。每一步都能单独编译并通过现有测试。
> 回滚点：完成 Step 3 之前，系统行为与今天完全一致（只是多了一个未被调用的解析函数）。

## Preconditions

- [ ] 已读 `design.md`（本目录）
- [ ] `pnpm build:core` 与 `pnpm test` 在改动前为绿
- [ ] 确认 `.phronia/spec/cli/backend/parallel-tasks.md` §4 与 `directory-structure.md` 是待更新目标

## Step 1 — 常量与布局真相（core）

- [ ] `packages/core/src/layout/index.ts`
  - 新增 `export const WORKTREE_ROOT_DIR_NAME = ".phronia-workspace" as const;`
  - `LAYOUT.paths.worktrees` 改为 `WORKTREE_ROOT_DIR_NAME`
  - 保持 `paths` 为 POSIX 相对路径（不引入绝对路径）
- [ ] `packages/core/src/state/config/readers.ts`
  - `DEFAULT_PARALLEL_WORKTREE_DIR` 改为派生自 `WORKTREE_ROOT_DIR_NAME`，删除字面量
- [ ] `packages/core/src/task/workspace/policy.ts`
  - 删除本地 `DEFAULT_WORKTREE_DIR` 字面量，改为从 layout 派生
- [ ] 运行 `pnpm gen:layout` 重新生成 `layout.json`，确认 `worktrees` 字段更新
- [ ] `pnpm build:core && pnpm --filter @phronia/core test`
- 验证：core 单测中 `.phronia/worktrees` 断言按新默认值更新（这是一次有意的断言变更，不是掩盖失败）

## Step 2 — `resolveWorktreeRoot`（core，纯函数）

- [ ] `packages/core/src/task/workspace/policy.ts` 新增 `resolveWorktreeRoot`
  - 返回 `{ absolute, relativeFromRepo, outsideRepo, source }`
  - `relativeFromRepo` 使用 POSIX 分隔符；含 `..` 时为 `null`
  - `ephemeral` 分支复用现有 `/tmp` 逻辑（与 `workspace.ts` 现有实现对齐）
- [ ] `packages/core/src/task/workspace/types.ts`
  - 新增 `WorktreeRoot` 类型
  - `WorkspacePolicyContext.worktreeDir` 标记 `@deprecated`，新增可选 `worktreeRoot?: { absolute: string }`
- [ ] `resolveTarget()` 优先使用 `worktreeRoot.absolute`；`worktreeDir` 存在时先 `join(checkout, dir)` 再使用（一个版本的兼容）
- [ ] 新增单测 `packages/core/test/task/worktree-root.test.ts`
  - 相对配置 / 绝对配置 / 库外绝对路径 / ephemeral / 空配置默认值 / Windows 分隔符
- 验证：`pnpm --filter @phronia/core test` 绿；`policy.ts` 中不再有 `.phronia/worktrees` 字面量

## Step 3 — CLI 消费统一（单一日志入口）

- [ ] `packages/cli/src/services/workspace.ts`
  - `worktreeDirectory(context)` 改为调用 `resolveWorktreeRoot`，删除自身 `path.join`
  - `WorkspaceContext` 增加缓存字段 `worktreeRoot: WorktreeRoot`（在 `loadContext` 里算一次）
- [ ] `packages/cli/src/services/coordinator.ts:607` `dryRun`
  - 删除 `path.isAbsolute(worktreeDir) ? ... : path.join(mainRoot, worktreeDir, slug)`
  - 改为 `resolveWorktreeRoot(...).absolute` + `path.join(root, slug)`
- [ ] `packages/cli/src/services/workspace.ts` 的 `busyOrProvisional`、`executeWorkspaceDecision`、`hardenedPath` 全部改为消费绝对根
- [ ] 回归：`packages/cli/test/commands/workspace.integration.test.ts`、`worktree.integration.test.ts`、`coordinator.integration.test.ts`
- 验证：这三个集成测试在默认配置下仍指向新根；凡是断言 `.phronia/worktrees` 的地方都需要显式传入 `worktree_dir` 旧值以保留覆盖，或改为新值（逐个判断，不做全局替换）

## Step 4 — 受管 gitignore 工具

- [ ] 新增 `packages/cli/src/utils/ensure-gitignore.ts`
  - `ensureWorktreeIgnored(options)`，返回 `EnsureGitignoreResult`
  - 判定与写入共用同一个 `git check-ignore` 调用入口（通过 `GitPort.checkIgnore`，不新起子进程）
  - 受管块标记复用 `managed-paths.ts` 的 `PHRONIA_BLOCK_START/END`（注意：该标记是 HTML 注释，用在 `.gitignore` 里是合法注释；若认为语义不符，**新建一对 `# PHRONIA:START/END` 标记**并在 `managed-paths.ts` 导出，不得硬编码字符串）
- [ ] 新增单测 `packages/cli/test/utils/ensure-gitignore.test.ts`
  - 无 gitignore → 创建
  - 已有 gitignore 无受管块 → 追加块
  - 已有受管块 → 块内去重追加
  - 已忽略 → 不写
  - 库外根 → 不写并给出 reason
  - dryRun → 不落盘
- 验证：单测覆盖六个分支；`git check-ignore --no-index` 在临时仓库里真实返回 0

## Step 5 — 接入命令

- [ ] `packages/cli/src/commands/init.ts`
  - 在配置文件写入后调用 `ensureWorktreeIgnored`
  - 失败仅 `console.warn`，不影响退出码
- [ ] `packages/cli/src/commands/update.ts`
  - 与 `ensureGitattributes(cwd)` 并列调用，位置在 "nothing to do" 早返回之前
  - 尊重 `--dry-run`（不写盘）
- [ ] `packages/cli/src/services/workspace.ts`
  - `addWorktree` 与 `executeWorkspaceDecision` 的 `create` 分支：`git worktree add` **之前**调用
  - 失败 → 加入 `warnings`，继续创建
- [ ] `packages/cli/src/commands/doctor.ts`
  - `taskConfigReport` 增加 `worktreeRoot` 与 `legacyWorktrees`
  - 只读：不调用写入路径
- 验证：`phronia init` 后 `git check-ignore .phronia-workspace` 返回 0；`phronia doctor --json` 含新字段

## Step 6 — JSON 输出与可观测

- [ ] `workspace ensure --json`、`worktree add --json`、`worktree list --json` 增加 `worktreeRoot` 与 `gitignore`
- [ ] `gitignore.ignored` 与实际写入使用同一判定函数
- [ ] `packages/cli/src/commands/worktree.ts:runWorktreeList` 的人类可读输出增加根目录一行
- 验证：手工跑三条命令，`--json` 字段与设计文档 §6.1 一致

## Step 7 — Python 侧

- [ ] `packages/cli/src/templates/workflow/scripts/common/layout.json` — 由 `pnpm gen:layout` 生成，确认 `worktrees` 为新值
- [ ] `packages/cli/src/templates/workflow/scripts/common/safe_commit.py`
  - `PHRONIA_IGNORED_SUBPATHS` 追加 `.phronia-workspace/`，保留 `.phronia/worktrees/`
  - 注释说明为何保留两者（保守白名单）
- [ ] `packages/cli/src/templates/workflow/gitignore.txt`
  - 保留 `worktrees/`（旧根兼容）
  - 不硬编码 `.phronia-workspace`（由运行时受管块写入）
- [ ] `packages/cli/test/regression.test.ts` 中相关断言按新默认值更新
- 验证：`pnpm gen:layout --check` 通过

## Step 8 — 兼容性验收（对应 PRD R6-R8）

- [ ] 新增集成测试 `packages/cli/test/commands/worktree-legacy-compat.integration.test.ts`
  - 构造旧根 worktree（显式 `worktree_dir: .phronia/worktrees`）→ 升级后 `worktree list` 路径逐字节不变
  - 构造外部 attach 目录 → 升级后仍 attach，归档不自动删
  - 构造 `task.json.worktree_path` 遗留、注册表无条目 → 仍可 commit/integrate/archive
- [ ] 新增测试锁定注册表重建行为
  - 注册表文件缺失 → `rebuildFromGit` 产出的 path 与 `git worktree list` 逐条一致
  - 该测试防止未来有人按默认根拼接
- [ ] 升级幂等测试
  - 连续两次 `phronia update` 不产生重复 gitignore 条目
  - `phronia update` 后 `git status` 除预期文件外无变更

## Step 9 — 文档与 spec

- [ ] `.phronia/spec/cli/backend/parallel-tasks.md` §4
  - "Default location is `.phronia/worktrees/<task-id>`" 改为新默认值
  - 增加"根目录解析单一入口""受管 gitignore""旧路径只读兼容"三条契约
- [ ] `.phronia/spec/cli/backend/directory-structure.md`
  - 目录树中加入 `.phronia-workspace/`
- [ ] `packages/cli/src/templates/workflow/workflow.md`
  - 若提及 worktree 位置，同步
- [ ] `.phronia/spec/tech/repo/index.md`（若存在相关条目）

## Validation commands

```bash
pnpm build:core
pnpm gen:layout --check
pnpm --filter @phronia/core test
pnpm --filter @phronia/cli test
pnpm typecheck
pnpm lint
```

## Review gates

| Gate | 条件 |
|---|---|
| G1（Step 1-2 后） | core 单测绿；`policy.ts` 无路径字面量；`resolveWorktreeRoot` 覆盖六个分支 |
| G2（Step 3 后） | 三个 workspace/worktree/coordinator 集成测试绿；无新增重复 join |
| G3（Step 5 后） | init/update/ensure 三处都能让新根被忽略；doctor 输出新字段 |
| G4（Step 7 后） | Python 侧排除列表含新默认值；`gen:layout --check` 绿 |
| G5（Step 8 后） | 旧任务与旧 worktree 全链路通过；注册表重建测试锁定 |

## Rollback points

- Step 1-2 完成后回滚：删除新常量与函数即可，无行为变化。
- Step 3 完成后回滚：`worktreeDirectory()` 恢复自身 join；core 的 `resolveWorktreeRoot` 保留但无人调用。
- Step 5 之后回滚：`ensureWorktreeIgnored` 调用点移除；已写入的 gitignore 块需手工删除（记录在 changeset 说明中）。

## Out-of-scope reminders

- 不迁移旧目录、不删除旧目录
- 不改变 `git worktree add` 调用形式
- 不让 Python 解析 `config.yaml`
