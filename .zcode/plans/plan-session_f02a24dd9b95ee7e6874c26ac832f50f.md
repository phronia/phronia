## 目标

让 `@phronia/cli` 与已安装的 `@mindfoldhq/trellis` 可以并存，不再要求用户卸载旧 CLI；同时保留有价值的旧兼容语义（env 映射、trellis-* agent 名、旧 marker 迁移），并把 `.trellis` 项目的迁移入口统一到 `phronia adopt`。

当前 2610.27.5 已从 npm bin 中移除 `trellis`/`tl`，但还有 5 处代码/文档未跟上，需要一起收口。

## 实施步骤

### 1. 防止 staging 重新引入冲突 bin
- 修改 `packages/runtime/scripts/package-npm.mjs`：staged `@phronia/cli` 的 `bin` 只保留 `phronia`。
- 增加断言/测试读取 `pnpm pack` 后的 package.json，确认没有 `trellis`/`tl`。

### 2. `phronia init` 加 `.trellis` 迁移守卫
- 在 `packages/cli/src/commands/init.ts` 的首次初始化判断处：
  - 若 `.trellis/` 存在且 `.phronia/` 不存在，直接失败（exit 2），输出：
    ```
    Detected a Trellis project (.trellis/).
    Run `phronia adopt --dry-run` first, then `phronia adopt`.
    ```
  - 不创建 `.phronia`，不自动迁移。
  - 两者都存在时保持现有 reinit 行为。
- 加集成测试：fixture 有 `.trellis`、无 `.phronia`，调用 `init()` 应拒绝且不写 `.phronia`。

### 3. `update` 的未初始化提示
- `packages/cli/src/commands/update.ts` 中把 `Run 'trellis init' first.` 改为：
  - 若 `.trellis` 存在：`Run 'phronia adopt' first.`
  - 否则：`Run 'phronia init' first.`
- 保持退出码不变。

### 4. 修正 legacy notice 措辞
- `packages/cli/src/cli/index.ts` 中 `trellis` basename 的提示改为：
  ```
  ℹ️  `trellis` is a manual legacy compatibility entry point; use `phronia`.
  ```
- 不再声称 npm 安装的 one-major alias；`tl` 不再提及。

### 5. 文档：明确“不需要卸载”
- 更新 `docs/migrations/user-visible-changes.md`：新旧 CLI 可并存；`trellis` 仍是旧工具；迁移后使用 `phronia`。
- 更新 `docs/adr/0002-naming-and-migration.md`：兼容窗口保留 env/agent/marker 语义，不保留 npm bin。
- 在 `README.md` 安装段增加：
  ```bash
  npm install -g @phronia/cli   # does not replace an existing @mindfoldhq/trellis
  phronia adopt --dry-run       # for an existing .trellis project
  phronia adopt
  ```
- 保留 `bin/trellis.js` 作为手动软链入口，并在文档中说明。

### 6. 验证
- `pnpm verify`。
- `pnpm pack` 检查 bin 只有 `phronia`。
- 新增/更新测试：
  - init 拒绝 `.trellis` 项目；
  - update 提示 adopt；
  - staging manifest bin；
  - adopt dry-run/真实迁移仍通过现有测试。
- 本地模拟：同时存在 `@mindfoldhq/trellis` 与 `@phronia/cli` 时，`phronia` 可正常安装/运行。

### 7. 发布
- `omv bump` 到 `2610.27.6`，构建、更新 dogfood 文件。
- 提交并推送 `main`。
- 创建 GitHub Release `v2610.27.6` 触发 npm publish。
- 发布后 `npm install -g @phronia/cli` 不再与旧 `trellis` 冲突。

## 不做什么

- 不要求用户卸载 `@mindfoldhq/trellis`。
- 不自动删除 `.trellis`；迁移必须显式执行 `phronia adopt`。
- 不把 `trellis` 命令重新加回 npm bin。
- 不自动把旧 `trellis` 软链改指到 Phronia。