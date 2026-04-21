# Polyrepo 检测与手动配置

## 背景

**用户反馈（2026-04-21，trellis 用户 -js）**：

> 我试了下，一个目录下放 N 个 git 仓库，init 时强制 `--monorepo` 会报错
> 然后看了眼你的源码，发现只认特定的几个场景
> 比如前后端在不同仓库，但是想扔一起管，毕竟有些逻辑需要一起改

当前 `detectMonorepo()` (`packages/cli/src/utils/project-detector.ts:555`) 只识别 6 种 workspace marker：

| 检测源 | 文件 |
|---|---|
| Git submodule | `.gitmodules` |
| pnpm | `pnpm-workspace.yaml` |
| npm/yarn/bun | `package.json` 的 `workspaces` |
| Rust | `Cargo.toml` 的 `[workspace]` |
| Go | `go.work` |
| Python uv | `pyproject.toml` 的 `[tool.uv.workspace]` |

**Polyrepo 场景**（多个独立 `.git/` 放在同一目录，无 workspace 配置）完全不在检测范围内：
- 不是 submodule（没 `.gitmodules`）
- 不是 workspace（没配置文件）
- 但用户在概念上确实想"一起管"

`init.ts:732` 的分支：
```ts
if (options.monorepo === true && !detected) {
  console.log("Error: --monorepo specified but no monorepo configuration found.");
  process.exit(1);
}
```

→ 直接报错，没有可用的逃生舱。

---

## 任务目标

让 Trellis 能覆盖 polyrepo / meta-repo / 非标准多 package 布局，同时给出显式的手动配置入口。

---

## 设计

### 方案 A：自动扫描 `.git`（兜底 detector）

在 `detectMonorepo()` 的 parser 链**末尾**追加 `parsePolyrepo`，前面 6 个都 miss 才走它：

```ts
function parsePolyrepo(cwd: string): string[] | null {
  const children = fs.readdirSync(cwd, { withFileTypes: true });
  const dirs = children
    .filter(d => d.isDirectory())
    .filter(d => !d.name.startsWith(".") && d.name !== "node_modules")
    .filter(d => fs.existsSync(path.join(cwd, d.name, ".git")))
    .map(d => d.name);
  return dirs.length >= 2 ? dirs : null;
}
```

**约束：**
- 深度只扫**一层**（深扫会吸到 `node_modules/.pnpm/.../.git`）
- 至少 **2 个 `.git`** 才触发（单个可能是用户误 clone）
- 过滤 `.*`、`node_modules`、`target`、`dist`、`build` 等噪声目录
- `.git` 可能是**文件**（worktree / submodule gitlink）—— 用 `existsSync`，不加 `isDirectory()` 判断
- 只在其他 parser 全 miss 时才跑（否则 pnpm workspace 里某个 package 恰好是独立 clone 也会双重命中）

**新增 package type：** 在 `DetectedPackage` 里加一个 `isGitRepo: boolean` 或 `source: "workspace" | "submodule" | "polyrepo"` 字段，运行时 `packages_context.py` 能区分展示。

### 方案 B：手动配置（逃生舱）

#### B1. CLI flag

```bash
trellis init --packages frontend,backend
trellis init --packages "apps/*"  # glob 支持
```

语义：
- 传了 `--packages` → 完全绕过 auto-detect，直接用传入列表
- 可以和 `--monorepo` 共存（隐式开启 monorepo 模式）
- 空字符串 / 解析失败 → 报错，不 fallback

#### B2. config.yaml 手写

`.trellis/config.yaml`：

```yaml
packages:
  - name: frontend
    path: ./frontend
  - name: backend
    path: ./backend
```

init 时先读 config.yaml 的 `packages`，有就用它覆盖一切检测。

### 方案 A + B 的优先级

```
手动配置（config.yaml / --packages）
    ↓ 未配置
workspace parser（pnpm / npm / cargo / go / uv）
    ↓ 全 miss
.gitmodules submodule
    ↓ 也没有
parsePolyrepo（sibling .git 扫描）
    ↓ <2 个
null → 单 repo 模式
```

### 错误信息改进

`--monorepo` 未检测到时，当前只说"no monorepo configuration found"。改成：

```
Error: --monorepo specified but no multi-package layout detected.

Checked:
  ✗ pnpm-workspace.yaml
  ✗ package.json workspaces
  ✗ Cargo.toml [workspace]
  ✗ go.work
  ✗ pyproject.toml [tool.uv.workspace]
  ✗ .gitmodules
  ✗ sibling .git directories (found 0, need ≥ 2)

To force multi-package mode anyway, specify packages manually:
  trellis init --packages frontend,backend
```

---

## 子任务

### 1. 实现 `parsePolyrepo`

- [ ] 在 `project-detector.ts` 加 `parsePolyrepo` + 单元测试
- [ ] 接入 `detectMonorepo()` 的 parser 链末尾
- [ ] `DetectedPackage` 类型加 `source: "workspace" | "submodule" | "polyrepo"` 字段
- [ ] 运行时 `packages_context.py` 暴露该字段给 AI

### 2. 实现 `--packages` flag

- [ ] `cli/index.ts` 加 `--packages <list>` option
- [ ] `init.ts` 优先读取该 flag，绕过 auto-detect
- [ ] 支持 glob（`apps/*`），复用已有 `expandWorkspaceGlobs`
- [ ] 支持 `name:path` 语法（`--packages web:apps/web,api:apps/api`）？留作 stretch goal

### 3. 实现 config.yaml 的 `packages` 字段优先级

- [ ] init / update 时，config.yaml 里已有 `packages` 就跳过 auto-detect
- [ ] Schema 新增字段 + 文档

### 4. 错误信息改进

- [ ] `--monorepo` 失败时打印 checklist
- [ ] 明确引导用户到 `--packages` / `config.yaml`

### 5. 测试

- [ ] Polyrepo fixture（两个 sibling `.git` 目录）→ auto-detect 成功
- [ ] 单个 `.git` sibling → 不触发
- [ ] `node_modules` 里的 `.git` → 被过滤
- [ ] `--packages frontend,backend` → 精确命中
- [ ] `--packages` + 不存在的路径 → 报错
- [ ] config.yaml 手写 + auto-detect 冲突 → 手写优先

### 6. 文档

- [ ] `.trellis/spec/cli/backend/platform-integration.md` 加 "Polyrepo Detection" 节
- [ ] README 补 `--packages` flag 用法
- [ ] Changelog 注明新能力

---

## 非目标

- **不处理**跨 repo 的 git 操作（Trellis 不做 git 工具，只做 AI workflow 编排）
- **不处理**嵌套超过 1 层的 polyrepo（`apps/group/repo/.git`）—— 极少见，用户可走 `--packages` 手动指定
- **不自动**为每个子 repo 写 hook（各子 repo 有自己的 `.claude/` 时如何合并，另开任务讨论）

---

## 优先级

🟡 **P2** — 不阻塞 v0.5.0 发布，但首位外部用户就踩到，属于"小众但存在的真实需求"。P1/P3 之间。

## 风险

- `.git` sibling 扫描可能误伤：用户 `~/projects/` 下一堆独立项目，`trellis init` 会把所有项目当 package。Mitigation：`--polyrepo` 默认关闭，需显式 `--monorepo` 或 `--packages` 才触发
- `--packages` 和 auto-detect 同时出现时语义冲突：设计里明确了手动优先
- Config.yaml 的 `packages` 字段变成 breaking schema change：用 optional field，向后兼容

## 关联

- `04-17-hook-path-robustness` —— 独立问题，但同一批用户可能同时踩到
- `04-16-skill-first-refactor` —— 不直接关联
