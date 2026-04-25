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

### 2026-04-25 设计修正：一个 resolver，不做多套流程

原始方案把核心规则写成 `TRELLIS_CURRENT_TASK` env var 优先。这能解决**启动 AI 前绑定 task**，但不能完整解决当前问题，也会引入多套用户心智。

根因：AI 会话里运行的 `task.py start <task>` 是子进程。子进程无法修改父进程 / AI runtime 的环境变量，所以它不能靠打印 `export TRELLIS_CURRENT_TASK=...` 来改变当前会话后续 hook 看到的 task。这个限制会直接影响两个场景：

- 用户在已经打开的 AI 窗口里切换 task。
- Autopilot 完成一个 task 后自动推进到下一个 task。

因此本任务不应该把用户暴露给 `eval` / env var / global file 多套流程。应该只有一个概念：

```text
active task = 当前 AI 会话 / 窗口正在处理的 Trellis task
```

所有入口都通过同一个 resolver 读写 active task。resolver 内部可以有 session scope + global fallback，但这只是实现细节，不是用户要学习的两套流程。

### Core Rule

```python
def resolve_active_task(repo_root, platform_input=None):
    context_key = resolve_context_key(platform_input)

    if context_key:
        task = read_runtime_context(context_key).current_task
        if task:
            return ActiveTask(task, source=f"session:{context_key}")

    task = read_file(".trellis/.current-task")
    if task:
        return ActiveTask(task, source="global")

    return ActiveTask(None, source="none")
```

写入也走同一个 resolver：

```python
def set_active_task(task, repo_root, platform_input=None):
    context_key = resolve_context_key(platform_input)
    if context_key:
        write_runtime_context(context_key, current_task=task)
    else:
        write_file(".trellis/.current-task", task)
```

用户仍然只需要一个动作：

```bash
python3 ./.trellis/scripts/task.py start <task>
```

它在能识别当前会话时写 session-local 状态；识别不到时保留旧的 global fallback。`--global` 可以作为调试/兼容逃生阀，但不是主流程。

### Runtime State Shape

建议新增一个 gitignored runtime state 区域：

```text
.trellis/.runtime/
  contexts/
    <context-key>.json
```

`<context-key>.json`:

```json
{
  "current_task": ".trellis/tasks/04-21-session-scoped-task-state",
  "current_run": null,
  "platform": "claude",
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../abc123.jsonl",
  "last_seen_at": "2026-04-25T12:00:00Z"
}
```

`current_run` is included now so Autopilot can reuse the same active context later. It should not introduce a second pointer system.

### Context Key Resolution

One helper owns context-key derivation:

```text
resolve_context_key(platform_input) -> str | None
```

Inputs:

- Claude Code hooks: use `session_id` first, then `transcript_path`.
- Claude Code statusline: read the same session JSON from stdin and use the same helper.
- Codex / Cursor / Gemini / Droid / Qoder / CodeBuddy hooks: use `session_id` first, then `transcript_path`.
- Cursor IDE only: use `session_id`; when needed, use `conversation_id` as the fallback. `transcript_path` may be null in Cursor and should not be required.
- OpenCode plugin: use `input.sessionID` / event `properties.sessionID` from plugin input.
- Kiro hooks: use `session_id` when the hook payload provides it.
- Copilot hooks: use `session_id` / `sessionId` only if present in the actual payload; otherwise return `None`.
- Pi extension: use a session file / session id only if exposed by the extension context; current template should fallback until verified.
- Other platforms: use whatever stable session id the hook payload provides; if none exists, return `None`.
- CLI commands: if no platform input exists, optionally read `TRELLIS_CONTEXT_ID`; otherwise return `None`.

Important: `TRELLIS_CONTEXT_ID` is a context-key override, not a separate `current-task` mechanism.

`transcript_path` means the absolute path to the platform's conversation transcript / session log file. It is useful only as a fallback stable identifier when `session_id` is missing or unstable. It is not the task source of truth and should not be required for Cursor IDE.

Resolver key adapters should accept all observed spellings:

```text
session_id
sessionId
sessionID
conversation_id
transcript_path
```

### `task.py start` Behavior

The user-facing command stays simple:

```bash
python3 ./.trellis/scripts/task.py start <task>
```

Expected behavior:

- In a scoped AI session: write `current_task` into `.trellis/.runtime/contexts/<context-key>.json`.
- Outside a scoped AI session: write `.trellis/.current-task` as before.
- In all cases: print the resolved source so status is debuggable.

Reviewer clarification (2026-04-25): a bare shell command has no hook stdin and
cannot infer the current AI window by itself. `task.py start <task>` can write
session-local state only when the process already has a context key, either via
`TRELLIS_CONTEXT_ID` or via a platform-native session environment variable
exported by the host (for example `CODEX_SESSION_ID`). Hooks can pass
`TRELLIS_CONTEXT_ID` to subprocesses they launch, but cannot mutate the parent
AI runtime environment after startup. If no such signal exists, the correct
behavior is the compatible global fallback with `Source: global`.

Example:

```text
Current task: .trellis/tasks/04-21-session-scoped-task-state
Source: session:claude:abc123
Fallback: .trellis/.current-task
```

### Hook / Statusline Consumers

Every consumer must call the same resolver:

- `get_context.py`
- `task.py list` current marker
- `task.py finish`
- `add_session.py`
- `session-start.py`
- `inject-workflow-state.py`
- `inject-subagent-context.py`
- OpenCode `TrellisContext`
- **Claude Code `statusline.py`**

No hook or statusline script should directly read `.trellis/.current-task` after this refactor. Direct reads are the bug source.

### Claude Code Statusline

Statusline is not just display. It is a high-frequency consumer of active task state and receives Claude Code session JSON from stdin. Therefore:

- It must derive the same context key as Claude Code hooks.
- It must render session-scoped task when available.
- It should show the task source compactly when useful, e.g. `session` vs `global`, so context leaks are visible.
- It must not independently parse `.trellis/.current-task`.

### Verification: Platform Session Identity

Verified on 2026-04-25. Full notes live in:

- `.trellis/tasks/04-21-session-scoped-task-state/research/session-identity-platform-survey.md`

Summary:

| Tier | Platforms | Reason |
|---|---|---|
| Tier 1 MVP | Claude Code, Codex, Cursor, OpenCode, Gemini, Droid, Qoder, CodeBuddy | Docs or local logs expose stable session identity or plugin session ID; current Trellis code ignores it |
| Tier 2 | Kiro, Pi, Copilot with verified `sessionId` payload | Session identity appears possible, but Trellis integration path differs or needs installed-CLI verification |
| Tier 3 fallback | Kilo, Antigravity, Windsurf, unknown payloads | No reliable hook/session payload verified in this pass |

Local tests confirmed the current bug:

- Claude `statusline.py` rendered the same global task for two different mock `session_id`s.
- Shared `inject-workflow-state.py` rendered the same global task for two different mock `session_id`s.
- Codex `session-start.py` rendered the same global task for two different mock `session_id`s.
- OpenCode `session-start.js` received two different `sessionID`s but still injected the same global task because `TrellisContext.getCurrentTask()` reads `.trellis/.current-task`.
- Cursor local hook logs show real `sessionStart` payloads for this repo include `session_id` and `conversation_id`; project `.cursor/hooks.json` wires `sessionStart`, `beforeSubmitPrompt`, and `preToolUse`.

Conclusion: session-scoped current-task is feasible across the main hook-capable platforms, but only if all consumers route through one resolver. Claude-only implementation would leave the same pollution bug in Codex, Cursor, OpenCode, Gemini, Droid, Qoder, and CodeBuddy.

---

## 子任务

### 1. 核心逻辑改造

- [ ] 新增统一 active task resolver（Python）：解析 context key → session-local state → global fallback
- [ ] `paths.py::get_current_task()` / `get_current_task_abs()` 改为调用 resolver，保留旧 API
- [ ] 新增 `get_current_task_source()`：返回 `("session", key, path)` / `("global", None, path)` / `("none", None, None)`
- [ ] 单元测试：session 命中、session 空值 fallback、global fallback、stale session task、stale global task
- [ ] `.trellis/.gitignore` 和模板 gitignore 增加 `.runtime/`

### 2. `task.py start` 改造

- [ ] `task.py start <task>` 调用统一 resolver 写入当前 active context
- [ ] 无 context key 时保持旧行为：写 `.trellis/.current-task`
- [ ] `--global` flag：显式写全局文件（调试 / 兼容逃生阀）
- [ ] `task.py current --source`：显示当前 task 和 source
- [ ] 其他 task.py 命令（complete / list / use）的兼容性审查

### 3. Hook / Statusline 接入

- [ ] `inject-workflow-state.py` 改用统一 resolver，不直接读 `.current-task`
- [ ] `session-start.py`（shared + codex/copilot copies）改用统一 resolver
- [ ] `inject-subagent-context.py` 改用统一 resolver
- [ ] OpenCode `TrellisContext.getCurrentTask()` 改用同一逻辑
- [ ] Claude Code `statusline.py` 改用统一 resolver，并用 stdin session JSON 解析 context key
- [ ] Hook / statusline 输出中标注 source（session/global），便于发现串线

### 4. Context Key Transport

- [ ] Claude Code：从 hook stdin `session_id` / `transcript_path` 派生 context key
- [ ] Claude Code statusline：从 statusline stdin 派生同一个 context key
- [ ] Codex / Cursor / Gemini / Droid / Qoder / CodeBuddy：从 hook stdin `session_id` / `transcript_path` 派生 context key
- [ ] Cursor IDE：`transcript_path` 可能为 null，使用 `session_id`，必要时 fallback 到 `conversation_id`
- [ ] OpenCode：从 plugin input 的 `sessionID` 派生 context key（缺字段时 fallback）
- [ ] Kiro / Pi / Copilot：仅在实际 payload 暴露稳定 session key 时启用 session-local，否则 fallback
- [ ] CLI scripts：支持 `TRELLIS_CONTEXT_ID` 作为 context-key override，不作为 current-task 选择机制

### 5. 向后兼容

- [ ] 现有 `.trellis/.current-task` 文件继续工作
- [ ] 没有 context key 的平台继续走 global fallback
- [ ] 所有 task.py 子命令保留旧行为
- [ ] Migration: 无需（纯增量）

### 6. 文档

- [ ] `spec/cli/backend/*` 加一节 "Current Task Resolution"
- [ ] README 多窗口使用示例
- [ ] Changelog 里说明

### 7. 测试矩阵

| 场景 | 期望 |
|---|---|
| Claude 窗口 A/B，有不同 `session_id`，各自 `task.py start` 不同 task | 各自 hook/statusline/get_context 看到各自 task |
| Claude statusline stdin 有 `session_id` | statusline 显示 session-local task |
| Claude statusline 无 session 字段但有 global task | statusline fallback 显示 global task |
| Codex / Cursor / Gemini / Droid / Qoder / CodeBuddy hook stdin 有 `session_id` | 共享 hook 显示 session-local task |
| Cursor hook stdin 有 `conversation_id` 但 `transcript_path` 为 null | resolver 用 `session_id` 或 `conversation_id`，不退回 global |
| OpenCode `chat.message` input 有 `sessionID` | OpenCode 插件显示 session-local task |
| `inject-workflow-state.py` 收到 `session_id` | 注入 session-local workflow state |
| `inject-subagent-context.py` 收到 `session_id` | implement/check 读取 session-local task jsonl |
| CLI shell 直接 `task.py start foo`（无 context） | 写 `.trellis/.current-task`，旧行为可用 |
| `task.py start foo --global` | 明确写 `.trellis/.current-task` |
| session-local task 被删除 | resolver 报 stale session task，不静默 fallback 到 global |
| session-local 无 task，global 有 task | fallback 到 global，并标注 source=global |

---

## 非目标

- **不改**已有的 worktree / multi-session 机制
- **不动** `.trellis/.current-task` 的文件格式
- **不引入**面向用户的 `eval $(task.py start ...)` 流程
- **不要求**所有平台第一版都能提供 session key；无法提供的继续 global fallback

---

## 优先级

🔴 **P1** —— 已经有内部用户（自己）在踩。多窗口并发是 AI 辅助开发的日常模式，不是边缘场景。

建议纳入 **v0.5.0 rc / stable 之前**。

## 风险

- **平台 session key 缺失**：部分平台 hook/statusline payload 可能没有稳定 session id。Mitigation：resolver 返回 global fallback，并在 source 标注 `global`。
- **hook/statusline 重复实现漂移**：当前多个脚本自己读 `.current-task`。Mitigation：抽一个共享 resolver 模块，hook/statusline 只做 platform input adapter。
- **stale session state**：`.trellis/.runtime/contexts/*.json` 可能长期残留。Mitigation：记录 `last_seen_at`，后续加 prune；MVP 不影响正确性。
- **source 显示噪音**：statusline 如果总显示 `session:xxx` 会太长。Mitigation：只显示短标签 `session` / `global`，详细 key 走 `task.py current --source`。

## 关联

- `04-21-polyrepo-detection` —— 独立问题，同批用户可能同时需要
- `04-17-hook-path-robustness` —— 独立，但都属于"hook 行为鲁棒性"一批
- `04-16-skill-first-refactor` —— 不直接关联
