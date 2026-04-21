# Session 级 current-task 指针

## 背景

### 用户场景（2026-04-21，自己踩到）

同一仓库下开了两个 AI 对话窗口：
- **窗口 A**：正在跑 task X（比如实现中，hook 在持续注入"当前 task = X"的上下文）
- **窗口 B**：新开窗口想讨论 / 实施 task Y

两种选择都不干净：
1. **窗口 B 不切 task 指针，硬做** —— task.py 相关命令认的还是 X，创建 PRD、research 产物会写错目录
2. **窗口 B 切到 task Y** —— 写了 `.trellis/.current-task`，窗口 A 下一次 hook 注入就变成 Y，它的上下文被污染

### 根因

`.trellis/.current-task` 是**文件级全局状态**。所有窗口共享：

- `get_current_task(repo_root)` (`.trellis/scripts/common/paths.py`) 读这一个文件
- `task.py start` 写这一个文件
- `inject-workflow-state.py` / `session-start.py` hook 每次注入时都读这个文件

**"当前 task"** 的语义本应是"这个 AI 对话窗口正在做的 task"，但实际实现成了"整个项目的全局指针"。窗口数 ≥ 2 就必然冲突。

### 和相关问题的区别

| 问题 | 本质 | 解决方案 |
|---|---|---|
| Multi-session（worktree） | 物理目录隔离，多 task 并行开发 | 已实现，`multi_agent/start.py` |
| Polyrepo 检测 | init 时识别 N 个 sibling `.git` | `04-21-polyrepo-detection` |
| **本 task** | **同一目录多窗口的 current-task 污染** | **本 PRD** |

worktree 不能解决：用户就是想在同一个 repo 里开两个轻量窗口，而不是为每个讨论都 `git worktree add`。

---

## 任务目标

把 "current-task" 从 **文件级全局状态** 降级为 **session/窗口级本地状态**，并提供文件级兜底，保证：

- 多窗口并发做不同 task，彼此 hook 注入、task 操作互不干扰
- 单窗口用户体验零变化（不用记新命令）
- 现有所有依赖 `get_current_task()` 的代码继续工作

---

## 设计

### 核心规则

```python
def get_current_task(repo_root):
    # 优先 env var（窗口本地）
    if env := os.environ.get("TRELLIS_CURRENT_TASK"):
        return env
    # 兜底文件（全局默认）
    return read_file(".trellis/.current-task")
```

一行改动，彻底解决。窗口 A/B 各自 export 自己的 env，互不影响。

### `task.py start` 行为改造

#### 当前行为
```
task.py start <task>
→ 写 .trellis/.current-task
→ 所有窗口下次 hook 注入都看到新 task
```

#### 改造后

**默认 = session 模式：**
```bash
$ task.py start <task>
→ 不写全局文件
→ stdout 打印:
    export TRELLIS_CURRENT_TASK=/abs/path/to/task-dir
→ 人类手动 eval 或 source
```

**等价简写（推荐用户常用）：**
```bash
$ eval "$(task.py start <task>)"
# 或 shell 函数 wrapper:
$ trellis-use <task>   # 内部 eval task.py start
```

**显式全局：**
```bash
$ task.py start <task> --global
→ 写 .trellis/.current-task（旧行为）
→ 给"我就一个窗口"的简单场景用
```

**一键启动 AI：**
```bash
$ trellis-start <task> claude
# 内部: TRELLIS_CURRENT_TASK=<task> exec claude
```

### Hook 读取逻辑

所有 hook（`inject-workflow-state.py` / `session-start.py` / AI 平台特定 plugin）的入口点都走统一的 `get_current_task()`，已经是单一来源，改一处就全改。

### IDE 插件路径（硬伤）

Cursor / Claude Code 的 IDE 集成未必经过 shell，env var 可能拿不到。对策：

1. **短期**：兜底文件仍是真源，没指定 env 时回退。IDE 用户如果开多窗口，自己承担污染风险（和今天一样）
2. **中期**：在 `.trellis/config.yaml` 里提供 `default_task` 覆盖全局文件的行为
3. **长期**：各 IDE 插件支持从 workspace state 注入 env（插件层面的功能请求，另开任务）

---

## 子任务

### 1. 核心逻辑改造

- [ ] `paths.py::get_current_task()` 加 env 优先逻辑
- [ ] 新增 `get_current_task_source()`：返回 `("env", path)` / `("file", path)` / `(None, None)`
- [ ] 单元测试：env 命中、env 为空文件兜底、env 指向不存在的 task（报错还是 fallback）

### 2. `task.py start` 改造

- [ ] `--global` flag：写全局文件（旧行为）
- [ ] 默认：只 stdout 打印 export 语句 + 人类可读提示
- [ ] 检测是否 stdout 是 tty：是 tty 时追加"提示 eval"文案到 stderr
- [ ] 其他 task.py 命令（complete / list / use）的兼容性审查

### 3. Wrapper 脚本

- [ ] `trellis-start <task> <ai-cli>` 脚本，封装 `eval` + `exec`
- [ ] README / docs 示例里推荐这个用法

### 4. Hook 注入验证

- [ ] `inject-workflow-state.py` 确认读的是 `get_current_task()` 而非重新读文件
- [ ] Record 模式 (`session_context.py::get_context_text_record`) 同理
- [ ] 注入上下文里标注 source（"[session]" vs "[global]"），让 AI 能看出来自己在哪个 scope

### 5. 向后兼容

- [ ] 现有 `.trellis/.current-task` 文件继续工作
- [ ] 所有 task.py 子命令保留旧行为（加 `--global` 仅影响 start）
- [ ] Migration: 无需（纯增量）

### 6. 文档

- [ ] `spec/cli/backend/*` 加一节 "Current Task Resolution"
- [ ] README 多窗口使用示例
- [ ] Changelog 里说明

### 7. 测试矩阵

| 场景 | 期望 |
|---|---|
| 单窗口，`task.py start foo`（无 `--global`）后不 eval | .current-task 不变，env 未设 → hook 看到旧全局值（或空） |
| 单窗口，`eval $(task.py start foo)` | env 设了 foo，hook 看到 foo |
| 单窗口，`task.py start foo --global` | 写文件，env 未设，hook 看到 foo |
| 双窗口，各自 eval 不同 task | 各看各的 |
| 双窗口，其中一个 --global 一个没设 env | 另一个看到 global 值 |
| env 指向不存在的 task | 报错提示，不静默 fallback |

---

## 非目标

- **不改**已有的 worktree / multi-session 机制
- **不动** `.trellis/.current-task` 的文件格式
- **不强制**所有用户迁移到 env 模式，兜底文件仍可用
- **不解决** IDE 插件不经 shell 的启动问题（需插件层改造，另开）

---

## 优先级

🔴 **P1** —— 已经有内部用户（自己）在踩。多窗口并发是 AI 辅助开发的日常模式，不是边缘场景。

建议纳入 **v0.5.0 rc / stable 之前**。

## 风险

- **script 输出变化**：`task.py start` 不再默默写文件、改成 stdout 输出，自动化脚本可能依赖旧行为。Mitigation：`--global` 明示旧行为可走
- **env 拼错 / 污染其他 Trellis 项目**：`TRELLIS_CURRENT_TASK` 是全局 env 名，用户可能在 shell rc 里 export 死，跨项目串线。Mitigation：值用**绝对路径**，跨项目不匹配时 fallback + warn
- **文档不到位导致用户疑惑**：单/多窗口推荐路径要讲清楚，不然用户只会按老习惯用 `task.py start`，继续踩坑
- **Hook 读取延迟**：env 是在 shell 启动 AI 时 export 的快照，之后 shell 里改不了当前窗口的 env。只能重启 AI 才换 task——接受这个约束，和"当前 session 绑定一个 task"的心智一致

## 关联

- `04-21-polyrepo-detection` —— 独立问题，同批用户可能同时需要
- `04-17-hook-path-robustness` —— 独立，但都属于"hook 行为鲁棒性"一批
- `04-16-skill-first-refactor` —— 不直接关联
