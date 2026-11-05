# Footprint conflict preflight before task start

## Goal

在新建任务和启动任务两个时点，对当前活跃任务做 footprint 重叠预检，把"我正在改的文件和另一个进行中任务冲突"这件事提前到开始之前暴露，而不是等到 integrate 冲突。

预检只提示、不阻断。

## Problem

`footprintOverlap`（`packages/core/src/task/parallel/footprint.ts:139`）已经实现保守重叠检测，已有两处消费：

- `parallel/planner.ts:316`：只有在决定把任务放进同一波次时才比较。
- `integrate.ts:2969`：只在集成失败生成 handoff 时列出重叠任务。

也就是说，用户在**开始干活之前**拿不到任何冲突信号。任务 A 正在大范围重构 `rust/hub/src/auth/**`，任务 B 此时创建并开始改同一个目录，冲突要等到两边都改完、其中一方 integrate 时才浮现，此时返工成本最高。

另有一个语义陷阱必须处理：`footprintOverlap` 把"未知 footprint"判为重叠（`UNKNOWN_OVERLAP`），这个保守选择对 planner 正确（误判并行代价更高），但如果直接拿来当用户提示，任何未声明 `touches` 的任务都会报警，提示会立刻变成噪音。

## Requirements

### R1 只读预检命令

新增只读命令，输入一个任务 ref（或待创建任务的范围描述），输出：

- 与之确定的 footprint 重叠的活跃任务，逐条给出：对方 ref、重叠类型（equal / prefix / glob / package）、重叠的具体路径。
- footprint 未知的活跃任务单列，标注"无法判断"。

命令不修改任何状态，可安全重复调用。

### R2 分级判定

判定必须区分三种结果，禁止把它们压成同一个"冲突"：

| 结果 | 条件 | 呈现 |
|---|---|---|
| `conflict` | 双方 footprint 均为 declared/related，且 `footprintOverlap` 命中 | 列出具体路径与对方任务，建议顺序执行或缩小范围 |
| `unknown` | 至少一方 footprint 未知 | 提示声明 `meta.parallel.touches`，不声称冲突 |
| `clear` | 双方均已知且无重叠 | 静默或一行确认 |

`--json` 输出必须带 `severity` 字段，agent 可据此决定是否打断用户。

### R3 不阻断

预检结果不得阻止创建或启动任务。存在唯一的例外：若用户显式传入 `--require-clear`（或等价开关）才返回非零退出码；默认退出码为 0。

### R4 接入创建与启动流程

- `templates/common/skills/brainstorm.md`：任务创建后、填写 `meta.parallel.touches` 前提示先跑一次预检；若结果为 `unknown`，引导补齐 `touches` 再继续。
- `templates/common/commands/continue.md`：Step 2 解析 workspace 之后、开始实现之前跑一次预检；`conflict` 时向用户报告并给出"等待/缩小范围/继续并接受冲突风险"三选一。
- 现有 `parallel plan` 的重叠输出复用同一判定与文案，避免两套说法。

### R5 判定来源一致

预检、planner、integrate handoff 三处必须使用同一个重叠判定与同一个 footprint 归一化入口（`normalizeFootprint`），不得各自实现路径匹配。

## Acceptance Criteria

- [ ] 两个 declared footprint 分别覆盖 `rust/hub/src/auth/**` 与 `rust/hub/src/auth/store.rs` 时，预检返回 `conflict` 并指出 `rust/hub/src/auth/store.rs`。
- [ ] 一方未声明 footprint 时返回 `unknown`，措辞不出现"冲突"字样，且给出补齐 `touches` 的具体字段示例。
- [ ] 两个互不相交的 declared footprint 返回 `clear`。
- [ ] 默认退出码为 0；显式要求严格模式时非零。
- [ ] 预检不产生任何文件写入或状态变更（可用 git status 与 registry mtime 验证）。
- [ ] brainstorm / continue 文案已接入，且说明"提示不阻断"。
- [ ] planner 与 integrate 的重叠输出使用同一判定函数（可用测试断言共享入口）。

## Notes

- 依赖 `11-05-worktree-managed-root` 不是因为技术必要，而是因为集中根让"哪个目录属于哪个任务"的归因更清晰，冲突输出里可以带上目录。
- 该任务不做自动排序、不做自动延后；所有决策留给用户。
