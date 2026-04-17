# Workflow Enforcement v2

## 一句话

把 Trellis 工作流状态从「session 启动一次注入 + 靠 AI 记住」改造为「每轮由 hook 强制注入 + 显式状态机」，解决 3 个观察到的工作流漂移问题。

## 背景：3 个触发问题（用户 2026-04-17 提出）

1. **用户开场后直接说需求，没机会用 `/continue`** → AI 在长对话里忘了 workflow → 回到"一次注入就完"的老问题
2. **`/continue` 缺"当前在哪、下一步干啥、什么时候再 /continue"的显式导引**（对比 `/audit` skill 给的后续命令指引）
3. **回流没引导**：AI 走到 check/update-spec 后用户说"回去改"，AI 改完就结束，不知道要再走 check → update-spec → 可能 break-loop

## 根因（见 fp-analysis.md 完整推理）

- 工作流状态**写在磁盘**但**一次 session 只注入一次给 AI**
- 依赖「AI 自觉调 /continue」= 违反公理「AI 不能自己调 slash command」
- 依赖「AI 自觉触发 skill」= 违反公理「AI 记忆易失 + skill 触发是概率的」
- Phase 转换没有强制 touch-point → 状态跟现实脱钩

## 范围

**动**：
- `.trellis/scripts/common/` 的 task.json 读写（加 phase 字段）
- `task.py` 新增 `set-phase` + `phase-history` 子命令
- `shared-hooks/` 新增 `inject-workflow-state.py`
- 9 个有 UserPromptSubmit 的平台 hook 配置接线（claude/cursor/codex/kiro/qoder/codebuddy/copilot/gemini/droid）
- OpenCode plugin（`chat.message` 等价）
- `common/skills/*.md` 全部加 `📍 Workflow State` 结尾块
- 新增 `/trellis:rollback` 命令模板
- spec 文档更新

**不动**：
- `workflow.md` 的 Phase 定义本身（1.x / 2.x / 3.x 结构不变）
- 3 个 agent-less 平台（kilo/antigravity/windsurf）的强制机制（接受弱保障）
- 已有的 hook（SessionStart、PreToolUse on Task）保留

## 前置前提（已具备）

- `04-17-subagent-hook-reliability-audit` 已确认 9 平台支持 UserPromptSubmit
- `04-17-pull-based-migration` 已 commit 让 class-2 平台 agent 从 pull 读文件——本任务的 phase 状态写 task.json 也是同样哲学
- Claude Code canary test 证明 hook 注入实际工作

---

## 执行清单

### Step 1 — `task.json` schema 扩展 [必做]

**动作**：扩展 `task.json` 增加 workflow state 字段。

```json
{
  "current_phase": "2.1",
  "phase_history": [
    {"phase": "1.1", "at": "2026-04-17T10:00:00Z", "action": "brainstorm"},
    {"phase": "2.1", "at": "2026-04-17T11:30:00Z", "action": "implement"}
  ],
  "last_action": "implement-completed",
  "checkpoints": {
    "prd_exists": true,
    "context_configured": true,
    "implement_completed": true,
    "check_passed": false
  }
}
```

需要：
- migration：现有 task.json 加默认值（`current_phase: null, phase_history: [], checkpoints: {}`）
- `phase_history` FIFO 限 20 条，防膨胀
- 确认迁移不破坏现有 task 的读取（向后兼容）

**完成标志**：migration 脚本可跑；现有 task 读写不 break；测试覆盖新字段。

### Step 2 — `task.py` 新命令 [必做]

```bash
python3 ./.trellis/scripts/task.py set-phase <X.Y> [--reason "..."]
python3 ./.trellis/scripts/task.py phase-history
python3 ./.trellis/scripts/task.py phase-current
```

`set-phase` 行为：
- 更新 `current_phase`
- append 到 `phase_history`（含时间戳、可选 reason）
- 如果 `X.Y < previous`（phase 号倒退）→ 标记 rollback + 设置 `checkpoints` 对应下游项为 `false`（强制重新验证）
- 如果 phase 不在合法集合（1.0-1.4 / 2.1-2.3 / 3.1-3.4）→ error

**完成标志**：单元测试覆盖正常转换、rollback、非法 phase。

### Step 3 — `inject-workflow-state.py` hook [必做]

**动作**：新 hook 脚本，响应 `UserPromptSubmit` 事件，输出 workflow 面包屑。

核心逻辑：
1. 读 `.trellis/.current-task` → 定位 task
2. 读 `task.json` 的 phase 字段
3. 判断是否需要注入：
   - 上次注入后 `current_phase` 变了 → 注入
   - 上次注入后 N=5 轮 → 注入（防 AI 遗忘）
   - `phase_history` 最近一跳是 rollback → 注入专属 re-entry 块
   - 否则跳过（避免每轮刷屏）
4. 输出 `{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "..." } }`

去重状态存哪？
- 候选 A：`.trellis/.workflow-inject-state`（gitignored，记录上次注入的 phase + turn count）
- 候选 B：用 task.json 自身（`last_injected_phase` 字段）
- 倾向 A（避免每轮都写 task.json）

**完成标志**：
- 可跑，输出符合 PreToolUse/UserPromptSubmit JSON 规范
- 面包屑 <500B
- 去重逻辑有测试覆盖

### Step 4 — 9 平台 hook 配置接线 [必做]

**动作**：在 9 个支持 UserPromptSubmit 的平台配置里加新 hook 引用。

| 平台 | 配置文件 | 事件名 |
|---|---|---|
| Claude Code | `.claude/settings.json` | `UserPromptSubmit` |
| Cursor | `.cursor/hooks.json` | `beforeSubmitPrompt` |
| Codex | `.codex/hooks.json` | `UserPromptSubmit` |
| Kiro | agent JSON 里的 `hooks` 数组 | `userPromptSubmit` |
| Qoder | `.qoder/settings.json` | `UserPromptSubmit` |
| CodeBuddy | `.codebuddy/settings.json` | `UserPromptSubmit` |
| Copilot | `.github/copilot/hooks.json` | `userPromptSubmitted` |
| Gemini | `.gemini/settings.json` | `UserPromptSubmit`（若支持，否则 fallback 到 BeforeTool） |
| Droid | `.factory/settings.json` | `UserPromptSubmit`（核实支持） |

**完成标志**：
- 每平台的 hook 配置 JSON 正确引用 `inject-workflow-state.py`
- configurator 把 hook 脚本写到对应平台的 hooks 目录
- 每平台 init 到 /tmp 冒烟，UserPromptSubmit hook 项存在

### Step 5 — OpenCode plugin 等价实现 [必做]

**动作**：OpenCode 用 JS plugin。在 `packages/cli/src/templates/opencode/plugins/` 新增 `inject-workflow-state.js`，hook 到 `chat.message` 事件（等价于 UserPromptSubmit）。

**完成标志**：plugin 能 fire、能注入 additionalContext 字段到消息。

### Step 6 — Skills 输出尾块 [必做]

**动作**：给 `common/skills/*.md` 每个 skill 的末尾加统一 `📍 Workflow State + Next` 块。

模板（skill 作者填内容）：

```markdown
---

## 📍 Workflow State

- **当前**: Phase <X.Y>
- **本次做了**: <skill-specific summary placeholder>
- **下一步**（按顺序）:
  1. <next step>
  2. <alternate path>
- **回流/异常**: <when to call break-loop / rollback>
```

为每个 skill 定制：brainstorm / before-dev / check / break-loop / update-spec。

`/continue` 命令模板也加同样的结尾。

**完成标志**：5 个 skill + continue 命令 + finish-work 命令都有末尾块；结构一致。

### Step 7 — `/trellis:rollback` 命令 [必做]

**动作**：新增 `common/commands/rollback.md`：

```markdown
# Rollback Workflow Phase

用户想回到更早的 phase（比如 check 完发现 bug、update-spec 后发现约定要改）。

## 步骤

1. 问用户：回到哪个 phase？（或从最近 phase 推断）
2. 跑 `{{PYTHON_CMD}} ./.trellis/scripts/task.py set-phase <X.Y> --reason "用户要求回流"`
3. 下一轮 UserPromptSubmit hook 会自动注入 rollback re-entry 面包屑
4. 按面包屑指引继续

## 原则

- 回流不是"重来一次"，是"从这里重新走下游"
- rollback 到 2.1 = 要重跑 2.2 check、视情况跑 3.3 update-spec、甚至 break-loop
```

**完成标志**：命令模板存在；9 个平台 configurator 产出正确的 rollback 命令文件。

### Step 8 — 测试 + 冒烟验证 [必做]

- `test/regression.test.ts` — 每平台 UserPromptSubmit hook 正确接线
- `test/scripts/task_py.test.ts`（或等价）— set-phase 正常/rollback/非法场景
- `test/hooks/inject-workflow-state.test.ts`（新）— 面包屑格式、去重逻辑、rollback 检测
- 手动冒烟：在本项目上开一个 dummy task，模拟 implement → check → 用户说回去改 → 检查是否看到 re-entry 面包屑

**完成标志**：`pnpm lint && pnpm test` 全绿；手动冒烟走通三个场景（正常推进 / 跳步被拦 / 回流）。

### Step 9 — Spec 文档 [必做·一次]

更新 `.trellis/spec/cli/backend/platform-integration.md`：
- 新章节 "Workflow State Injection: Per-turn breadcrumb"
- Touch-point 矩阵表（5 行：SessionStart / UserPromptSubmit / PreToolUse Task / Skill trailer / set-phase）
- 回流机制说明
- 指向 `fp-analysis.md`

**完成标志**：spec 更新；与 audit / fp-analysis 交叉引用。

---

## 完成标志（整体）

- [ ] `task.json` schema 含 `current_phase` + `phase_history` + `checkpoints`，migration 平滑
- [ ] `task.py set-phase` 可用；rollback 会重置下游 checkpoints
- [ ] `inject-workflow-state.py` 每轮 fire，面包屑 <500B，去重不刷屏
- [ ] 9 平台（UserPromptSubmit）+ OpenCode（plugin）都接线完成
- [ ] 5 skills + 3 commands（continue/finish-work/rollback）都有 `📍 Workflow State` 尾块
- [ ] `pnpm test` 全绿
- [ ] 手动冒烟：跳步被拦 + 回流自动 re-entry 两个场景验证通过
- [ ] spec + fp-analysis 交叉引用到位

## 非目标

- **不改 workflow.md 的 Phase 结构**：1.x/2.x/3.x 继续；只加状态承载
- **不解决 3 个 agent-less 平台的弱强制**（kilo/antigravity/windsurf）：接受已知局限
- **不做自动跳步拦截**（PreToolUse 禁止某些 tool）：首版只做引导注入，强制拦截留作后续
- **不重写 start.md / continue.md 的骨架**：只在末尾加 Workflow State 块

## 关联

- 上游：`04-17-subagent-hook-reliability-audit`（UserPromptSubmit 可用性已验证）
- 同级：`04-17-pull-based-migration`（同样哲学：状态上磁盘 + 注入强制）
- 归属：`04-16-skill-first-refactor`（主 task）
- 分析文档：`./fp-analysis.md`（第一性原理完整推理）
