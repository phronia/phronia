# Design — adopt managed-path kinds and migration tail

## 1. 现场与根因（证据）

| 事实 | 位置 |
|---|---|
| 文件型 managed path 被登记在目录字段里 | `packages/cli/src/types/ai-tools.ts:309-315`（copilot）、`:525-530`（snow） |
| 收尾阶段把每个 root 当目录遍历 | `packages/cli/src/commands/adopt.ts:433-448` → `:450-472` |
| 遍历只有 `existsSync` 守卫，没有 `isDirectory` | 同上 |
| 崩溃点在根目录改名之后、`.version` / report 之前 | `adopt.ts:105-140` |
| 只在 root 第一层扫描 `trellis-*`，嵌套 skill 目录扫不到 | `adopt.ts:456` |
| 冲突路径用 `process.cwd()` 而不是 adopt 的 `cwd` | `adopt.ts:467` |
| 目录/文件被同一个派生集合同时承载 | `ai-tools.ts:601-613`、`configurators/index.ts:135-141` |

复现：临时项目 + 旧 manifest（含 `.github/prompts/continue.prompt.md`）→ `adopt` 抛
`ENOTDIR: not a directory, scandir '<cwd>/.github/copilot-instructions.md'`。
同一份 fixture 加上一条 `isDirectory` 守卫后可跑完，说明崩溃点唯一。

## 2. 分层与职责

按 ADR-0003 的分层，本次改动只落在 L0 数据声明（`types/ai-tools.ts`）、L1 派生谓词
（`configurators/index.ts`）、L1 命令编排（`commands/adopt.ts` + 新工具模块），不触碰 shim。

```
types/ai-tools.ts         声明层：一个 platform 的 managed path 按“种类”分开登记
  ├─ configDir                       目录（主根）
  ├─ extraManagedDirs                目录（附加根）
  └─ managedFiles                    文件（叶子）

configurators/index.ts    派生层：两份集合，名字与用途一一对应
  ├─ ALL_MANAGED_PATHS  → isManagedPath / isManagedRootDir / update 备份
  └─ ALL_MANAGED_DIRS   → uninstall 清理 / ablate 领地判定 / adopt 目录遍历

utils/legacy-prefixed-entries.ts   算法层：plan / apply 两段式，纯函数 + 显式 IO 边界
commands/adopt.ts          编排层：阶段顺序、报告映射、失败回滚
```

核心约束（写进类型注释与 spec）：**目录型操作只能消费目录集合；文件型条目不得进入目录集合。**
这样"把文件当目录"不再是每个消费者各自要记住的纪律，而是数据形状本身保证的性质。

## 3. 数据模型

### 3.1 字段

`AIToolConfig`：

```ts
/** Additional managed directories beyond configDir (e.g. .github/hooks). */
extraManagedDirs?: string[];
/** Individual managed files beyond configDir (e.g. .github/copilot-instructions.md). */
managedFiles?: string[];
```

迁移：`extraManagedPaths` 拆成两项，`.github/copilot-instructions.md` → copilot `managedFiles`，
`.snow/SNOW.md` → snow `managedFiles`；其余条目原样进入 `extraManagedDirs`。

### 3.2 访问器（`types/ai-tools.ts`）

```ts
getManagedPaths(tool): string[]       // configDir + (.agents/skills) + extraManagedDirs + managedFiles
getManagedDirs(tool):  string[]       // configDir + (.agents/skills) + extraManagedDirs
getManagedFiles(tool): string[]       // managedFiles
getPlatformOwnedPaths(tool): string[] // configDir + extraManagedDirs + managedFiles（排除共享 .agents/skills）
```

`getManagedPaths()` 的集合内容与改动前一致，顺序为 configDir → `.agents/skills` → 目录 → 文件
（Copilot/Snow 的文件条目由原来的 extras 位置移到末尾，只影响 `platforms --json` 的展示顺序，
不影响 manifest key 或备份内容）。`getManagedDirs()` 是新增的目录视图；`getPlatformOwnedPaths()`
排除共享的 `.agents/skills`，供平台检测使用。

### 3.3 派生集合（`configurators/index.ts`）

```ts
PLATFORM_MANAGED_PATHS  = PLATFORM_IDS.flatMap(getManagedPaths)
PLATFORM_MANAGED_DIRS   = PLATFORM_IDS.flatMap(getManagedDirs)
ALL_MANAGED_PATHS       = [".phronia", ...new Set(PLATFORM_MANAGED_PATHS)]
ALL_MANAGED_DIRS        = [".phronia", ...new Set(PLATFORM_MANAGED_DIRS)]
```

| 消费者 | 使用 | 原因 |
|---|---|---|
| `isManagedPath` / `isManagedRootDir` | `ALL_MANAGED_PATHS` | 路径级门禁必须覆盖文件；否则 `.github/copilot-instructions.md` 变成"非托管"，删除/写入失去保护 |
| `update.ts` `BACKUP_DIRS` | `ALL_MANAGED_PATHS` | `collectAllFiles()` 已支持文件根；换成目录集合会静默漏备份两个文件 |
| `utils/managed-removal.ts` | `ALL_MANAGED_DIRS` | 只清理空目录（已先 stat 跳过非目录，语义不变，只是不再有文件条目） |
| `ablate.ts` `isManagedDirectoryTerritory` | `ALL_MANAGED_DIRS` | 领地判定是目录概念；`.github/*` 目录条目仍在，结果不变 |
| `adopt.ts` 备份 | `getManagedPaths` | 备份必须看见文件 |
| `adopt.ts` 平台检测 | `getPlatformOwnedPaths` | 共享的 `.agents/skills` 不能用来判定平台，否则所有共享平台同时命中 |
| `adopt.ts` legacy 前缀收尾 | `getManagedDirs` | 这是本次崩溃点 |

`isManagedRootDir` 的注释改为"managed root（文件或目录），整体不可删除"，名字保留（调用点都是
`cleanupEmptyDirs` 的内部约束，语义未变）。

## 4. Legacy 前缀收尾：plan / apply

新模块 `packages/cli/src/utils/legacy-prefixed-entries.ts`。抽出来的理由：这段逻辑有三个职责
（递归遍历、空树判定、改名/冲突决策），继续塞在 `adopt.ts` 里既不可测也不可复用；`update.ts` 的
plan/apply 分层是仓库既有范式。

### 4.1 契约

```ts
export interface LegacyRetirementOptions {
  cwd: string;
  /** Managed directory roots (relative paths), from getManagedDirs(). */
  roots: readonly string[];
  /** Posix paths already removed (apply) or slated for removal (dry-run). */
  removedFiles?: ReadonlySet<string>;
  prefix?: string;       // default "trellis-"
  replacement?: string;  // default "phronia-"
}

export interface LegacyRetirementPlan {
  renames: Array<{ from: string; to: string }>; // posix, relative to cwd
  prunes: string[];                             // posix, relative to cwd
  conflicts: string[];                          // posix, relative to cwd
}

export function planLegacyRetirement(o: LegacyRetirementOptions): LegacyRetirementPlan;
export function applyLegacyRetirement(
  o: LegacyRetirementOptions,
  plan: LegacyRetirementPlan,
): LegacyRetirementPlan; // 返回实际执行结果（apply 时重新校验磁盘）
```

### 4.2 算法

对每个 root（去重、排序，保证报告稳定）：

1. 递归列出条目；跳过符号链接；不进 `.git`。
2. 命中 `trellis-*` 的条目作为一个整体处理，不再下钻：
   - **文件**：`phronia-*` 目标存在 → `conflicts`；否则 `renames`。
   - **目录**：目录子树内（扣除 `removedFiles`）没有文件 → `prunes`；
     目标存在 → `conflicts`；否则 `renames`。
3. `apply` 阶段逐条：
   - rename：源存在且目标不存在才执行，否则降级为 conflict；
   - prune：源是目录且子树为空才 `rmdirSync`（递归删空子目录），否则降级为 conflict。
   
   apply 的再次校验是 filesystem-safety 的既有要求（"Rename onto a possibly-existing target"）。

### 4.3 与 adopt 报告映射（报告 schema 不变）

| 计划项 | `AdoptReport` 字段 |
|---|---|
| rename 成功 | `regenerated` |
| prune 成功 | `dropped` |
| conflict（含 apply 降级） | `needsReview` |

dry-run：`planPristineDeletions()` 已经算出"会被删掉的 pristine 文件"集合；把它作为 `removedFiles`
传给 `planLegacyRetirement()`，于是 dry-run 能预测"目录在删除 pristine 文件后变空 → prune"，
与真实执行一致。

## 5. 失败回滚

```ts
report.backupDir = createBackup(...);
fs.renameSync(legacyDir, currentDir);
try {
  ... 删除 pristine / 刷新 workflow / preserve / configure / retire / version / hashes / report ...
} catch (error) {
  const rollback = restoreLegacyRoot(cwd, legacyDir, currentDir);
  throw adoptFailure(error, report.backupDir, rollback);
}
```

`restoreLegacyRoot()`：

- 仅当 `currentDir` 存在且是目录、`legacyDir` 不存在时执行 `renameSync(currentDir, legacyDir)`；
- 返回 `"restored" | "skipped" | "failed"`；自身异常吞掉并返回 `"failed"`，绝不掩盖原始错误。

错误信息（英文，与 CLI 其余输出一致）：

```
adopt failed after moving .trellis/ to .phronia/: <cause>.
The workflow root was restored to .trellis/ — fix the reported problem and re-run `phronia adopt`.
Backup: <backupDir>
```

或 `...could not be restored; move .phronia/ back to .trellis/ manually before retrying.`
原始错误通过 `cause` 保留，`--json` 路径不受影响（错误仍走 stderr + exit 1）。

**不覆盖**：已经写出的平台文件不回滚（备份是权威副本，且模板可重建）；`.pre-adopt` 文件保留
（它们是用户内容的证据，重跑不会阻塞，因为 `assertAdoptable` 只看根目录）。

## 6. 兼容性

| 面 | 变化 |
|---|---|
| CLI 输出 / 报告 schema | 键集合不变；`needs-review` 里不再出现由目录名竞争产生的条目 |
| `.phronia/.template-hashes.json` | 不变（adopt 的 initializeHashes 逻辑未动） |
| 平台文件集合 | 不变（`getManagedPaths` 输出等价） |
| 内部类型 | `AIToolConfig.extraManagedPaths` → `extraManagedDirs` + `managedFiles`；无 `exports` 映射，包外不可见 |
| `ALL_MANAGED_DIRS` | 值变窄（不再含两个文件条目）；`ALL_MANAGED_PATHS` 是等价的旧全集 |
| upstream 0.5.x/0.6.x 迁移 | 不变；本次修复只让这条路径能跑完 |

## 7. 备选方案与否决理由

- **只加 `statSync().isDirectory()` 守卫**：一条线修掉崩溃，但注册表继续撒谎，下一个目录型消费者仍会踩；
  用户明确要求按长期可维护方式做。作为 `apply` 的二次校验保留，不作为主修复。
- **用扩展名推断种类**：`.md` 目录、无扩展名文件都合法，推断必然错。
- **把文件条目移出 `extraManagedPaths`，只靠 `collectTemplates()` 推导目录**：模板 map 是渲染结果，
  依赖运行期选项（adapter 变体），不适合做静态 managed-root 来源；且 `isManagedPath` 需要不渲染即可判定。
- **把 `.snow/SNOW.md` / copilot instructions 从 managed 语义里删掉**：会破坏路径门禁与备份。
- **完全不 rename legacy 目录，只 prune 空目录**：有用户内容的 `trellis-*` 目录会永远留在旧名下，
  与"skills 统一 phronia-*"的迁移目标冲突。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| `ALL_MANAGED_DIRS` 值变化影响未审计的消费者 | 全仓 grep 后逐一列表（见 §3.3）；测试断言两份集合的关系 |
| 递归遍历误删用户目录 | 只处理 `trellis-*`；prune 仅限"子树内零文件"；符号链接不跟随；apply 二次校验 |
| 回滚把 `.phronia` 改名回 `.trellis` 时目标已存在 | `restoreLegacyRoot` 先检查 `legacyDir` 不存在才动 |
| 报告顺序不稳定导致测试脆弱 | roots 去重排序，遍历顺序固定 |
| 真实项目目录很大导致遍历慢 | 只遍历 managed roots（15 个平台目录），不是整个仓库 |

## 9. 测试策略

fixture 一律用 `fs.mkdtempSync` + 旧 manifest（沿用 `test/commands/adopt.test.ts` 的 `seedLegacyProject`
风格），不依赖网络。

| 用例 | 断言 |
|---|---|
| Copilot 平台端到端 | `adopt()` resolve；`.phronia/.version` 存在；`.github/copilot-instructions.md` 存在；报告无 `ENOTDIR` |
| 空 legacy 目录 | `.cursor/skills/trellis-check/SKILL.md` pristine → 目录不存在，且不计入 `needsReview` |
| 有内容、目标不存在 | 用户自定义 `.kiro/skills/trellis-custom/notes.md` → 改成 `phronia-custom/`，进 `regenerated` |
| 有内容、目标已存在 | configure 已写 `phronia-check/` + 用户目录 `trellis-check/` → 保留、进 `needsReview`，路径相对项目根 |
| dry-run 预测 | `dryRun: true` 报告的 prune 集合与随后真实执行为空目录集合一致，且磁盘未变 |
| 失败回滚 | 预置 `.cursor` 为普通文件使 configure 抛 ENOTDIR → `adopt()` reject；`.trellis` 存在、`.phronia` 不存在；错误信息含 backup 路径 |
| 注册表不变量 | 每个 platform：`getManagedDirs()` 不含 `managedFiles` 条目；`getManagedPaths()` 含；`ALL_MANAGED_DIRS` 不含文件；`isManagedPath('.github/copilot-instructions.md')` 为真 |
| 既有用例 | `refuses ambiguous states` / `dry-run changes nothing` / `refreshes the workflow tree` 保持通过 |

## 10. 发布与回退

- 单个 PR，不涉及数据迁移；修复随下一个补丁版本发布。
- 回退：`git revert` 即可。adopt 是一次性命令；已迁移的项目不受影响。
- 用户可见变化记入 `docs/migrations/user-visible-changes.md`（adopt 在 Copilot/Snow 项目上可运行；
  收尾不再残留空 `trellis-*` 目录；失败时自动恢复 `.trellis`）。
- adboost 的迁移在发版后由用户重新执行；本次不接触 adboost 仓库。
