# Phronia 分叉重构

## Goal

把当前 Trellis 0.6.17 分叉重构为 Phronia：把上下文注入收口到单一核心入口，给适配层补上 harness 版本轴，把运行时增强做成可降级的天花板。最终目标是长期可维护的分层架构，而不是在 22 个平台上继续维护平行实现。

权威计划（仓库外）：

```
/Volumes/MagicStorage_TB3/xpeng-work/working_project/phronia_重构计划/
├── trellis-fork-重构计划.md      原始计划
└── BATCH/                        批次拆解（17 份文档 + CSV + 执行状态）
```

## Scope

| 批次 | 内容 |
|---|---|
| B0 | 基线冻结与工程护栏（当前） |
| B1 | 身份迁移 Trellis → Phronia（含 `adopt`） |
| B2 | 状态核心（TS 只读） |
| B3 | 上下文核心 `phronia context`（范围 A） |
| B4 | 能力与行为绑定矩阵（范围 C） |
| B5 | 适配器薄化 + harness 版本轴（范围 B） |
| B6 | shim 工件化 + 契约 fixture（范围 D） |
| B7 | ZCode 专项（范围 I） |
| B8 | mem 地板优先（范围 F） |
| B9 | 规范规则账本（范围 L） |
| B10 | 二进制化（范围 E） |
| B11 | 会话绑定加固 + worktree（范围 G） |
| B12 | spec 冷启动 + 可见知识层（范围 J+K） |
| B13 | 网关研究（范围 H，观望） |

## Requirements

1. **单一实现**：上下文装配、状态解析、平台能力、信封渲染各只有一份实现。
2. **显式降级**：任何不支持/探测失败/未初始化状态，必须能被用户看到（`doctor` 或注入内的降级说明），禁止静默 no-op。
3. **版本轴**：适配器身份为 `(platform, harnessVersion, adapterId, shimVersion)`；未知版本走保守路径，不猜。
4. **分层**：
   - `packages/core` 不含 harness SDK、不读 `process.cwd()`；
   - `packages/cli` 只做参数/输出；
   - `packages/shims` 单文件 ≤120 行，只做输入映射与信封渲染。
5. **地板优先**：mem 先召回 `.phronia/` 自写记忆；harness reader 是可插拔增强器。
6. **规范可证伪**：规则有 ID/scope/severity/check/status；check 输出逐条 verdict。
7. **改名有损边界**：用户资产无损；Phronia 生成物可重新生成；迁移报告可审计。
8. **AGPL-3.0**：保留上游版权与 NOTICE；修改留痕；对外分发附源码。

## Constraints

- 不重写为 Rust；复用现有 TS 资产。
- 不引入运行时依赖到 `packages/core`（测试/构建依赖除外）。
- 不手工批量修改 `.phronia/`（B1 前为 `.trellis/`）；一律通过工具再生成。
- 不删除用户内容；删除上游文件必须登记。
- 每个批次结束必须通过统一验收门槛（BATCH/README.md §5）。

## Acceptance Criteria

- [ ] G0：基线可复现；fixture/parity/幂等工具可用。
- [ ] G1：全仓库无字面量 `.trellis`；`adopt` 对上游 fixture 成功；dogfood 幂等。
- [ ] G2：状态 parity 白名单为空；能力矩阵 `--check` 通过。
- [ ] G3：12 个有 hook 平台的注入 parity；Kiro 修复；删除 ≥8,000 行重复实现。
- [ ] G4：版本轴可探测；`unsupported` 显式；fixture 覆盖矩阵 100%。
- [ ] G5：ZCode 三路径可选；bridge ≤30 行；真实 3.8 fixture。
- [ ] G6：mem 地板可用；规则账本 dogfood 跑通。
- [ ] G7：五 target 二进制可运行；Python 删除；冷启动达标。
- [ ] G8：worktree 全流程；docs 三件套生成。
- [ ] G9：网关研究结论与触发条件。

## Out of Scope

- 闭源商业化 / clean-room 重写。
- 跨设备同步、云端网关。
- 规则引擎产品化。
- 自动创建远程仓库或自动 init 未纳管仓。

## Notes

- 决策登记：`BATCH/99-决策登记表.md`（D-01/D-02/D-03 已确认）。
- 执行状态：`BATCH/EXECUTION-STATE.md`。
- 计划修正项 P-01 ~ P-06 见 `BATCH/00-调查分析.md`，实现时以修正后的事实为准。
