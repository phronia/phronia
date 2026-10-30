# Implement — adopt managed-path kinds and migration tail

执行顺序按"先让数据说真话，再改消费者，再改算法，最后补编排/测试/文档"。每一步都可单独编译，
任一步失败可 `git checkout -- <paths>` 回到上一步。

## 0. 准备

- [ ] 0.1 确认基线：`git status --short`（只允许任务目录未跟踪），`pnpm --filter @phronia/cli test` 先跑一遍记录基线。
- [ ] 0.2 记录全仓引用面：`grep -rn "extraManagedPaths" packages docs .phronia/spec`，预期命中
      `types/ai-tools.ts`、`commands/adopt.ts`（3 处）、`test/configurators/platforms.test.ts`、
      `test/regression.test.ts`、docs-site changelog（历史文档，不改）。

## 1. 注册表：目录与文件分开（数据层）

- [ ] 1.1 `packages/cli/src/types/ai-tools.ts`
      - `extraManagedPaths?: string[]` → `extraManagedDirs?: string[]`（注释改为 "directories"）；
      - 新增 `managedFiles?: string[]`（注释说明"individual managed files"）；
      - `copilot`：`.github/copilot-instructions.md` 从 extras 移到 `managedFiles`；
      - `snow`：`.snow/SNOW.md` 同理；
      - 新增 `getManagedDirs(tool)`、`getManagedFiles(tool)`，`getManagedPaths(tool)` 改为
        `configDir + .agents/skills + extraManagedDirs + managedFiles`（顺序不变）。
- [ ] 1.2 其余平台的 extras 只做字段改名，值不动（`.kiro/*`、`.agent/*`、`.devin/*`、`.zcode/*`、
      `.grok/*`）。
- [ ] 1.3 `pnpm --filter @phronia/cli typecheck` —— 用编译错误列出所有待改消费点（预期 adopt.ts 3 处、
      测试 2 处）。

**Gate 1**：`git diff packages/cli/src/types/ai-tools.ts` 只包含字段拆分与访问器新增。

## 2. 派生集合与消费者（谓词层）

- [ ] 2.1 `packages/cli/src/configurators/index.ts`
      - 新增 `PLATFORM_MANAGED_PATHS`（`getManagedPaths`）与 `PLATFORM_MANAGED_DIRS`（`getManagedDirs`）；
      - `ALL_MANAGED_PATHS = [".phronia", ...new Set(PLATFORM_MANAGED_PATHS)]`；
      - `ALL_MANAGED_DIRS = [".phronia", ...new Set(PLATFORM_MANAGED_DIRS)]`；
      - `isManagedPath()` / `isManagedRootDir()` 改用 `ALL_MANAGED_PATHS`，注释写明"root 可以是文件"。
- [ ] 2.2 `packages/cli/src/commands/update.ts`：`BACKUP_DIRS = ALL_MANAGED_PATHS`（必要时把局部常量
      改名为 `BACKUP_ROOTS` 并保留注释：文件根由 `collectAllFiles()` 处理）。
- [ ] 2.3 审计并确认其余消费者用目录集合：`utils/managed-removal.ts`、`commands/ablate.ts`
      （它们已在 `ALL_MANAGED_DIRS` 上，语义不变，不改代码，只在 commit message 里说明）。
- [ ] 2.4 `pnpm --filter @phronia/cli typecheck && pnpm --filter @phronia/cli test -- configurators`

**Gate 2**：`isManagedPath(".github/copilot-instructions.md") === true` 且
`.snow/SNOW.md` 同样为真；`ALL_MANAGED_DIRS` 不含这两个值。

## 3. Legacy 前缀收尾（算法层）

- [ ] 3.1 新建 `packages/cli/src/utils/legacy-prefixed-entries.ts`，按 design §4.1 暴露
      `planLegacyRetirement()` / `applyLegacyRetirement()`。
- [ ] 3.2 实现要点：
      - roots 去重 + `localeCompare` 排序；
      - 递归遍历跳过符号链接与 `.git`；命中 `trellis-*` 后不再下钻；
      - 目录"空"的定义：子树内没有任何文件，且不在 `removedFiles` 中的文件也不算；
      - 输出 posix 相对 `cwd` 的路径；
      - apply 重新校验（源在、目标不在、目录确为空），不满足则降级为 conflict；
      - 不删除 managed root 本身，prune 只发生在 `trellis-*` 子树内。
- [ ] 3.3 为该模块写纯函数单测（可直接在 step 5 的 adopt 测试里覆盖，也可单独文件）。

## 4. adopt 编排（命令层）

- [ ] 4.1 `packages/cli/src/commands/adopt.ts`
      - `detectPlatforms()` / `createBackup()` 用 `getManagedPaths(platform)`；
      - 删除 `renameLegacyDirectories()` / `renamePrefixedEntries()`，改为：
        非 dry-run → `applyLegacyRetirement({cwd, roots: 各平台 getManagedDirs 去重})`；
        dry-run → `planLegacyRetirement({..., removedFiles: pristine 集合})`；
      - 报告映射：renames → `regenerated`，prunes → `dropped`，conflicts → `needsReview`（去重）。
- [ ] 4.2 dry-run：让 `planPristineDeletions()` 返回/复用它算出的可删集合，供给 retire 的
      `removedFiles`；`planWorkflowRefresh()` 与 `planConflicts()` 行为不变。
- [ ] 4.3 失败回滚：把 `renameSync(legacyDir, currentDir)` 之后的整段包进 `try/catch`；
      新增 `restoreLegacyRoot()`（design §5 的三种返回值）与错误信息拼装；`cause` 保留原始错误。
- [ ] 4.4 清理不再使用的 import（`cleanupEmptyDirs` 若不再需要则移除；确认没有死代码）。

**Gate 3**：`pnpm --filter @phronia/cli typecheck` 通过；`adopt.ts` 中不再有 `readdirSync` 直接遍历
managed root 的代码（`grep -n readdirSync commands/adopt.ts` 应为空）。

## 5. 回归测试

- [ ] 5.1 `packages/cli/test/commands/adopt.test.ts` 扩充 `seedLegacyProject`，允许按需种入平台：
      - Copilot 平台（manifest 键 `.github/prompts/continue.prompt.md`）端到端；
      - 空 `trellis-*` skill 目录被 prune；
      - 非空 `trellis-*` 目录 rename；
      - 目标已存在时报告 conflict，路径相对项目根；
      - dry-run 预测与真实执行一致；
      - 失败回滚（`.cursor` 预置为文件）。
- [ ] 5.2 `packages/cli/test/configurators/index.test.ts`：新增注册表不变量用例
      （`getManagedDirs` / `getManagedPaths` / `ALL_MANAGED_DIRS` / `isManagedPath`）。
- [ ] 5.3 更新因字段改名而失败的两个既有测试文件（`configurators/platforms.test.ts`、
      `regression.test.ts`）——只改字段名，不改断言意图。
- [ ] 5.4 `pnpm --filter @phronia/cli test` 全绿。

**Gate 4**：新增用例在未打补丁的 `HEAD` 上会失败（至少 Copilot 与回滚用例），在补丁后通过。

## 6. 文档

- [ ] 6.1 `.phronia/spec/cli/backend/platform-integration.md`：Step 2 增加一条规则
      「文件型 managed path 写 `managedFiles`，目录写 `extraManagedDirs`；目录型操作只读 `getManagedDirs()`」，
      并说明违反时的症状（ENOTDIR）。
- [ ] 6.2 `docs/migrations/user-visible-changes.md`：在 Unreleased 段追加 adopt 条目
      （Copilot/Snow 可跑、收尾清理、失败自动恢复）。
- [ ] 6.3 不修改 docs-site 历史 changelog。

## 7. 端到端验证

- [ ] 7.1 `pnpm lint && pnpm typecheck`。
- [ ] 7.2 构建后用手工 fixture 复跑本任务记录的复现脚本（copilot + 嵌套 skill 目录）。
- [ ] 7.3 用 adboost 的只读副本（`rsync` 到 `/tmp`，排除 `.git`、`target`、`.phronia`、`node_modules`）
      跑 `node packages/cli/bin/phronia.js adopt --force --backup-root /tmp/...`：
      - 报告无 `ENOTDIR`；
      - `find . -type d -name 'trellis-*'` 为空；
      - `needs-review` 只剩真实用户改动（`.opencode/package.json`、`.phronia/.gitignore`）。
      验证后删除临时目录，不改动 adboost 仓库。
- [ ] 7.4 `pnpm test:contract`（若涉及 parity/contract 断言）。

## 8. 收尾

- [ ] 8.1 `git diff --stat` 复核范围：只有 `types/ai-tools.ts`、`configurators/index.ts`、
      `commands/adopt.ts`、`commands/update.ts`、`utils/legacy-prefixed-entries.ts`、两个测试文件、
      两个文档。
- [ ] 8.2 更新 `.phronia/spec` 若有新契约（step 6.1 已完成则跳过）。
- [ ] 8.3 commit（`fix(cli): …`），PR 描述里附上 ENOTDIR 复现步骤与 adboost 副本验证结果。

## 验证命令速查

```bash
pnpm --filter @phronia/cli typecheck
pnpm --filter @phronia/cli test -- commands/adopt
pnpm --filter @phronia/cli test -- configurators
pnpm --filter @phronia/cli test
pnpm lint && pnpm typecheck
```

## 回滚点

| 阶段 | 回滚方式 |
|---|---|
| step 1-2 之后 | `git checkout -- packages/cli/src/types packages/cli/src/configurators packages/cli/src/commands/update.ts` |
| step 3-4 之后 | 追加 `packages/cli/src/commands/adopt.ts packages/cli/src/utils/legacy-prefixed-entries.ts` |
| step 5-6 之后 | `git checkout -- .`（测试与文档全部回退） |
| 发布后 | `git revert <commit>`；adopt 是一次性命令，无数据迁移 |
