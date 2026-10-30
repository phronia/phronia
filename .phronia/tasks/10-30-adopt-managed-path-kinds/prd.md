# Fix adopt managed-path kinds and migration tail

> 现场：2026-10-30，用户对 adboost（Trellis 0.5.19）执行 `phronia adopt`，在 `.github/copilot-instructions.md` 上崩溃：
> `ENOTDIR: not a directory, scandir '…/adboost/.github/copilot-instructions.md'`。
> 关联契约：`docs/adr/0002-naming-and-migration.md`（adopt 契约）、`docs/adr/0003-layered-architecture.md`（分层）、
> `.phronia/spec/cli/backend/platform-integration.md`、`.phronia/spec/cli/backend/filesystem-safety.md`。

## Problem

`adopt` 的收尾阶段把所有 "managed path" 都当目录遍历。`AI_TOOLS[*].extraManagedPaths` 里混着两个**文件**条目
（`.github/copilot-instructions.md`、`.snow/SNOW.md`），`renameLegacyDirectories()` 对它们调用
`fs.readdirSync()`，在 Copilot / Snow 项目上必然抛 `ENOTDIR`。

崩溃发生在 `.trellis` 已被改名为 `.phronia` 之后、`.version` 与 `adopt-report.md` 写入之前，于是项目停在一个
不可重跑的状态：`.trellis` 消失、`.phronia` 半成品残留，再跑 `adopt` 只会得到
`Both .trellis/ and .phronia/ exist`；用户只能手工清理或从备份恢复。

同一处代码还有两个长期问题：

1. **空目录残留**：`renamePrefixedEntries()` 只在每个 managed root 的**第一层**扫描 `trellis-*`，而多数平台的
   skill 目录嵌在第二层（`.cursor/skills/trellis-*`）。pristine 文件被 `removeIfPristine()` 删掉后，空目录
   永远留在用户工作树里；对 `.github/skills`、`.kiro/skills` 这类被登记为根的路径，又会在 configure 之后
   把"目标已存在"误报成 16 条 `needs-review` 冲突。
2. **命名撒谎**：`extraManagedPaths` / `PLATFORM_MANAGED_DIRS` / `ALL_MANAGED_DIRS` 同时装文件和目录，
   每一处消费者都得自己记得"这里可能有文件"。adopt 只是第一个踩中的消费者。

## Goals

- 让 managed path 的**种类**成为元数据的一部分：目录与文件由注册表单一声明，目录型操作只拿到目录。
- 让 `adopt` 在 Copilot / Snow / 混合平台项目上跑完整个迁移，且收尾后的工作树不残留空 `trellis-*` 目录、
  不产生假冲突。
- 让 `adopt` 失败可恢复：根目录改名后若后续步骤失败，自动回滚到 `.trellis`，并给出包含备份路径的错误信息。
- 用回归测试锁住以上行为，并把"文件型 managed path 该怎么登记"写进平台接入规范。

## Non-Goals

- 不做 `adopt` 全量事务化（不改平台文件的回滚策略；它们由模板重建，备份已覆盖）。
- 不重放 upstream 迁移清单，不改 `adopt` 的备份/hash 契约与报告格式。
- 不新增平台、不改任何平台的 `configDir`、不改 manifest schema。
- 不动 adboost 仓库本身：等 Phronia 发版后由用户重新执行 `phronia adopt`。

## Requirements

### R1 崩溃修复

在含 Copilot（`.github/copilot-instructions.md`）或 Snow（`.snow/SNOW.md`）的 legacy 项目上，`adopt`
必须成功完成，不得出现 `ENOTDIR`。

### R2 来源分层

managed path 元数据必须显式区分**目录**与**文件**：

- 目录型条目只能出现在目录字段中；
- 文件型条目只能出现在文件字段中；
- 所有"按目录遍历/清理/改名"的消费者只能拿到目录集合。

### R3 路径级语义不退化

`isManagedPath()`、备份范围、卸载清理等路径级语义必须继续覆盖文件型 managed path（不得因为 R2 而漏管）。

### R4 收尾清理

`adopt` 对 legacy `trellis-*` 前缀条目必须：

- 目录递归为空 → 删除（并向上清理变空的父目录，但不越过 managed root）；
- 有内容、目标 `phronia-*` 不存在 → 重命名；
- 有内容、目标已存在 → 原地保留并列入 `needs-review`，路径相对**项目根**；
- dry-run 必须预测同样的结果，且不落盘。

### R5 失败可恢复

根目录改名之后任一步骤失败时，`adopt` 必须把 `.phronia` 改名回 `.trellis`（在安全前提下），
抛出包含「原始错误 + 备份路径 + 回滚结果」的可操作错误，使修复版本发布后可以直接重跑。

### R6 回归测试

必须新增覆盖：Copilot 平台端到端、空/非空 legacy 目录处置、失败回滚、注册表种类不变量。

### R7 文档

`platform-integration.md` 写明文件型 managed path 的登记方式；
`docs/migrations/user-visible-changes.md` 记录 adopt 的行为变化。

### R8 兼容性

- 不新增运行时依赖；
- `.trellis` 0.5.x / 0.6.x 的迁移路径与报告字段不变；
- 成功后的 `adopt` 仍拒绝重跑，并给出清晰信息。

## Acceptance Criteria

- [x] A1：`pnpm --filter @phronia/cli test` 全绿，且新增用例覆盖 R1 / R4 / R5 / R6。
- [x] A2：`pnpm lint && pnpm typecheck` 通过。
- [x] A3：本地用 adboost 的完整副本（从 0.5.19 起）跑 `adopt` 成功，报告无 `ENOTDIR`；工作树不残留空
      `trellis-*` 目录；`needs-review` 不再包含"目录名竞争"产生的条目（协议允许的保守项——旧 manifest
      未跟踪的生成文件如 `.gitignore` 仍以 `.pre-adopt` 保留——不计入）。
- [x] A4：注册表不变量成立：`getManagedDirs()` 不返回文件条目，`getManagedPaths()` 仍返回文件条目，
      `isManagedPath(".github/copilot-instructions.md")` 为真。
- [x] A5：回滚用例成立：configure 失败后 `.trellis` 存在、`.phronia` 不存在、错误信息含备份路径。
- [x] A6：R7 的两处文档已更新。
- [x] A7：`git diff` 不包含与任务无关的格式化/重排噪音。

## Notes

- 本任务修复后不直接重跑 adboost；发布新版本后才迁移。
- 备份样本：`~/.phronia/backups/63f441894c14/2026-10-30T10-36-17-453Z/`（含 `.trellis`、`.github`、
  `.claude`、`.codex`、`.cursor`、`.kilocode`、`.kiro`、`.opencode`、`.qoder`、`AGENTS.md`）。
