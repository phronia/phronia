# Design — Phronia 分层重构

## 1. 分层

```
L2  shims          harness 原生 API → L0 事件；L0 响应 → harness 信封
                   单文件 ≤120 行，无业务判断

L1  CLI            commander 参数解析、输出格式、退出码
                   packages/cli

L0  core           契约 / 上下文装配 / 状态 / 平台注册表 / mem / 规则
                   packages/core，零运行时依赖，不读 process.cwd()

状态                .phronia/（B1 前 .trellis/）
                   tasks / spec / workspace / runtime
```

**硬规则**：

- `core` 不依赖 `cli`、不依赖 harness SDK、根目录显式传入。
- `cli` 不含业务逻辑。
- `shims` 不含任务状态、spec 选择、预算、prompt 拼装。
- 任何模块不得在没有显式 `projectRoot` 时向上搜索目录（CLI 交互路径例外）。

## 2. 契约

```ts
ContextRequest  { schemaVersion, event, platform{id,harnessVersion,adapterId},
                  projectRoot, input, env?, hints?, options? }
ContextResponse { schemaVersion, coreVersion, event, platform, projectRoot,
                  session{key,keySource,task,taskSource,taskStale},
                  blocks[], mutations[], effects[], envelope,
                  degraded, diagnostics[] }
```

- `schemaVersion` 整数、只增不改。
- core 不做 IO 副作用；`effects` 由 shim 执行。
- 失败策略显式：`degrade | silent-ok | fail-loud | disabled`。

## 3. 状态边界（B2 起）

- TS `StateReader` 只读。
- 写入仍由 Python 负责至 B10；`StateWriter` 接口先冻结。
- 读取语义与 Python 逐项 parity（黄金对照）。

## 4. 平台模型（B4/B5）

```ts
BehaviorBindings { sessionStart, subagentContext, workflowState,
                   shellIdentity, agentDefinitions }
EnvironmentCapabilities { gitRepo, gitRemote, symlinks }
LoopControl = "none" | "hooks" | "full"
```

- `none` 必须带理由。
- 适配器身份：`(platform, harnessVersion, adapterId, shimVersion)`。
- 未知版本 → 保守 fallback + `degraded`，不猜。

## 5. 质量模型

| 层 | 手段 |
|---|---|
| 单元 | vitest（core + cli） |
| 契约 | fixture 回放（每平台 × harness 版本） |
| 等价 | Python/TS 黄金对照 |
| 自举 | init/update 再生成幂等 |
| 性能 | hook 冷启动 p50/p95 |
| 规范 | 规则账本 + 逐条 verdict（B9） |

## 6. B0 的设计（当前批次）

B0 只加护栏，不改产品行为：

1. `docs/adr/`：决策留痕，D-01~D-20 合并为 5 份 ADR。
2. `packages/testing`：fixture 脱敏/录制/回放、parity diff、幂等断言。
3. `bench/hook-bench.mjs`：当前 Python hook 的冷启动基线。
4. CI：覆盖 `.trellis/**`；guardrails job。
5. `docs/legal/modification-log.md`：AGPL 修改留痕。

## 7. 风险

见 `BATCH/00-调查分析.md` §3 与各批次 §5。最关键：

- 状态双实现漂移（B2 parity 锁定）。
- 改名漏网（B1 lint 白名单 + grep 断言）。
- 统一 envelope 改变可见行为（逐条登记）。
- ZCode 构建不可探测（握手 + 三路径）。
- 规则账本自证合规（critical 必须机械化）。
