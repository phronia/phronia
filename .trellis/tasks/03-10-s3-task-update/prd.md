# S3: Task package 字段 + Update 兼容

> Parent: `03-10-v040-beta1` | Depends on: S1

## Goal

Task 系统感知 package，Update 命令安全兼容 monorepo spec 目录结构。

## Scope

### 3.1 task.py `--package` 参数

- `task.py create --package <name>` — task.json 新增 `"package"` 可选字段
- `task.py init-context --package <name>` — 用 package 解析 spec 路径 `spec/<package>/<layer>/`
- `task.py list` — 显示 package 列（`@cli` 形式）
- 无 `--package` 时 fallback: `get_default_package()` → 硬编码 fallback

### 3.2 add_session.py `--package` 标记

可选 `--package` 参数，记录到 journal session 元数据。

### 3.3 update.ts PROTECTED_PATHS 验证

确保 `PROTECTED_PATHS` 中的 `.trellis/spec` 在 monorepo 目录结构下仍正确保护，不误删 `spec/<package>/` 子目录。

### 3.4 Migration 支持

新增 migration：当用户从单仓升级到 monorepo 时：
- 检测到 config.yaml 新增 `packages:` 字段
- 提示用户手动重组 spec 目录（不自动移动，太危险）

---

## 受影响文件

| 文件 | 改动 |
|------|------|
| `packages/cli/src/templates/trellis/scripts/task.py` | `--package` 参数 + init-context 路径 |
| `packages/cli/src/templates/trellis/scripts/add_session.py` | `--package` 可选参数 |
| `packages/cli/src/commands/update.ts` | 验证 PROTECTED_PATHS，可能无需改 |
| `packages/cli/src/migrations/` | 新增 monorepo migration hint |

## Acceptance Criteria

- [ ] `task.py create --package cli` 正确写入 task.json
- [ ] `task.py init-context` 在 monorepo 模式下注入 `spec/<package>/backend/index.md`
- [ ] `task.py list` 显示 package 标签
- [ ] `trellis update` 不损坏 monorepo spec 目录
- [ ] 无 `--package` 时行为完全兼容现有单仓逻辑
