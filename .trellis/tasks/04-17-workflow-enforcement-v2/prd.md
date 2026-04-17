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
- `.trellis/scripts/common/` 的 task.json 读写（加 phase + checkpoints + phase_history 字段）
- `task.py` 新增 5 条子命令：`set-phase` / `next-phase` / `set-checkpoint` / `phase-history` / `check-consistency`
- `shared-hooks/` 新增 `inject-workflow-state.py`（UserPromptSubmit hook，内部调 `check-consistency`）
- 9 个有 UserPromptSubmit 的平台 hook 配置接线（claude/cursor/codex/kiro/qoder/codebuddy/copilot/gemini/droid）
- OpenCode plugin（`chat.message` 等价）
- `common/skills/*.md` 全部加 `📍 Workflow State` 结尾块（调 `set-checkpoint` + `next-phase`，不直接 `set-phase`）
- `shared.ts` 的 `buildPullBasedPrelude` 增加 "Step 0 MANDATORY set-phase" 段（class-2 平台的前缀）
- 新增 `/trellis:rollback` 命令模板
- spec 文档更新

**不动**：
- `workflow.md` 的 Phase 定义本身（1.x / 2.x / 3.x 结构不变）
- 3 个 agent-less 平台（kilo/antigravity/windsurf）的强制机制（接受弱保障）
- 已有的 hook（SessionStart、PreToolUse on Task）保留

## 核心决策（2026-04-17 讨论确定）

1. **Phase 推进规则集中在 `task.py next-phase`**：skill 结尾只 `set-checkpoint`，由 `next-phase` 查硬编码 `NEXT_PHASE_RULES` 表推进。Workflow 改了只改一处
2. **Class-2 pull-based prelude 第 0 步由 sub-agent 推进 phase**：用 `task.py advance-phase` 避免固定写死导致的 3.1 → 2.2 回退问题（Codex Cross-Review #5）
3. **一致性检查独立成 `task.py check-consistency` 命令**：hook 内嵌调用，也可手动调；规则集中便于测试
4. **`set-phase` 保留但收窄**：只用于 rollback / 异常纠正，正常推进走 `next-phase` / `advance-phase`
5. **`task.py create` 一站式**：新建 task 自动 init-context + start，强制要求 `--type` 参数。**消除 Phase 1.3** —— context 在 task 诞生时就 ready（消除"AI 跳过 init-context"失败模式；删除 `inline_implement` / `no_implement_jsonl` consistency 规则；去掉 monorepo-unaware 的 `src_modified` 硬编码）
6. **`/trellis:rollback` 命令不做**：`task.py set-phase` 倒退自然触发 rollback 语义 + L3 面包屑，不需要糖衣命令
7. **Phase 字段字符串化**：`current_phase` 用 `"2.1"`/`"done"`，跟 multi_agent pipeline 弃用的 int phase 字段彻底切断

## 前置前提（已具备）

- `04-17-subagent-hook-reliability-audit` 已确认 9 平台支持 UserPromptSubmit
- `04-17-pull-based-migration` 已 commit 让 class-2 平台 agent 从 pull 读文件——本任务的 phase 状态写 task.json 也是同样哲学
- Claude Code canary test 证明 hook 注入实际工作
- **`inject-subagent-context.py` 已有 `update_current_phase()` 函数**（`.claude/hooks/:114`，OpenCode plugin 等价实现同存），v2 只需把这个信号跟 UserPromptSubmit 串起来，不需要重写

## 起始状态（2026-04-17 深度 research 确认）

所有"需要新建"的断言已代码级核对，全部准确，无捷径：

| 项目 | 现状 | PRD 动作 |
|------|------|---------|
| `task.json.current_phase` | `0` (int) + 老 `next_action: [...]` | 改字符串 + 新 3 字段 |
| `task.py` 子命令 | 16 条老命令，5 条新命令全缺；`create` 无 `--type` | 加 5 条 + 改 2 条 |
| `phase.py`（255 行） | 整片基于 int 算术 | 完整重写 |
| `update_current_phase()` | 直接写 task.json | 改为 `advance-phase` wrapper |
| UserPromptSubmit hook | **0 平台**配置；`inject-workflow-state.py` 不存在 | 全新建 + 9 平台接线 |
| Pull-based prelude Step 0 | 无（只有 "Load Context First"） | `buildPullBasedPrelude` 插 Step 0 |
| Skills 尾块 | 5 skill + 2 command **全无** | 7 份都加 |
| 并发锁（fcntl.flock） | 无 | 需新加 |
| `multi_agent/` | 项目已删；模板源待确认 | 模板源也删 |

工作量评估：**XL**，串行依赖链（writer → reader → migration → 新命令 → hook → 平台接线 → skill 尾块），独立 session 进行。

---

## 执行清单

### Step 1 — `task.json` schema 扩展 + 迁移 [必做]

**动作**：扩展 `task.json` 增加 workflow state 字段。**phase 字段一律字符串**（`"2.1"` / `"done"` / `null`），跟老的整数 phase（multi_agent pipeline 遗留）彻底切断。

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
    "implement_completed": true,
    "check_passed": false,
    "spec_reviewed": false
  }
}
```

**checkpoints 清单**（两类：stored / derived，Codex R2 #3 吸收）：

**Stored checkpoints**（显式 set-checkpoint 写入 task.json）：
- `implement_completed` — implement sub-agent 跑完
- `check_passed` — check sub-agent 全通过
- `spec_reviewed` — update-spec 走过一遍（即使没写新东西也要标）
- `break_loop_ran` — break-loop 执行过（可选）
- `brainstorm_in_progress` — brainstorm skill 进行中标记（正向信号，skill 结束时清零）

**Derived checkpoints**（运行时从文件/目录算，**不进 task.json**）：
- `prd_exists` — 读 `prd.md`，去 HTML 注释和占位符后 >= 80 字符实质内容
- `research_recorded` — `research/` 目录非空

`set-checkpoint` 对 derived name **直接拒绝**（error：`"prd_exists" is a derived checkpoint, set it by writing the file`），防止 AI 绕过算法手动打 true。

`next-phase` / `check-consistency` 统一通过 helper 读所有 checkpoint（stored 查 task.json，derived 实时算）。

（注：**删掉 `context_configured`**，因为 `task.py create` 已经内置 init-context，context 在 task 诞生时就 configured）

**迁移范围**（Codex Cross-Review #1, #8 R1 吸收 + #4, #5 R2 吸收）：

- **schema 迁移**：老 task.json 里 `current_phase: 0` (int) / `next_action: [...]` (老字段) → 删除，改成 `current_phase: null` + 空 phase_history
- **代码修改**（扫全仓，所有读写 `current_phase` 的点）：
  - `.trellis/scripts/common/phase.py` — 所有 `current + 1` / `phase_num > current` 改成字符串比较或查表
  - `.trellis/scripts/common/task_store.py` — `cmd_create` 写 `current_phase: null` 不是 `0`，删除 `next_action`
  - `.trellis/scripts/multi_agent/*` — 已 deprecated，一并删除 pipeline 目录（confirm multi_agent 真的不用了，删文件 + 移除 task.py 里的相关子命令）
  - `packages/cli/src/commands/update.ts` — `trellis update` 若会创建 migration task，更新为新 schema 写入（不再 `current_phase: 0 + next_action`）
  - `.trellis/scripts/common/task_context.py` / `task_utils.py` — 同步改
  - `inject-subagent-context.py` 的 `update_current_phase()` — **彻底重写为 `advance-phase` wrapper**（见下方）
  - OpenCode plugin `inject-subagent-context.js` 的等价函数 — 同样改为 shell 调 `advance-phase`

#### `update_current_phase()` 改为 `advance-phase` wrapper（Codex R2 #4）

避免 phase 推进的双轨分叉：**`task.py advance-phase` 是唯一写入器**，旧 hook 改为调它。

```python
# inject-subagent-context.py 里
def update_current_phase(repo_root, task_dir, subagent_type, has_finish_marker=False):
    """Wrapper around task.py advance-phase. Does NOT touch task.json directly."""
    if subagent_type not in ("implement", "check"):
        return  # research / 其他 noop
    args = ["--for", subagent_type]
    if subagent_type == "check" and has_finish_marker:
        args.append("--finish")
    subprocess.run(
        [sys.executable, f"{repo_root}/.trellis/scripts/task.py", "advance-phase", *args],
        check=False,  # noop 返回 0 就行
        timeout=5,
    )
```

OpenCode plugin 同样改为 child_process 调 `task.py advance-phase`。

#### 实施顺序（Codex R2 #5）

**关键**：migration 必须放在所有 consumer 更新之后，否则新旧 schema 混写。

具体顺序（**不可并行**，必须串行）：

1. 先改所有 **writer**：`task_store.cmd_create`、`update_current_phase()` wrapper、OpenCode plugin、update.ts migration task 创建逻辑
2. 再改所有 **reader**：phase.py、task_utils.py、task_context.py、hook 读取端
3. 最后启用 **migration 脚本**：`trellis update` 首次跑会 convert 老 task.json
4. CI：加一条静态检查，禁止 `current_phase: 0` 或 `next_action:` 出现在代码里（防回归）

**兼容性策略**：一次性硬切换（v0.5 breaking change）。没有窗口期。

**phase_history 大小控制**：FIFO 限 20 条。超出时 pop 最早一条。

**完成标志**：
- migration 脚本可跑 + 测试覆盖（老 task.json → 新 schema）
- 全仓 `grep current_phase` 找到的每处都改过
- 所有 phase 读写点的单元测试绿
- `pnpm test` + `python -m pytest .trellis/scripts/` 全绿

### Step 2 — `task.py` 命令更新（7 条新/改）[必做]

```bash
# 【改】create 强制 --type，内置 init-context + start
python3 ./.trellis/scripts/task.py create "<title>" --type <backend|frontend|fullstack> \
    [--slug <name>] [--no-start]

# 【改】set-phase: 保留,但只用于异常 / rollback / 初始化
python3 ./.trellis/scripts/task.py set-phase <X.Y> [--reason "..."]

# 【新】next-phase: 正常推进,skill 结尾调用
python3 ./.trellis/scripts/task.py next-phase

# 【新】advance-phase: sub-agent Step 0 调用,按 action 安全推进(不会倒退)
python3 ./.trellis/scripts/task.py advance-phase --for <implement|check> \
    [--finish]  # check 的 finish 路径 flag

# 【新】set-checkpoint
python3 ./.trellis/scripts/task.py set-checkpoint <name> <true|false>

# 【新】phase-history
python3 ./.trellis/scripts/task.py phase-history

# 【新】check-consistency(独立命令, hook 也会内嵌调用)
python3 ./.trellis/scripts/task.py check-consistency [--json]
```

#### `create` 改动（Codex R1 #5 吸收用户简化 + Codex R2 #1 修正）

- **`--type` 带默认推断**（不强制报错，避免现有脚本全炸）：
  - 显式传 `--type` → 使用该值
  - 未传 → 从 `config.yaml` 的 `default_package.layers[0]` 推断（单 package 项目通常推断出 `backend`）
  - 无法推断（多 package + 无 default + 无项目约定）→ `--type` 才变成必需，报错并列出可选值
  - 推断成功时 stderr warning："No --type given; inferred '<value>' from <source>. Pass --type explicitly to silence."
- **自动 init-context**：create 完立即调用内部 `init_context(task_dir, type)`，生成 `implement.jsonl` + `check.jsonl`
- **自动 start 的场景约束**（R2 #1）：
  - 默认把新 task 设为 current（写入 `.current-task`）
  - **`--parent` 传入时默认 `--no-start`**（子任务不应该抢断父任务的 current 指针）
  - `--no-start` flag 保留（批量创建或脚本化场景）
- **初始化 phase**：`current_phase = "1.0"`，`phase_history = [{"phase": "1.0", "at": ..., "action": "create"}]`
- **预建 `research/` 目录**：避免 AI 后续要自己 `mkdir -p`
- **预填 `prd.md` 骨架**：4 节模板，AI 在 brainstorm 时填内容

```markdown
# <title from --title>

## Background

<!-- 为什么做这个？上下文、触发动机、相关历史。1-3 段。 -->

## Goal

<!-- 要达成什么？一句话可度量。 -->

## Acceptance

<!-- 什么算完成？验收清单（勾选框形式）。 -->

- [ ] <acceptance criterion 1>

## Notes

<!-- 附带信息：决策、约束、边缘情况、已知风险。可选。 -->
```

骨架里的 `<!-- -->` 注释给 AI 当 prompt 用，brainstorm 时把内容填进去、注释保留或删掉。

对应 checkpoint 的判断要升级：**`prd_exists` 的判定从"文件存在" → "文件存在 AND Background/Goal/Acceptance 至少一项非空"**（防止骨架就算数）。

#### `set-phase` 行为
- 更新 `current_phase`
- append 到 `phase_history`（含时间戳、可选 reason）
- 如果 `X.Y < previous`（phase 号倒退）→ 标记 rollback + 设置 `checkpoints` 对应下游项为 `false`（强制重新验证）
- 如果 phase 不在合法集合（`1.0` / `1.1` / `1.4` / `2.1` / `2.2` / `2.3` / `3.1` / `3.2` / `3.3` / `3.4` / `done`）→ error
- **正常推进禁止用此命令**（约定由 skill 文档强调，runtime 不拦截）

#### `next-phase` 行为

查硬编码 `NEXT_PHASE_RULES` 表（已修正 Codex Cross-Review #2），根据 `current_phase` + `checkpoints` 自动推进：

```python
NEXT_PHASE_RULES = [
    # (current_phase, required_checkpoints, next_phase, action_label)
    ("1.0", {"brainstorm_in_progress": True}, "1.1", "brainstorm-started"),
    ("1.1", {"prd_exists": True}, "1.4",  "brainstorm-complete"),
    ("1.4", {}, "2.1", "ready-to-implement"),        # context 已在 create 时配置
    ("2.1", {"implement_completed": True}, "2.2", "implement-done"),
    ("2.2", {"check_passed": True}, "3.1", "check-passed-enter-finish"),
    ("3.1", {"check_passed": True}, "3.3", "finish-check-done"),
    ("3.3", {"spec_reviewed": True}, "3.4", "spec-review-done"),
    ("3.4", {}, "done", "finish-work-complete"),
]
```

行为：
- 匹配到规则 → 推进 + 输出 `1.1 → 1.4 (advanced via: prd_exists)`
- 不满足 required checkpoints → 退出 2 + stderr "still at 1.1, missing: prd_exists"
- 已在 `done` → noop

#### `advance-phase` 行为（新，Codex Cross-Review #5 吸收）

sub-agent spawn 时调用，按 action 类型推进**且保证不倒退**：

```python
ADVANCE_ACTIONS = {
    ("implement", False): {"to": "2.1", "from_allowed": ("1.4",)},
    ("check", False):     {"to": "2.2", "from_allowed": ("2.1",)},
    ("check", True):      {"to": "3.1", "from_allowed": ("2.2", "3.3", "3.4")},  # --finish flag
}
```

行为：
- 当前 phase 在 `from_allowed` → 推进到 `to`
- 当前 phase `>=` 目标 → noop（**不倒退** → 解决 "3.1 check 被误拉回 2.2" 的 bug）
- 当前 phase 比 `from_allowed` 还早（跳步） → 退出 2 + stderr "jumped: current=1.0, expected=1.4"

#### `set-checkpoint` 行为
- 更新 `task.json.checkpoints[name] = value`
- 合法 name 仅限 **stored 类** checkpoint（见 Step 1）
- **derived 类** checkpoint（`prd_exists` / `research_recorded`）→ 直接 error：`"prd_exists is derived — set by editing prd.md, not via set-checkpoint"`
- 未知 name → error（防 typo）

#### `is_prd_ready()` derived 计算（Codex R2 #3）

```python
_PLACEHOLDER_RE = re.compile(r"<!--.*?-->|<[^>]+>|\bTODO\b|\bTBD\b|\bFIXME\b", re.S)

def is_prd_ready(task_dir: Path) -> bool:
    prd = task_dir / "prd.md"
    if not prd.is_file():
        return False
    text = prd.read_text(encoding="utf-8")
    # 去 HTML 注释 + 占位符 + TODO/TBD/FIXME
    text = _PLACEHOLDER_RE.sub("", text)
    # 留纯 body（去 markdown heading 空壳）
    body = "\n".join(
        line for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    )
    return len(body) >= 80
```

单元测试必须覆盖：空骨架 false / 填 TODO false / 填 `<title>` 占位符 false / 填实质内容 true。

#### `check-consistency` 行为
扫 task_dir + git，对比 `current_phase` / `checkpoints` 与文件系统真实状态，输出不一致的 warning 列表。规则见 **Step 3b**。

`--json` 模式输出机器可读（给 hook 用）；默认人类可读。

**完成标志**：每条命令 ≥3 个单元测试（正常 / 非法 / 边界）；`NEXT_PHASE_RULES` 和 `ADVANCE_ACTIONS` 各有 coverage；`create --type` 缺失时正确报错。

### Step 3 — `inject-workflow-state.py` hook [必做]

**动作**：新 hook 脚本，响应 `UserPromptSubmit` 事件，输出 workflow 面包屑。分三档 L1/L2/L3。

#### 决策逻辑

```python
def decide_level(state, fs_warnings):
    if not current_task:
        return SKIP
    if is_rollback(phase_history):            # 最近一跳 phase 号下降
        return L3_ROLLBACK
    if fs_warnings:                            # check-consistency 有 warning
        return L3_INCONSISTENT
    if phase_changed_since_last_inject:
        return L2
    if turns_since_last_inject >= 5:
        return L2
    return L1
```

#### 三档内容

**L1**（~80B，稳态）:
```
<trellis phase="2.1" task="04-17-foo"/>
```

**L2**（~400B，phase 切换或每 5 轮）:
```
<workflow-state>
Task: 04-17-foo
Phase: 2.1 (implement)
Progress:
  ✓ 1.0  ✓ 1.2  ✓ 1.3  ✓ 1.4
  → 2.1  ⏳ 2.2  ⏳ 3.3  ⏳ 3.4
Next: after implementing, load trellis-check skill (or spawn check sub-agent).
Do NOT skip check — it's [必做].
</workflow-state>
```

**L3-rollback** / **L3-inconsistent**（~500B，异常路径）:
rollback 版：列 `phase_history` 最后 N 条 + 强调"必须走完下游"
inconsistent 版：列 check-consistency 的 warnings + 建议修复命令

#### 去重状态

`.trellis/.workflow-inject-state`（gitignored）：

```json
{
  "last_injected_phase": "2.1",
  "last_injection_at": "2026-04-17T10:30:00Z",
  "turns_counter": 3
}
```

- 每次注入后写入
- hook 启动时读取 + 递增 turns_counter

#### 实现约束（Codex Cross-Review #6 吸收）

**分层延迟目标**：
- **L1 快路径**：只读 `.workflow-inject-state` + `task.json`，**不调 subprocess**，目标 <20ms
- **L2/L3 慢路径**：才调 `task.py check-consistency --json`（含 git IO），目标 <200ms
- L2/L3 触发频率：phase 切换 OR 每 5 轮一次 OR 检测到 rollback / 上一次 consistency 有 warning

**`check-consistency` 内部缓存**（避免大仓库 git diff 爆表）：
```python
# cache key: (git_head_sha, current_phase, checkpoints_hash)
# 同 key → 5 分钟内复用上次结果
```

**字节预算**：
- 面包屑 L1 <100B / L2 <500B / L3 <700B（rollback 或 inconsistent）
- 内部调用 `task.py check-consistency --json`（仅 L2/L3）
- 输出格式：`{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`

**并发安全**（Codex Cross-Review #4 吸收）：
- `.workflow-inject-state` 读写用 file lock（fcntl.flock）+ 临时文件 + rename 原子写入
- `task.json` 读写同样处理（`task_store.py` 所有 write 点都包装）
- 冲突策略：last-writer-wins，但写入前重新读取以降低丢更新概率

**完成标志**：4 档（SKIP/L1/L2/L3）都有测试；去重逻辑有测试覆盖；L1 平均 fire <20ms（实测）；并发写 task.json + .workflow-inject-state 测试（两个 process 各写 100 次，无数据丢失）。

### Step 3b — `task.py check-consistency` 规则表 [必做]

`check-consistency` 命令内部跑的规则（独立抽出，方便测试 + 维护）：

```python
# task.py 内部
CONSISTENCY_RULES = [
    # (name, predicate, warning_template, suggestion)
    (
        "prd_missing_past_1.1",
        lambda p, cp, fs: p in ("1.4", "2.1") and not fs["prd_exists"],
        "phase >= 1.4 but prd.md missing — brainstorm incomplete?",
        "run trellis-brainstorm skill or task.py set-phase 1.1",
    ),
    (
        "check_without_changes",
        lambda p, cp, fs: p == "2.2" and not fs["git_changed"],
        "phase=2.2 (check) but no git changes — implementation step skipped?",
        "verify implement actually ran; maybe set-phase 2.1",
    ),
    (
        "finish_without_check",
        lambda p, cp, fs: p in ("3.1", "3.3", "3.4") and not cp.get("check_passed"),
        "phase=finish but check_passed=false",
        "spawn check sub-agent or load trellis-check skill",
    ),
    (
        "done_with_changes",
        lambda p, cp, fs: p == "done" and fs["git_changed"],
        "phase=done but uncommitted changes",
        "reminder: user commits, not AI",
    ),
]
```

**删除的规则**（Codex Cross-Review #5 + 用户简化建议吸收）：
- ~~`inline_implement`~~ — 依赖 `src_modified` 硬编码，monorepo 不适配；`task.py create` 内置 init-context 后这个场景大幅减少（1.3 这个 phase 消失了）
- ~~`no_implement_jsonl`~~ — `task.py create` 必然生成 jsonl，不再需要

fs 快照（hook 每次调用时算一次，Codex Cross-Review #7 吸收）：

```python
def fs_snapshot(task_dir):
    # 用 porcelain 覆盖 untracked + modified + staged
    porcelain = run_git("status", "--porcelain", "--ignored=no").splitlines()
    has_changes = bool(porcelain)

    return {
        "prd_exists": (task_dir / "prd.md").is_file(),
        "git_changed": has_changes,          # 统一信号, 不再区分 src_modified
        "research_has_files": (task_dir / "research").is_dir() and any((task_dir / "research").iterdir()),
    }
```

不再有 `src_modified` 字段 —— `git_changed` 是二元信号，配合 phase 就足够判断（不需要区分"改代码 vs 改文档"）。

**完成标志**：4 条规则各有 2 个 case（触发 / 不触发）测试；总规则数 4；fs 快照 `git status --porcelain` 输出被 mock 覆盖。

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

**动作**：给 `common/skills/*.md` 每个 skill 的末尾加统一 `📍 Workflow State + Next` 块。**skill 只负责声明"完成了什么"（`set-checkpoint`），不直接 `set-phase`**——推进由 `task.py next-phase` 统一管。

#### 各 skill 对应的 checkpoint 动作

| Skill | 开始时 | 结束时（成功） |
|---|---|---|
| `trellis-brainstorm` | `set-phase 1.1` + `set-checkpoint brainstorm_in_progress true`（这是唯一允许 skill 自己 `set-phase` 的地方，因为要进入 1.1）| **不手动 set prd_exists**（它是 derived）；`set-checkpoint brainstorm_in_progress false` + `next-phase`（规则表会自动根据 derived `prd_exists` 推进到 1.4）|
| `trellis-before-dev` | —— | **无动作**（Codex R2 #2：before-dev 是"加载 spec 索引"，不是 phase 转换点；phase 推进由 spawn implement sub-agent 时的 hook / class-2 prelude 完成）|
| `trellis-check` | —— | check pass: `set-checkpoint check_passed true` + `next-phase`<br>check fail: 不调 next-phase，report failure |
| `trellis-update-spec` | —— | `set-checkpoint spec_reviewed true` + `next-phase`（推进到 3.4）|
| `trellis-break-loop` | —— | `set-checkpoint break_loop_ran true`（不推进 phase，break-loop 可在任何阶段触发）|

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

**完成标志**：5 个 skill + continue 命令 + finish-work 命令都有末尾块；结构一致；skill 里的 bash 代码块用 `set-checkpoint` + `next-phase`（不得出现 `set-phase X.Y` 除了 brainstorm 的开头那一处）。

### Step 7 — Class-2 pull-based prelude 强制 Step 0 advance-phase [必做]

**动作**：改 `packages/cli/src/configurators/shared.ts` 的 `buildPullBasedPrelude(agentType)`，在开头追加强制的 Step 0。**调用 `advance-phase` 而非固定的 `set-phase`**，避免 check sub-agent 被错误回退（Codex Cross-Review #5）。

```typescript
// shared.ts 伪代码
function buildPullBasedPrelude(agentType: "implement" | "check"): string {
  const advanceFlag = agentType === "check"
    ? "--for check"
    // check 的 finish 路径由主 agent 通过 prompt 里的 `[finish]` marker 告知,
    // sub-agent Step 0 只负责 execute 路径; finish 路径由主 agent 在 spawn 前
    // 自己 advance 到 3.1
    : "--for implement";

  return `## Required: Load Trellis Context First

### Step 0: Advance workflow phase (MANDATORY — first action)

Your very first tool call MUST be:

\`\`\`bash
python3 ./.trellis/scripts/task.py advance-phase ${advanceFlag}
\`\`\`

\`advance-phase\` is idempotent and will NOT roll back the phase — if the
main agent already advanced, this is a no-op. If phase hasn't been advanced
yet (pull-based platforms, no PreToolUse Task hook), this writes it.

Do NOT Read, Write, Glob, Grep before this.

### Step 1: Read \`.trellis/.current-task\` ...
...`;
}
```

#### Check sub-agent 的 finish 路径

为避免 sub-agent 猜"我是 execute-check 还是 finish-check"：
- **主 agent** 在 spawn finish-check sub-agent 前自己调 `task.py advance-phase --for check --finish`（写入 3.1）
- **sub-agent Step 0** 统一调 `advance-phase --for check`（无 --finish），由 `advance-phase` 的 from_allowed 判断：
  - 主 agent 已写 3.1 → sub-agent Step 0 的 `advance-phase --for check` 发现 `current=3.1 >= target=2.2` → noop
  - 主 agent 没写（普通 execute path） → Step 0 推进 2.1 → 2.2 ✓

#### 为什么强制而非软性
- Class-2 平台没有 PreToolUse Task hook 自动写 phase
- 漏执行 → UserPromptSubmit 注入与现实脱节
- 兜底：`check-consistency` 抓到 phase 未推进的矛盾并警告

#### 影响范围
- 只影响 `implement` / `check` 两种 sub-agent 类型（research 不走 prelude）
- 4 个 class-2 平台（qoder/gemini/codex/copilot）
- 不影响 hook-inject 的 6 个平台（它们走 `update_current_phase()`）

**完成标志**：
- `buildPullBasedPrelude` 产出含 "Step 0" 段且使用 `advance-phase`
- `applyPullBasedPreludeMarkdown` / `applyPullBasedPreludeToml` 测试更新
- class-2 平台 init 到 /tmp 冒烟：第一条指令是 `advance-phase`
- 手动冒烟验证：phase=3.1 时 spawn check sub-agent，Step 0 不会把 phase 倒退到 2.2

### Step 8 — 测试 + 冒烟验证 [必做]

- **task.py 单元**（python test 或 `test/scripts/`）：
  - `create` 强制 `--type`：缺失报错、自动 init-context + start、`--no-start` flag、预建 `research/` 目录、预填 `prd.md` 含 4 节骨架
  - `prd_exists` 判定：空骨架 → false；有任一 section 非空 → true
  - `set-phase` 正常 / 倒退触发 rollback + 重置 checkpoints / 非法 phase 号
  - `next-phase` 规则匹配 / 缺 checkpoint 时退出 2 / done 状态 noop
  - `advance-phase` 正常推进 / 已是更高 phase 时 noop（关键：不倒退）/ 跳步报错
  - `set-checkpoint` 合法 name / typo 报错
  - `check-consistency` 4 条规则各 2 个 case（触发 / 不触发）
- **hook 单元**（`test/hooks/inject-workflow-state.test.ts` 新）：
  - SKIP / L1 / L2 / L3-rollback / L3-inconsistent 五种输出
  - 去重：`.workflow-inject-state` 文件读写、turns_counter 递增
  - 字节数断言：L1 <100B、L2 <500B、L3 <700B
  - **L1 快路径断言**：不调 subprocess（mock subprocess.run 验证未被调用）
  - **并发安全**：两个 process 各写 100 次 `.workflow-inject-state`，无数据丢失
- **集成**（`test/configurators/`、`test/commands/init.integration.test.ts`）：
  - 9 平台 init 后 hook 配置含 UserPromptSubmit 条目
  - OpenCode plugin 配置正确
  - class-2 平台 agent definition 顶部含 "Step 0" advance-phase 指令
- **回归**（`test/regression.test.ts`）：
  - Skill 模板里不出现 `set-phase 2.1/2.2/...`（除 brainstorm 开头），防回归
  - consistency rules 文件形态锁定
- **手动冒烟**（本项目，开一个 dummy task）：
  - 场景 1 正常推进：create --type → brainstorm → prd 定稿 → implement → check → finish → 验证每步 UserPromptSubmit 面包屑方向正确
  - 场景 2 跳步被拦：AI 直接 spawn implement 不走 brainstorm → consistency 触发 "prd_missing_past_1.1" warning
  - 场景 3 回流：check 完后 `task.py set-phase 2.1` → 下轮注入 L3 rollback re-entry 面包屑
  - 场景 4 finish-check 不回退：phase=3.1 时 spawn check sub-agent，Step 0 `advance-phase --for check` 不把 phase 拉回 2.2

**完成标志**：`pnpm lint && pnpm test` + `python -m pytest .trellis/scripts/` 全绿；四个场景手动走通；L1 hook fire 时间 <20ms（实测）。

### Step 9 — Spec 文档 [必做·一次]

更新 `.trellis/spec/cli/backend/platform-integration.md`：
- 新章节 "Workflow State Injection: Per-turn breadcrumb"
- Touch-point 矩阵表（5 行：SessionStart / UserPromptSubmit / PreToolUse Task / Skill trailer / set-phase）
- 回流机制说明
- 指向 `fp-analysis.md`

**完成标志**：spec 更新；与 audit / fp-analysis 交叉引用。

---

## 完成标志（整体）

- [ ] `task.json` schema 含 `current_phase`（字符串）+ `phase_history` + `checkpoints`；全仓 phase 读写点迁移完成
- [ ] `task.py` 7 条命令就绪：`create`（含 `--type` 推断 / `--parent` 默认 no-start / 内置 init-context + start + 预填 prd 骨架 + 预建 research/）/ `set-phase` / `next-phase` / `advance-phase` / `set-checkpoint`（对 derived 类拒写）/ `phase-history` / `check-consistency`
- [ ] `prd_exists` / `research_recorded` 是 derived checkpoint，运行时从文件算，不进 task.json
- [ ] `is_prd_ready()` 解析器能识别 HTML 注释 / 占位符 / TODO，拒绝空骨架
- [ ] `update_current_phase()` 在 class-1 hook 里改为 `task.py advance-phase` wrapper，单一 phase 写入器
- [ ] 实施顺序：writer 改完 → reader 改完 → migration 启用；CI 拦截旧 schema 字段回潜
- [ ] `NEXT_PHASE_RULES` 闭环（含 `1.0→1.1`、`1.1→1.4`、...、`3.4→done`）
- [ ] `ADVANCE_ACTIONS` 表确保 sub-agent Step 0 不会倒退 phase
- [ ] `check-consistency` 的 4 条规则独立抽出、可测试、hook 内嵌调用；fs 快照用 `git status --porcelain`（不再依赖硬编码目录）
- [ ] `inject-workflow-state.py` 每轮 fire，L1 快路径 <20ms / L2/L3 <200ms；`.workflow-inject-state` 并发写安全
- [ ] 9 平台（UserPromptSubmit）+ OpenCode（plugin）都接线完成
- [ ] Class-2 pull-based prelude 包含 MANDATORY Step 0 `advance-phase` 指令
- [ ] 5 skills + 2 commands（continue/finish-work）都有 `📍 Workflow State` 尾块；skill 尾块只用 `set-checkpoint` + `next-phase`（brainstorm 开头是唯一 set-phase 例外）
- [ ] `pnpm test` + python 单元全绿
- [ ] 手动冒烟：正常推进 + 跳步被拦 + 回流 re-entry + finish-check 不回退 四个场景走通
- [ ] spec + fp-analysis 交叉引用到位

---

## Codex Cross-Review (2026-04-17)

**Reviewer**: gpt-5.3-codex via `mcp__codex-cli__codex` (reasoningEffort: high)
**Result**: 4 CRITICAL + 4 WARNING，**全部验证有效**；7 条吸收，1 条替代方案解决。

| # | Level | Issue | Resolution |
|---|-------|-------|-----------|
| 1 | CRITICAL | `current_phase` 字符串/int 冲突 with `phase.py` | 吸收 → Step 1 扩大迁移范围，字符串化 |
| 2 | CRITICAL | `NEXT_PHASE_RULES` 1.1 断裂、checkpoint name 未注册 | 吸收 → Step 2 闭环规则表 + Step 1 allowed names |
| 3 | CRITICAL | `/rollback` 命令缺 `SKILL_DESCRIPTIONS` | 替代 → 不做 rollback 命令，`set-phase` 倒退自带 rollback 语义 |
| 4 | CRITICAL | 无锁 read-modify-write 并发丢更新 | 吸收 → Step 3 加 file lock + atomic rename |
| 5 | WARNING | Class-2 Step 0 固定写死 2.2 会回退 3.1 | 吸收 → Step 7 改用 `advance-phase`（不倒退语义） |
| 6 | WARNING | <100ms 对 subprocess + git IO 不现实 | 吸收 → Step 3 L1 快路径 <20ms，L2/L3 才 subprocess |
| 7 | WARNING | `src_modified` 硬编码 `src/, lib/` 不适配 monorepo | 吸收 → Step 3b 删 `inline_implement` 规则 + `git status --porcelain` |
| 8 | WARNING | Backward compat 迁移窄了（`cmd_create` / `create_pr.py`） | 吸收 → Step 1 扩大迁移范围 |

用户 2026-04-17 补充简化：`task.py create` 内置 init-context + start + `--type` 推断。消除 Phase 1.3，连带解决 #5 部分、#7 部分。

---

## Codex Cross-Review Round 2 (2026-04-17)

**Reviewer**: gpt-5.3-codex via `mcp__codex-cli__codex` (reasoningEffort: high)
**Result**: 4 CRITICAL + 1 WARNING，**全部是 R1 修复落地时引入的新裂口**，全部吸收。

| # | Level | Issue | Resolution |
|---|-------|-------|-----------|
| 1 | CRITICAL | `task.py create` 强制 `--type` + 默认 auto-start 会炸现有脚本 + 子任务抢 current 指针 | 吸收 → `--type` 改为推断优先 + 失败才报错；`--parent` 默认 `--no-start` |
| 2 | CRITICAL | `context_configured` checkpoint 已删但 `trellis-before-dev` 还在 set-checkpoint → 硬报错 | 吸收 → before-dev 不做 checkpoint / phase 变更（它是"读 spec"而非 phase 转换点）|
| 3 | CRITICAL | `prd_exists` 手动 set 会绕过"骨架已填"算法；TODO / 占位符也会误判 | 吸收 → `prd_exists` 改 derived checkpoint（不进 task.json，运行时从 prd.md 算）+ `is_prd_ready()` 解析器去 HTML 注释 / 占位符 / TODO |
| 4 | CRITICAL | `update_current_phase()` 直接写 `current_phase` 字段 → 跟 `advance-phase` 双轨分叉 | 吸收 → 重写为 `advance-phase` wrapper，`advance-phase` 成为单一 phase 写入器 |
| 5 | WARNING | `update.ts` / `multi_agent/*` 还会回灌旧 schema，实施顺序不严格会新旧混写 | 吸收 → Step 1 明确实施顺序：writer 改完 → reader 改完 → migration 启用 + CI 拦截旧 schema 回潜 |

本轮全为"修复引入新缝"类问题，收敛迹象明显；若再跑第三轮重点应转为实施顺序细节而非架构/契约。

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
