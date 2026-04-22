# Finish-work 职责重划 + Phase 3 commit 自动化

> Task 创建时机：2026-04-22 beta.9 发版前夕。用户反馈 `/trellis:finish-work` 收尾体验差、会在末尾产生多个 trailing chore commit。
> 已经做过一轮实现但**全部回滚**，留待此 task 正式 brainstorm → execute。

## 背景

### 用户反馈（来自群聊截图）

1. **"0.5 是不是把 record session 移除了 / 合并到 finish work 了 / nice / 但是其实交互还是 2 次 / 因为 finish work 不会提交，所以需要手动提交，然后再告诉它记录 session / 反倒有点奇怪"** —— 体验没改善，只是改了名字。
2. **"感觉 0.5.0 版本的 finished work 设计有点奇怪 / 调用了之后 还是要手动 commit 才能完成 / 对 可以加上自动 commit 吗"** —— 希望 AI 自动 commit，少一次交互。
3. **"不过之前也存在问题 /record 后还会再提交一次 我每次都是压缩提交"** —— 现有 `/record-session`（现已合并进 finish-work）本身就产生 trailing chore commit，用户每次都要 squash。

### 当前问题根源

`/trellis:finish-work` 的流程是：
- Step 1: 提示用户 review + commit（AI 不自己 commit）
- Step 2: `task.py archive <name>` — **自动 commit** `chore(task): archive X`
- Step 3: `add_session.py --commit <hash>` — **自动 commit** `chore: record journal`

所以一个任务收尾下来，用户的 git log 结尾长这样：

```
chore: record journal                     ← add_session.py 自动 commit
chore(task): archive <task-name>          ← task.py archive 自动 commit
<用户的 N 个 work commit>
```

2 个 trailing chore commit、合并逻辑割裂、额外 AI 交互次数 = 整个体验被吐槽的根因。

## 任务目标

重新划分 `/trellis:continue` / `/trellis:finish-work` 与 Phase 3 step 的边界，让：

- AI 能在一次调用里完成 "commit 代码 + archive + record session"
- commit message 由 AI 起草，**commit 前必须由用户确认**
- Trailing bookkeeping commit 最少（目标：0 或可选 squash 到上一次 work commit）

## 已探索但未定的方向

### 方向 A：Phase 3.4 新增 Commit 步骤，finish-work 回归纯 record-session

- Phase 3.4 由 AI 按批次 commit 代码（user confirm message）
- `/trellis:finish-work` 只做 archive + add_session（前置条件：working tree 已清）
- **已实现但回滚**。问题：archive + add_session 还是会各产生一个 trailing commit；与"压缩提交"目标差距没完全消除

### 方向 B：journal 删掉 `### Git Commits` 段 + hash 字段

- 观察：hash 字段脚本写入后**无任何消费者**，"Message" 列还硬编码 `(see git log)`
- 代价：**用户讨论后决定保留 hash**，因为它是人类回查的软引用
- 结论：**放弃此方向**

### 方向 C：Phase 3.4 commit 覆盖所有 bookkeeping（TODO brainstorm）

- record-session + archive 都 stage-only（不自动 commit）
- Phase 3.4 commit plan 里把两者纳入最后一个批次
- 问题：hash 和 journal 的鸡生蛋——journal 需要填 hash，但 hash 要到 commit 后才有
- 候选解法：
  - 先 commit 代码 → 拿到 hash → 回填 journal → amend commit（风险：amend 改变 hash，journal 里填的 hash 作废）
  - 两阶段 commit：code 一个 commit（产生 hash）+ bookkeeping 一个 commit（journal 填 code commit 的 hash）
  - 延迟 hash：journal 先空着 hash 字段，commit 完后再改 journal，再单独 commit journal

## 开放问题（brainstorm 时需拍板）

1. **commit 授权边界**：AI 自动 commit 要不要每个 commit 都 user-confirm？还是展示整批 plan 一次性确认？
2. **pre-existing dirty state**：用户本地还有别的 task 的 WIP 改动时 AI 怎么处理？
3. **`--amend` 使用范围**：违反"AI 不改已有 commit"原则，但此场景本地刚造的 commit 没 push，是否例外？
4. **多 task 混 commit**：单次收尾流程里，task 相关 / 无关改动如何分批？
5. **commit message 风格**：AI 怎么知道 repo 的 commit 风格？靠 `git log --oneline -5` 自动学？还是让用户在 spec 里声明？
6. **逃生阀**：用户想完全手动控制时怎么退回老流程？`--manual-commit` flag？
7. **journal hash 生成时机**：hash 必须在 journal 写入前拿到，这对流程顺序强约束。如何优雅处理？
8. **finish-work 重新定义**：是回归纯 record-session 语义，还是继续保留收尾一把梭角色？

## 不目标

- 不重新引入 `/record-session` 命令（保持命令数量收敛）
- 不修改 `.current-task` / `.developer` 等其他 workspace state 的语义
- 不动老的 journal 记录（已有 session 的 Commits 列保留，新 session 行为可变）

## 关联

- 用户反馈来源：群聊截图（小智马本马、trellis 用户-js、崔博凡、LUA 等）
- 已回滚的实现：本次会话 2026-04-22 上下文
- 相关代码文件：
  - `packages/cli/src/templates/trellis/scripts/add_session.py`
  - `packages/cli/src/templates/trellis/scripts/task.py` (archive)
  - `packages/cli/src/templates/trellis/scripts/common/task_store.py` (`_auto_commit_archive`)
  - `packages/cli/src/templates/common/commands/finish-work.md`
  - `packages/cli/src/templates/trellis/workflow.md` (Phase 3)
  - `packages/cli/src/templates/shared-hooks/inject-workflow-state.py` (completed breadcrumb)
  - `packages/cli/src/templates/opencode/plugins/inject-workflow-state.js` (completed breadcrumb)

## 下一步

正式 `/trellis:start` 本任务时走完整 brainstorm 流程，拍板方向 A / C / 其他，然后 execute。beta.9 不含本任务；本 task 目标 beta.10 或之后。

## 优先级

🟡 **P2** —— 用户反馈明确、设计分歧明确，但 beta.9 已经攒了足够内容可以先发。

## 风险

- **用户习惯**：现有 auto-commit 行为突然安静会让老用户懵，需要大字 changelog + 迁移说明
- **`--amend` 边界**：任何涉及 amend 的方案都要明确"仅本地、仅刚创建、无 push"三个前置
- **journal hash 闭环**：hash 生成和 journal 写入的时序是设计难点，多个候选方案都有代价
