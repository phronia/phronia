# 支持 Devin 平台（Windsurf 改名，#325）

## 缘起

issue #325：Windsurf 改名 Devin Desktop（Cognition 2026-06-02 OTA 更新，已查证为改名非两产品，见 research/windsurf-to-devin.md），配置目录从 `.windsurf/` 变为 `.devin/`（`.devin/` 优先，`.windsurf/` 向后兼容）。维护者已在 #325 认领（"我来搞一下"）。

## 目标

让 Trellis 跟进 Devin 改名：`trellis init --devin` 写 `.devin/` 配置，已装 `.windsurf/` 的项目可迁移。

## 方案（倾向 A：改名 + 迁移，见 research 设计选项）

- registry windsurf 条目改名为 devin（`name: "Devin"`、`configDir: ".devin/..."`、`cliFlag: "devin"`）
- 加 `rename-dir` migration：`.windsurf/workflows` → `.devin/workflows`、`.windsurf/skills` → `.devin/skills`（用项目已有的 rename-dir migration type，参照 beta.23 trellis-spec-bootstarp 改名）
- 保留 `--windsurf` 作 deprecated alias 一个版本，平滑过渡

## 实现前必须确认（research 待定项）

- [ ] Devin Desktop 实际读哪个子目录结构？（官方 FAQ 说 `.devin/rules/`，Trellis 用 `.windsurf/workflows` + `.windsurf/skills`——确认 Devin 是否读 `.devin/workflows`/`.devin/skills` 还是结构变了）
- [ ] Devin Local（替代 Cascade）是否带来 hook/agent 能力变化？重评估当前 `agentCapable: false` / `hasHooks: false`

## 验收

- [ ] `trellis init --devin` 写 `.devin/` 配置（正确子目录）
- [ ] `--windsurf` 仍可用（deprecated alias）或有迁移提示
- [ ] rename-dir migration 把已装 `.windsurf/` 迁到 `.devin/`，dogfood 验证迁移幂等
- [ ] registry-invariants / platforms 测试覆盖新 devin 条目
- [ ] docs-site 平台列表 + platform-map.md 更新（windsurf → devin，或并列）
- [ ] 实现后在 #325 回复并 close

## 状态
planning（已调研，待实现前确认 Devin 目录结构）。关联 #325。维护者已认领。
