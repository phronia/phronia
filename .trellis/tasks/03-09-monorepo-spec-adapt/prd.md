# Monorepo Spec 目录适配 — 按 package 组织 spec

## Goal

将 `.trellis/spec/` 目录结构从扁平的 `backend/`、`frontend/` 改为按 monorepo package 组织，使 spec 内的路径引用语义清晰。

## Background

monorepo 重构后（父任务 03-09-monorepo-submodule），`src/` 移到了 `packages/cli/src/`。当前 `.trellis/spec/backend/` 里的路径引用（如 `src/migrations/index.ts`）变得模糊——哪个 package 的 `src/`？

## Proposed Structure

```
.trellis/spec/
├── cli/                         # 对应 packages/cli/
│   ├── backend/
│   │   ├── index.md
│   │   ├── directory-structure.md
│   │   ├── migrations.md
│   │   ├── platform-integration.md
│   │   ├── error-handling.md
│   │   ├── quality-guidelines.md
│   │   ├── logging-guidelines.md
│   │   ├── script-conventions.md
│   │   └── database-guidelines.md
│   ├── unit-test/
│   │   ├── index.md
│   │   ├── conventions.md
│   │   ├── integration-patterns.md
│   │   └── mock-strategies.md
│   └── frontend/                # CLI 项目可为空或 N/A
│       └── index.md
├── guides/                      # 跨 package 共享
│   ├── index.md
│   ├── cross-layer-thinking-guide.md
│   └── cross-platform-thinking-guide.md
```

## Scope of Changes

### 1. 目录移动
- `git mv .trellis/spec/backend/ .trellis/spec/cli/backend/`
- `git mv .trellis/spec/frontend/ .trellis/spec/cli/frontend/`
- `git mv .trellis/spec/unit-test/ .trellis/spec/cli/unit-test/`
- `.trellis/spec/guides/` 保持不动

### 2. Spec 内容更新
- `directory-structure.md` — 更新目录树，`src/` 指 `packages/cli/src/`
- `migrations.md` — 路径加 `packages/cli/` 前缀
- 其他 spec 文件中的具体文件引用

### 3. Commands/Skills 引用更新（4 份副本）
- `.claude/commands/trellis/` — 所有引用 `.trellis/spec/backend/` 的改成 `.trellis/spec/cli/backend/`
- `.cursor/commands/`
- `.agents/skills/`
- `.opencode/commands/trellis/`
- 同时更新 `create-manifest.md`、`break-loop.md`、`finish-work.md` 里的 `src/`、`scripts/` 路径

### 4. Trellis 脚本适配
- `task.py init-context` — 默认 context 路径从 `spec/backend/` 改为 `spec/cli/backend/`
- `workflow.md` — spec 阅读指引更新
- hook 注入系统（如有 spec 路径硬编码）

### 5. 模板源文件（packages/cli/src/templates/）
- **不改** — 模板面向用户项目，用户项目的 spec 结构仍是 `backend/`、`frontend/`
- 后续 Trellis 产品支持 monorepo 时再考虑模板变更

## Acceptance Criteria

- [ ] `.trellis/spec/cli/backend/` 存在且内容正确
- [ ] `.trellis/spec/cli/unit-test/` 存在且内容正确
- [ ] `.trellis/spec/guides/` 保持不动
- [ ] 所有 commands/skills 引用更新
- [ ] `init-context` 脚本适配新路径
- [ ] `workflow.md` 更新
- [ ] spec 内的文件路径引用正确（`packages/cli/src/...`）

## Out of Scope

- Trellis 产品级 monorepo 支持（`trellis init` 感知 workspace）
- 模板源文件变更
- docs-site 内容更新（单独在 docs 仓库处理）
