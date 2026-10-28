# 验收报告：并行执行准入控制

> 结论：**通过**（PASS）。代码、单测、集成测试、全量门禁、真实 CLI hook 矩阵、真实 plugin bridge、真实 worktree 均通过。
> 唯一未复跑项：最终 ZCode UI 会话（窗口处于未渲染状态，computer use 无法驱动）；harness 的 deny 交付已在 2026-10-28 的真实 ZCode 会话中单独验证（§3），bridge 输出在 §4 验证。

## 1. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-10-29 |
| 仓库 | `/Users/magicdian/Documents/personal_project/phronia` |
| 版本 | 2610.28.6（本地构建） |
| ZCode | 3.16.3（build 8992，commit a82dd43e） |
| 测试项目 | `/Users/magicdian/Documents/personal_project/aaa-phronia-admission-e2e`（验收后删除） |
| 全局 CLI | 临时指向 `packages/cli/bin/phronia.js`，验收后恢复 |

## 2. 全量门禁

```text
pnpm verify → exit 0
- layout / typecheck / layout-json / check:shims / lint / build: pass
- @phronia/core: 899 passed, 1 skipped
- @phronia/cli: 2058 passed
- @phronia/testing: 23 passed (incl. idempotence)
- basedpyright (lint:py): 0 errors
```

独立复跑（当前会话）：111 个 CLI 测试文件、2058 项，全部通过；core 899 项通过。

## 3. ZCode harness deny 真实验证（2026-10-28）

探针项目 + 只对 token 生效的 `permissionDecision:"deny"` 插件，真实 ZCode 会话 `session_c5fc40067adefae0d0e9380914a3ab27`：

```text
part(tool=Agent).state.status = "error"
part(tool=Agent).state.error  = "ZCODE_DENY_PROBE: ... Do not retry; report this exact message."
session where parent_id = session_c5fc40067... → count = 0
父模型未收到 PROBE_RAN，未重试
```

结论：ZCode 3.16.3 的 `PreToolUse:Agent|Task` deny **会阻止派发**（不创建子会话），但以工具错误结果交付，不弹权限层。`hookPolicy=block` 成立。

## 4. 真实 plugin bridge（Phronia 测试项目）

命令：ZCode 的 `.zcode/plugins/phronia/hooks/bridge.mjs --event subagent-spawn`，真实走 `phronia hook` → Python shim → `phronia context`。

父任务（session pointer = parent）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "DISPATCH_PARENT_TASK: parent task .phronia/tasks/10-29-e2e-parent has 2 children; a parent is a coordination container, not an implementation target\nNext:\n1. python3 ./.phronia/scripts/task.py start 10-29-e2e-child-a\n2. python3 ./.phronia/scripts/task.py start 10-29-e2e-child-b\n3. re-dispatch implement with Active task: <child>\nDo not retry; report this exactly."
  }
}
```

错误 checkout（child-b 已有 worktree，从 main 派发）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "DISPATCH_WRONG_CHECKOUT: task .phronia/tasks/10-29-e2e-child-b has a worktree at .../.phronia/worktrees/e2e-child-b, but the current checkout is ...\nNext:\n1. cd .../.phronia/worktrees/e2e-child-b\n2. re-dispatch implement from that checkout\nDo not retry; report this exactly."
  }
}
```

## 5. 准入矩阵（真实 task/runtime 文件）

| 场景 | 结果 |
|---|---|
| 父任务（session pointer） | `DISPATCH_PARENT_TASK` deny；next 含逐条 child start |
| 子任务 `planning` | `DISPATCH_TASK_NOT_IN_PROGRESS` deny |
| 子任务 `in_progress`、main 无 claim | allow + `DISPATCH_NO_CLAIM` 守卫块（`task:` / `workspace:` / `claim:` / `lease:` / `parallel:` / `risk:` / `next:`） |
| `workspace ensure` 后 | allow，无守卫（claim 绑定到 child-a） |
| 两个 `in_progress` 子任务 + `worktree=always`，从 main 派发 | `DISPATCH_ISOLATION_REQUIRED` deny；next 为多会话四步 |
| `ensure` 后从 main 派发 | `DISPATCH_WRONG_CHECKOUT` deny |
| 从任务 worktree 派发 | allow，无守卫 |
| `phronia-research` | allow，无守卫 |

## 6. Worktree 证据

`ensure child-b`：

```json
{
  "ok": true,
  "decision": {
    "kind": "create",
    "path": ".../.phronia/worktrees/e2e-child-b",
    "branch": "phronia/e2e-child-b",
    "base": "main",
    "reason": "current checkout is owned by .phronia/tasks/10-29-e2e-child-a",
    "code": "WORKSPACE_CLAIM_BUSY"
  }
}
```

```text
git worktree list:
.../aaa-phronia-admission-e2e                         ebd14a0 [main]
.../aaa-phronia-admission-e2e/.phronia/worktrees/e2e-child-b  ebd14a0 [phronia/e2e-child-b]
```

## 7. `task.py start` 与 ensure 回归

```text
$ task.py start .phronia/tasks/10-29-e2e-parent
Error: this is a parent/coordinator task (2 children); it cannot be an implementation target.
Children:
  - .phronia/tasks/10-29-e2e-child-a  [in_progress]
  - .phronia/tasks/10-29-e2e-child-b  [planning]
Next:
  python3 ./.phronia/scripts/task.py start .phronia/tasks/10-29-e2e-child-a
  ...
Coordination only? Re-run with --coordinator.

$ task.py start parent --coordinator
✓ Status: planning → in_progress
Note: 'main' is the integration/base branch; task branch left empty.

$ ensure child-a --session-key test-e2e
{"ok":true,"decision":{"kind":"reuse-current",...},"claim":{"taskRef":".phronia/tasks/10-29-e2e-child-a"}}
```

dogfood：对本仓库的任务执行 `workspace ensure --reuse-dirty`，返回 `reuse-current`，claim 绑定到 `.phronia/tasks/10-28-parallel-dispatch-admission`（R13 修复生效）。

## 8. 未覆盖与风险

| 项 | 说明 |
|---|---|
| Codex 真实派发 | 本机没有 Codex 会话环境；`hookPolicy=inject` 与 `SubagentStart` envelope 由单测/集成测试覆盖，未做 live run |
| 最终 ZCode UI 复跑 | 当前 ZCode 窗口处于未渲染状态，computer use 无法驱动；harness deny 已在 §3 的真实会话验证，bridge 已在 §4 验证 |
| Worktree 多会话窗口 | 未开第二个 ZCode 窗口；从 worktree 的真实 `phronia context` hook 已验证 allow，`git worktree list` 已验证隔离 |
| 运行时隔离 | worktree 不隔离端口/数据库/Docker；已在 PRD Non-Goals 说明 |
| 未验证平台 | `hookPolicy=unknown` 的平台按 inject 处理（fail-closed），只注入守卫 |

## 9. Definition of Done

- [x] 可证明的违规被阻断：父任务、未启动、错误 checkout、main 被其他任务认领、隔离要求未满足，全部 deny，且有单测/集成测试。
- [x] 不可证明的归属被显式暴露：无 claim / lease 冲突 / 平台不能阻断，allow + guard，guard 含可执行 next。
- [x] 平台能力真实生效：ZCode 3.16.3 live deny（无子会话）；Codex 走 inject；OpenCode throw；未知平台 fail-closed。
- [x] 可观测：每轮 breadcrumb 显示 workspace/claim/lease/parallel；父任务显示 children 统计。
- [x] 不破坏常规路径：单任务、干净 main、无 claim 仍 allow；`parallel.enabled: false`、`worktree: never` 有明确降级。
- [x] 可回退：`parallel.dispatch.enforce: warn|off` 可即时降级；不新增数据格式；不引入守护进程。

## 10. 清理

- 探针项目 `aaa-zcode-deny-probe`、`/tmp/zcode-deny-probe` 已删除。
- e2e 项目 `aaa-phronia-admission-e2e` 已删除。
- 全局 `phronia` symlink 已恢复为 `../lib/node_modules/@phronia/cli/bin/phronia.js`。
- `/tmp/e2e-matrix.py`、`/tmp/phronia-local` 等临时文件已删除。
