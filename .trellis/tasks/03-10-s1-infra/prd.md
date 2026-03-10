# S1: Monorepo 检测 + config 基础设施

> Parent: `03-10-v040-beta1`

## Goal

建立 monorepo 支持的底层基础设施，包括检测、配置读写、路径工具、init 流程适配，使后续 Sprint 可以基于这些基础构建。

## Scope

### 1.1 Monorepo 检测 (`project-detector.ts`)

**现状**: `detectProjectType(cwd)` 只返回 `frontend | backend | fullstack`，不识别 monorepo。

**新增 `detectMonorepo(cwd): MonorepoInfo | null`**:

检测指标：
- `pnpm-workspace.yaml` → pnpm workspaces
- `package.json` 内 `workspaces` 字段 → npm/yarn workspaces
- `turbo.json` → Turborepo
- `nx.json` → Nx
- `lerna.json` → Lerna
- `.gitmodules` → Git submodules

返回值：
```ts
interface MonorepoInfo {
  tool: string           // "pnpm" | "npm" | "yarn" | "turbo" | "nx" | "lerna" | "submodules"
  packages: PackageInfo[]
}
interface PackageInfo {
  name: string
  path: string
  type: ProjectType      // 对每个 package 调用 detectProjectType()
}
```

### 1.2 config.yaml 模板 + config.py 读取

**config.yaml 模板新增**（默认注释掉）:
```yaml
# packages:
#   frontend:
#     path: packages/frontend
#   backend:
#     path: packages/backend
#     type: submodule
# default_package: frontend
```

**config.py 模板新增函数**:
- `get_packages() -> dict | None`
- `get_default_package() -> str | None`
- `get_submodule_packages() -> list[str]`
- `is_monorepo() -> bool`
- `get_spec_base(package: str | None = None) -> str`

### 1.3 paths.py 适配

新增：
- `get_spec_dir(package: str | None = None) -> Path`
- `get_package_path(package: str) -> Path`

### 1.4 init.ts 适配

- 调用 `detectMonorepo(cwd)`
- 检测到 monorepo → 询问用户是否启用
  - 是 → 将 packages 写入 `config.yaml`，为每个 package 创建 `spec/<name>/<layer>/`
  - 否 → 走现有单仓逻辑
- 新增 `--monorepo` / `--no-monorepo` flag

### 1.5 workflow.ts 适配

- `createSpecTemplates()` 接收 `MonorepoInfo | null`
- Monorepo: 为每个 package 创建 `spec/<name>/<layer>/index.md`
- 单仓: 不变

### 1.6 get_context.py 模板增强

新增 `--mode packages` 输出：
```
Available packages:
  cli          packages/cli        [backend, frontend, unit-test]
  docs-site    docs-site           [docs]  (submodule)
Default package: cli
```

无 `packages` 配置时输出 `(single-repo mode)`。

---

## 受影响文件

| 文件 | 改动类型 |
|------|----------|
| `packages/cli/src/utils/project-detector.ts` | 新增 `detectMonorepo()` |
| `packages/cli/src/commands/init.ts` | monorepo 检测 + flag + spec 创建 |
| `packages/cli/src/configurators/workflow.ts` | `createSpecTemplates()` 支持 monorepo |
| `packages/cli/src/templates/trellis/config.yaml` | 新增 packages 注释块 |
| `packages/cli/src/templates/trellis/scripts/common/config.py` | 新增 5 个函数 |
| `packages/cli/src/templates/trellis/scripts/common/paths.py` | 新增 2 个函数 |
| `packages/cli/src/templates/trellis/scripts/get_context.py` | `--mode packages` |

## Acceptance Criteria

- [ ] `detectMonorepo()` 正确检测 pnpm/npm/yarn/nx/lerna workspace
- [ ] `trellis init` 在 monorepo 项目中询问并创建正确的目录结构
- [ ] `--monorepo` / `--no-monorepo` flag 工作正常
- [ ] `config.py` 函数在 monorepo 和单仓模式下都返回正确值
- [ ] `get_context.py --mode packages` 输出结构化包信息
- [ ] 单仓项目 `trellis init` 行为完全不变
- [ ] 新增单测覆盖 detectMonorepo、config.py 函数
