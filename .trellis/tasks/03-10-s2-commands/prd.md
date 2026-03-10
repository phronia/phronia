# S2: 命令合并 + Hook/Start 动态化

> Parent: `03-10-v040-beta1` | Depends on: S1

## Goal

将 type-specific 命令合并为 generic 命令，所有命令和 Hook 改为动态发现 spec 路径，使 monorepo 下命令正常工作且新增 package 无需改命令文件。

## Scope

### 2.1 合并 type-specific 命令为 generic（9 平台）

**现状**: 每个平台有 `before-backend-dev` / `before-frontend-dev` / `check-backend` / `check-frontend` 等 type-specific 命令，共 ~40 文件。

**合并为**:
| 新命令 | 替代 | 逻辑 |
|--------|------|------|
| `before-dev` | `before-backend-dev` + `before-frontend-dev` | 运行时自动发现 `spec/*/index.md` 或 `spec/<pkg>/*/index.md`，按任务类型加载 |
| `check` | `check-backend` + `check-frontend` | 根据 `git diff` 检测改了哪个 package，加载对应 spec |

**迁移策略**: 新增 generic 命令，旧命令标记 deprecated 保留一个版本周期。

### 2.2 start.md 模板动态化（9 平台）

从硬编码 `cat .trellis/spec/frontend/index.md` 改为：
```bash
python3 ./.trellis/scripts/get_context.py --mode packages
# 然后读取对应 package 的 spec index
```

### 2.3 session-start.py 模板动态化

**现状**: 硬编码读取 `spec/frontend/index.md`、`spec/backend/index.md`。

**改为**:
- 调用 `config.is_monorepo()` 判断模式
- 单仓: `glob("spec/*/index.md")`
- Monorepo: `glob("spec/*/index.md")` + `glob("spec/*/*/index.md")`
- 有 `.current-task` 且 task.json 有 `package` 字段时，只注入对应 package

### 2.4 inject-subagent-context.py 模板动态化

**现状**: 硬编码 spec 目录树。

**改为**: 运行时读取实际 spec 结构 + 按 task.json package 过滤注入范围。

- check/debug fallback 从 `[check-backend, check-frontend]` 改为 `[check]`
- research context 从静态目录描述改为动态生成

### 2.5 parallel.md / agent 定义文件（3 平台）

清理 `parallel.md`、`agents/implement.md`、`agents/check.md`、`agents/research.md` 中的硬编码 `spec/frontend/` `spec/backend/` 路径。

---

## 受影响文件

### 新增
- `before-dev.md` / `before-dev` SKILL（9 平台各 1 个）
- `check.md` / `check` SKILL（9 平台各 1 个）

### 修改
- `start.md` / `start` SKILL（9 平台）
- `session-start.py` / `session-start.js`（claude, iflow, opencode）
- `inject-subagent-context.py` / `.js`（claude, iflow, opencode）
- `parallel.md`（claude, iflow, opencode）
- `agents/*.md`（claude, opencode）
- `workflow.md` 模板

### Deprecated（保留不删）
- `before-backend-dev` / `before-frontend-dev`（9 平台）
- `check-backend` / `check-frontend`（9 平台）

## Acceptance Criteria

- [ ] Generic `before-dev` 命令在单仓和 monorepo 下都正确发现 spec
- [ ] Generic `check` 命令根据变更文件自动定位 package
- [ ] `session-start.py` 动态注入 spec，不再硬编码
- [ ] `inject-subagent-context` 按 task package 过滤
- [ ] 旧 type-specific 命令仍可用（deprecated 但不删）
- [ ] 无 packages 配置的单仓项目一切行为不变
