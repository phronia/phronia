# Monorepo Workflow 全面适配

## Goal

将 Trellis 的整个 workflow 体系（spec、commands/skills、hooks、tasks、sessions、parallel）适配 monorepo 结构，同时保持对单仓库项目的向前兼容。

## Background

monorepo 重构后（父任务 03-09-monorepo-submodule），`src/` 移到了 `packages/cli/src/`。Trellis workflow 体系中大量路径引用、context 注入、session 记录都假定单仓库结构，需要全面适配。

用户反馈的完整范围：
> "不只是spec，这个是很多东西的情况，比如说从slash command的引导，默认hook的注入，ai知道monorepo的基础情况，以及后续的task 实施，parallel worktree的支持，record-session的时候能标记记录的是哪个repo，以及对单仓库的向前兼容，这些都需要考虑"

---

## Phase 1: 路径替换（已完成 ✅）

### Part A: Spec 目录重组 ✅

将 `.trellis/spec/` 从扁平的 `backend/`、`frontend/` 改为按 package 组织：

```
.trellis/spec/
├── cli/                         # 对应 packages/cli/
│   ├── backend/
│   ├── unit-test/
│   └── frontend/
├── guides/                      # 跨 package 共享（不动）
```

### Part B: Commands/Skills 路径更新 ✅

所有 4 平台 commands + agents + skills 中的 spec 路径已更新（~55 文件）：
- `.claude/` (18 文件)、`.cursor/` (10 文件)、`.agents/` (12 文件)、`.opencode/` (14 文件)
- `.trellis/workflow.md`、`scripts/task.py`、`scripts/create_bootstrap.py`

### Part D-partial: init-context 路径 ✅

`task.py` 中 `get_implement_backend()` 和 `get_implement_frontend()` 已更新为 `spec/cli/backend/`、`spec/cli/frontend/`。

---

## Phase 2: 泛化 + 动态感知

### Part 1: 合并 Type-Specific 命令（P1）

**问题**：每个 spec 类型一个命令，N 个 package × M 个类型 = N×M 个命令，不 scale。

**现在**（每增加一个 package 就要新建命令）：
| 命令 | 数量 | 平台副本 |
|------|------|----------|
| `before-backend-dev` | 1 | ×4 |
| `before-frontend-dev` | 1 | ×4 |
| `before-docs-dev` (docs-site) | 1 | ×4 |
| `check-backend` | 1 | ×4 |
| `check-frontend` | 1 | ×4 |
| `check-docs` (docs-site) | 1 | ×4 |
| `improve-ut` (隐含绑定单测试套件) | 1 | ×4 |
| **合计** | 7 | 28 文件 |

**合并为**（package 数量无关）：
| 命令 | 逻辑 | 平台副本 |
|------|------|----------|
| `before-dev` | 自动发现 `spec/*/index.md`，按任务选择对应 spec 读取 | ×4 |
| `check` | 根据 git diff 检测改了哪个 package，加载对应 spec | ×4 |
| `improve-ut` | 泛化：检测 `spec/*/unit-test/` | ×4 |
| **合计** | 3 | 12 文件 |

**Spec 自动发现规则**：
```
.trellis/spec/
├── cli/backend/index.md      → 自动发现 "cli/backend"
├── cli/unit-test/index.md    → 自动发现 "cli/unit-test"
├── docs-site/index.md        → 自动发现 "docs-site"
└── guides/index.md           → 跨 package 共享，始终加载
```

新增 package 只需建 `spec/<package>/` 目录，命令零改动。

### Part 2: Task 系统 package 字段（P2）

**task.json 新增 `package` 字段**：
```json
{
  "id": "add-auth",
  "package": "cli",
  "dev_type": "backend",
  ...
}
```

**影响的脚本**：
- `task.py create --package <name>` — 创建时指定 package
- `task.py init-context` — 用 package 解析 spec 路径：`spec/<package>/<layer>/`
- `task.py list` — 显示 package 列
- 无 `--package` 时 fallback 到旧路径（兼容单仓库）

### Part 3: get_context.py Monorepo 检测（P3）

**自动检测**：
- 存在 `pnpm-workspace.yaml` → 解析 packages 列表
- 存在 `.gitmodules` → 展示 submodule 信息
- 输出时展示 monorepo 结构
- 单仓库时这部分不输出（向前兼容）

### Part 4: start.md + workflow.md 动态发现（P4）

**start.md 改为指令式**（不硬编码路径）：
```
1. 列出 spec 模块: ls -d .trellis/spec/*/
2. 读取你要工作的 package 对应的 index.md
3. 始终读取 .trellis/spec/guides/index.md（跨 package 共享）
```

**workflow.md 更新**：
- 说明 spec 目录约定：`spec/<package>/<layer>/`
- `guides/` 是跨 package 共享的特殊目录

### Part 5: docs-site 迁移（P5）

**迁移到根目录的独有内容**：
| 来源 | 目标 |
|------|------|
| `docs-site/.claude/commands/trellis/before-docs-dev.md` | `.claude/commands/trellis/before-docs-dev.md`（Phase 2 Part 1 后会被合并进 `before-dev.md`）|
| `docs-site/.claude/commands/trellis/check-docs.md` | 同上 → 合并进 `check.md` |
| `docs-site/.claude/commands/trellis/commit.md` | `.claude/commands/trellis/commit.md` |
| `docs-site/.claude/skills/contribute/SKILL.md` | `.claude/skills/contribute/SKILL.md` |
| `docs-site/.trellis/spec/docs/` (7 文件) | `.trellis/spec/docs-site/` |

**从 submodule 删除的冗余配置**：
- `docs-site/.claude/` 整个目录
- `docs-site/.cursor/` 整个目录
- `docs-site/.trellis/scripts/`、`workflow.md`、`.template-hashes.json`、`.version`、`.gitignore`、`worktree.yaml`、`spec/guides/`

**保留**：`docs-site/.trellis/tasks/`（历史记录）、`docs-site/.trellis/workspace/`（journal）

**需要两次 commit**：submodule 内部 + 父仓库

### Part 6: Session 记录 package 标记（P6）

`add_session.py --package cli` → journal 里标注涉及的 package，方便按 package 过滤历史。

### Part 7: 向前兼容（P7）

**检测逻辑**：
- `spec/` 下有 package 子目录（如 `spec/cli/`）→ monorepo 模式
- `spec/` 下直接是 `backend/`、`frontend/` → 单仓库模式（legacy）
- 所有脚本和命令都需支持两种模式

**兼容规则**：
- `init-context` 无 `--package` → 用 `spec/backend/` 直接路径（legacy）
- 泛型命令的发现逻辑同时覆盖两种目录结构
- 模板源文件（`packages/cli/src/templates/`）**不改**——面向用户单仓库项目

---

## 已知风险

1. **`trellis update` 覆盖定制**：在 Trellis 仓库自身跑 `trellis update` 可能从模板覆盖已定制的 dotfiles（`spec/cli/` 路径）。需确保冲突检测机制正常工作。
2. **Cross-platform 4 份副本维护成本**：合并命令后从 ~60 文件降到 ~40 文件，但本质问题未解决。长期可考虑从模板源生成 dotfiles（独立问题）。

---

## 泛用性分析：项目特化 vs 产品复用

后续 Trellis CLI 产品支持 monorepo（如 `trellis init --monorepo`）时，下面标注 **可泛用** 的改动可以直接复用到模板源（`packages/cli/src/templates/`）。

### 项目特化（仅 Trellis 仓库自身）

| 改动 | 原因 |
|------|------|
| **Phase 1 Part A**: `spec/backend/` → `spec/cli/backend/` 目录移动 | Trellis 仓库手动重组自己的 spec 目录 |
| **Phase 1 Part B**: ~55 文件路径替换 | 仅影响 Trellis 仓库的 dotfiles，模板源不改 |
| **Phase 1 Part D-partial**: `init-context` 硬编码 `spec/cli/` | 过渡方案，后续被 Part 2 的 `--package` 参数取代 |
| **Phase 2 Part 5**: docs-site submodule 迁移 | Trellis 仓库特有的 submodule 清理 |

### 可泛用（后续改 CLI 模板时复用）

| 改动 | 复用方式 | 模板影响 |
|------|----------|----------|
| **Part 1**: 合并 type-specific 命令 → 泛型 `before-dev`/`check` | 设计直接用：spec 自动发现（`ls spec/*/index.md`）不假定目录名，单仓库和 monorepo 都能工作 | 更新模板中的 command/skill 文件，删除 `before-backend-dev`/`before-frontend-dev`/`check-backend`/`check-frontend`，新增 `before-dev`/`check` |
| **Part 2**: task.json `package` 字段 + `--package` 参数 | 脚本逻辑改动，直接体现在模板 `task.py` 中。单仓库时 package 为空，行为不变 | 更新模板 `scripts/task.py` |
| **Part 3**: `get_context.py` monorepo 检测 | 检测 `pnpm-workspace.yaml`/`lerna.json` 等，有就输出 monorepo 信息，没有就跳过 | 更新模板 `scripts/get_context.py` |
| **Part 4**: `start.md`/`workflow.md` 动态发现 | 指令式引导（"列出 spec 模块"）不硬编码路径，天然兼容两种结构 | 更新模板中的 `start.md` 和 `workflow.md` |
| **Part 6**: `add_session.py --package` 标记 | 可选参数，不传时行为不变 | 更新模板 `scripts/add_session.py` |
| **Part 7**: 向前兼容检测逻辑 | `spec/` 下有 package 子目录 → monorepo 模式；直接有 `backend/` → 单仓库模式。写在脚本里 | 贯穿所有模板脚本 |

### 产品化路径

当 Trellis CLI 要正式支持 monorepo 时，工作量大致为：
1. 把上述 **可泛用** 改动同步到 `packages/cli/src/templates/` 中的对应文件
2. `trellis init` 新增 `--monorepo` 或自动检测 workspace 配置
3. `trellis update` 处理 monorepo spec 目录结构（不覆盖 `spec/<package>/`）
4. 文档更新（docs-site 新增 monorepo 章节）

---

## Out of Scope

- Trellis 产品级 monorepo 支持（`trellis init --monorepo`）— 独立 feature
- 模板源文件变更（`packages/cli/src/templates/`）
- Cross-platform 命令去重（从模板生成 dotfiles）— 独立优化
