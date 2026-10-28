# OpenCode v2 适配 — 实施计划

## Status (2026-10-28)

- Wave 0–3 已实现，`pnpm verify` 全绿（core 592、cli 1918、testing 23）。
- 端到端烟测通过：OpenCode 2.0.32 下 `init --opencode` 只写 v2 shard；
  真实 `opencode run` 注入 SessionStart；v1→v2 update 删除旧 shard；
  pin 回 v1 并在 `update --force` 后保留；OpenCode + ZCode 同项目共存；
  shell 身份能从 `OPENCODE_SESSION_ID` 解析，且不会被 ZCode 宿主误用。
- 待手工验证：真实 OpenCode 宿主里的 subagent dispatch（shim 单测已覆盖 prompt 改写）。

## 0. 开工前必读

- `.phronia/spec/cli/backend/platform-integration.md`
- `.phronia/spec/cli/backend/commands-update.md`
- `.phronia/spec/cli/backend/trellis-core-sdk.md`
- `.phronia/spec/cli/backend/filesystem-safety.md`
- `.phronia/spec/cli/unit-test/conventions.md`
- `.phronia/spec/core/backend/index.md`
- 本任务 `research/` 下三份调研记录

## 1. 执行顺序

四个 wave 串行。每个 wave 结束都必须是绿色状态（typecheck + 相关测试），
再进行下一个 wave。Wave 0/1 不改用户可见行为，Wave 2 才改变 `init`/`update`。

---

## Wave 0 — Core adapter 与契约

### 0.1 Adapter 注册

- [ ] `packages/core/src/platform/registry.ts`
  - 移除 `opencode@v2` 的 `unsupported`。
  - 增加 `OPENCODE_V2_EVENTS`（session-start / user-prompt / subagent-spawn / pre-tool-use）。
  - 新增 `adapterForRuntime(platform, adapterId): HarnessAdapter`：
    显式 adapterId 优先，缺失时回退 `adaptersFor(platform)[0]`。
- [ ] `packages/core/test/platform/adapter.test.ts`
  - 把“refuses opencode v1 for a 2.x harness and reports v2 unimplemented”
    改为“selects opencode v2 for a 2.x harness”。
  - 增加 `adapterForRuntime` 命中/回退用例。

### 0.2 能力矩阵按 adapter

- [ ] `packages/core/src/platform/capabilities.ts`
  - 新增 `CapabilityProfile` 与 `ADAPTER_OVERRIDES`。
  - 导出 `capabilitiesFor(platform, adapterId?)`，保留 `CAPABILITIES[platform]` 兼容。
  - `opencode@v2` 覆盖 behavior 与 `toolNames`（shell / subagent / edit: edit,write,patch）。
- [ ] `packages/core/test/platform/capabilities.test.ts`
  - v1/v2 profile 差异；未指定 adapter 时回退默认。

### 0.3 工具名与参数归一化

- [ ] `packages/core/src/context/index.ts`
  - `EDIT_TOOLS` 增加 `patch`。
  - `pre-tool-use` 分派使用 `capabilitiesFor(...).toolNames`，而不是硬编码字符串。
  - `readToolName` 优先读 `request.hints.toolName`。
- [ ] `packages/core/src/context/types.ts`
  - `hints` 增加 `parentSessionId`、`adapterId`（向后兼容，全部 optional）。
- [ ] `packages/core/src/context/contract.ts`
  - 同步 JSON Schema 的 hints 字段。
- [ ] 新增 fixture：`packages/testing/fixtures/contract/opencode-v2-context/`
  - `session.hook("context")` 形状：`system`、`messages`、`agent`、`sessionID`。
  - `tool.hook("execute.before")` 形状：`tool: "subagent"`、`input.agent`、`input.prompt`。
- [ ] `packages/testing/test/contract.test.ts`
  - 回放 v2 fixture；断言 event、blocks、mutations。
  - v1/v2 parity：同一任务状态下 `blocks[].text` 逐字一致（允许顺序差异时显式排序）。

### 0.4 Handshake 与身份

- [ ] `packages/cli/src/commands/context.ts`
  - 新增 `--adapter <id>`，写入 `request.platform.adapterId`。
  - handshake 使用 `request.platform.adapterId ?? adapterForRuntime(...).id`。
- [ ] `packages/core/src/state/platform/env-tables.ts`
  - 增加 `opencode / OPENCODE_SESSION_ID / real`，注明确认依据。
- [ ] `packages/cli/src/templates/workflow/scripts/common/active_task.py`
  - `_ENV_SESSION_KEYS` 增加 opencode 条目，保持与 TS 表一致。
- [ ] 回归测试：现有 `packages/cli/test/regression.test.ts` 中
  “OPENCODE_RUN_ID 被忽略”的用例需要补充 `OPENCODE_SESSION_ID` 现在生效的分支。

### 0.5 子会话绑定 API

- [ ] 新增 `packages/core/src/state/session/bind.ts`
  - `bindSession({ root, platform, parentKey, childKey })`，幂等，返回 task。
  - 复用 `SessionStore.read/update`，不手写 JSON。
- [ ] `packages/core/src/state/index.ts` / `packages/core/src/index.ts` 导出。
- [ ] `packages/cli/src/cli/index.ts` 增加 `session bind` 子命令。
- [ ] 单元测试：父会话有任务/无任务、子会话已存在、重复调用。

### Wave 0 验证

```bash
pnpm --filter @phronia/core build
pnpm --filter @phronia/core typecheck
pnpm --filter @phronia/core test
pnpm --filter @phronia/cli typecheck
pnpm test:contract
pnpm test:parity
```

**Gate G0**：contract/parity 全绿；v1 fixture 不变；无用户文件写入逻辑变更。

**Rollback point**：Wave 0 全部是 core/CLI 内部改动，可整体 revert 而不影响用户项目。

---

## Wave 1 — v2 shim 与构建

### 1.1 模板目录拆分

- [ ] 移动 `packages/cli/src/templates/opencode/{agents,plugins,lib,package.json}`：
  - `agents/` → `base/agents/`
  - 现有 `plugins/` + `lib/` + `package.json` → `adapters/v1/`
- [ ] 新增 `adapters/v2/plugin.ts`（源）+ 构建产物 `_generated/shims/v2/phronia.js`。
- [ ] `packages/cli/src/configurators/opencode.ts`
  - 新增 `openCodeShard(adapterId)`，`base/` 与 shard 合并。
  - `collectOpenCodeTemplates(adapterId = "opencode@v1")`。
  - `ownedPaths(adapterId)` 返回 shard 独占路径。
- [ ] 本 wave 先不接 init/update，默认仍传 `opencode@v1`，保证行为不变。

### 1.2 shim 源文件

`adapters/v2/plugin.ts` 结构：

```ts
import type { Plugin } from "@opencode/plugin";
import { runContext } from "./lib/phronia-client.js"; // 构建时内联

export default {
  id: "phronia.opencode.v2",
  async setup(ctx) {
    const cache = createTurnCache();
    const regs = [
      await ctx.session.hook("context", (event) => onContext(ctx, event, cache)),
      await ctx.tool.hook("execute.before", (event) => onToolBefore(ctx, event)),
      await ctx.tool.hook("execute.after", (event) => onToolAfter(ctx, event)),
    ];
    return () => Promise.all(regs.map((r) => r.dispose())).then(() => undefined);
  },
} satisfies Plugin;
```

实现要点：

- [ ] `onContext`：
  - 计算 `lastUserMessageIdentity`（`id` 缺失时用内容 hash）与 compaction 代数。
  - 本进程本会话未注入、或 compaction 代数变化 → `session-start`。
  - 否则 → `user-prompt`。
  - session-start blocks 追加到 `event.system`。
  - workflow-state block 追加为 `role: "system"` 的 message。
- [ ] `onToolBefore`：
  - `event.tool !== "subagent"` 直接返回。
  - `normalizeAgent(event.input.agent)` 命中 `phronia-*` → 调 `subagent-spawn`。
  - 就地改 `event.input.prompt = mutation.value`；失败只记 debug。
- [ ] `onToolAfter`：
  - `event.tool === "subagent"` 且 `result.status === "completed"` 且
    `result.metadata.sessionID` 存在 → 调 `session bind`。
- [ ] 缓存：`Map<sessionID, Map<key, Response>>`，上限 8 key/会话；
  `Map<key, Promise>` single-flight；`PHRONIA_HOOKS=0` 短路。
- [ ] 超时：CLI 调用 8s；`AbortSignal.timeout` 或 `execFile` timeout。
- [ ] 异步：用 `execFile`（promisify），不使用 `spawnSync`。
- [ ] 日志：沿用 `lib/debug.js`，只在 `PHRONIA_DEBUG`/`DEBUG` 下写。

### 1.3 构建

- [ ] `scripts/build-shims.mjs` 改为 shard 表：

  ```js
  const SHARDS = [
    { adapterId: "opencode@v1", out: "_generated/shims/v1",
      entries: ["session-start.js", "inject-workflow-state.js", "inject-subagent-context.js"] },
    { adapterId: "opencode@v2", out: "_generated/shims/v2",
      entries: ["phronia.js"] },
  ];
  ```

  - manifest 记录每个 artifact 的 `adapterId` / `out` / `sha256`。
  - 文件头仍写 `phronia-shim: <adapterId>`。
- [ ] `packages/cli/scripts/copy-templates.js` 排除 `.ts`，确保 v2 源文件不被复制。
- [ ] `pnpm build:shims` / `pnpm check:shims` 通过。

### 1.4 shim 单元测试

- [ ] 新增 `packages/cli/test/opencode-v2-shim.test.ts`
  - 构造假 `ctx`：`session.hook` / `tool.hook` 收集回调。
  - 断言：首次 context 注入 session-start 到 system；第二次同 user message 命中缓存；
    新 user message 注入 workflow-state 到 messages；subagent hook 改写 prompt；
    非 phronia agent 不改写；CLI 失败时 hook 不抛。
- [ ] 不依赖真实 `opencode` 二进制。

### Wave 1 验证

```bash
pnpm build:shims
pnpm check:shims
pnpm --filter @phronia/cli typecheck
pnpm --filter @phronia/cli test
```

**Gate G1**：v1 产物字节不变；v2 产物可被 `node --check` 解析；
shim 单测覆盖四条主路径。

**Rollback point**：删除 v2 shard 与构建项，v1 路径完全不受影响。

---

## Wave 2 — 生命周期接入

### 2.1 Adapter 解析

- [ ] 新增 `packages/cli/src/platform/selection.ts`

  ```ts
  export function resolveAdapter(cwd, platform, opts): {
    adapterId: string; status: AdapterStatus; harnessVersion: string | null;
    reason: string; source: "pin" | "probe" | "recorded" | "fallback";
  }
  ```

  - pin 来自 `readConfig(cwd).adapterPins`。
  - 探测用 `probeHarnessVersion`。
  - 记录 `unsupported` 时返回现状 adapter，由调用方决定是否写文件。
- [ ] `packages/cli/src/commands/adapter-manifest.ts`
  - `refreshAdapterManifest` 读取 pin 并传给 `selectAdapter`。
- [ ] 单元测试：pin 优先、2.x→v2、1.x→v1、未知→degraded、unsupported→保持现状。

### 2.2 init / update 接入

- [ ] `packages/cli/src/configurators/index.ts`
  - `PlatformFunctions.collectTemplates?: (options?: { adapterId?: string }) => Map`
  - `configure(cwd, options)` 传 `adapterId`。
  - `collectPlatformTemplates(platformId, options?)`。
- [ ] `packages/cli/src/commands/init.ts`
  - 写 opencode 模板前调用 `resolveAdapter`。
  - `configurePlatform("opencode", cwd, { adapterId })`。
  - `unsupported` 时打印可执行提示（升级 Phronia / 加 pin / 保持现状）。
- [ ] `packages/cli/src/commands/update.ts`
  - `collectTemplateFiles` 里为每个 configured platform 解析 adapter。
  - 新增 `reconcileAdapterFiles(cwd, platform, previousHashes, desired, adapterId)`：
    只删除旧 shard 独占 + hash 匹配 + 不在期望集合中的文件；其余保留并 warn。
  - 对账在写入新模板之前执行。
- [ ] `packages/cli/src/configurators/adapter-files.ts`（新）
  - 通用 shard 对账函数，平台只需提供 `ownedPaths(adapterId)`。
- [ ] 幂等测试：
  - v1 安装 → 模拟 2.x probe → update → 断言 v1 三文件删除、v2 文件存在。
  - v2 → pin v1 → update → 断言反向。
  - 两次切换后 hash 集合与直接安装一致。
  - 用户改过的 v1 文件不删。

### 2.3 doctor

- [ ] `packages/cli/src/commands/doctor.ts`
  - 使用真实 adapterId 判断 handshake。
  - v2 且 handshake 缺失 → 增加一条 warn 诊断。
  - 输出 `harness → adapter → status → handshake` 一行摘要。
- [ ] doctor 快照测试更新。

### 2.4 边界保护

- [ ] 删除 `.opencode/package.json` 前确认：
  - 路径在旧 shard `ownedPaths` 中；
  - 磁盘 hash 等于 `.template-hashes.json` 记录；
  - 否则保留并提示。
- [ ] 所有新增写入走 `writeFileAtomic` / 现有 `writeTemplateMap`，遵守
  `.phronia/spec/cli/backend/filesystem-safety.md`。

### Wave 2 验证

```bash
pnpm --filter @phronia/cli typecheck
pnpm --filter @phronia/cli test
pnpm test:idempotence
pnpm test
```

**Gate G2**：init/update/doctor 三条路径都有测试；
`v1→v2→v1` 幂等；用户修改文件不被删除。

**Rollback point**：`resolveAdapter` 可强制返回当前已安装 shard；
必要时用 pin 把行为固定回 v1。

---

## Wave 3 — 文档

> mem v2 读取与 Run/Attempt 编排层不在本任务范围，拆为独立后续任务。

### 3.1 文档

- [ ] `docs-site/advanced/multi-platform.mdx` 与 beta 版本：
  - OpenCode v1 / v2 两节；
  - 升级步骤：升级 OpenCode → `phronia update` → `phronia doctor`；
  - 回退：`config.yaml` 加 `platforms.opencode.adapter: opencode@v1` → `phronia update`；
  - 说明 v1 插件在 v2 下会加载失败，不是 Phronia 配置损坏。
- [ ] `docs-site/changelog/<next>.mdx`。

### Wave 3 验证

```bash
pnpm --filter @phronia/core test
pnpm --filter @phronia/cli test
pnpm verify
git diff --check
```

**Gate G3**：`pnpm verify` 全绿；文档命令可复制执行。

---

## 2. 全量验证命令

```bash
pnpm verify          # layout + typecheck + layout-json + shims + lint + build + test
pnpm test:contract
pnpm test:parity
pnpm test:idempotence
pnpm build:shims && pnpm check:shims
node scripts/check-layout-literals.mjs
```

手工验收（需本机 OpenCode 2.x）：

```bash
# 临时项目
mkdir -p /tmp/phronia-v2-e2e && cd /tmp/phronia-v2-e2e
phronia init --opencode -u tester -y
phronia doctor
opencode run "hi"            # 观察是否注入 <session-context>/<current-state>
python3 ./.phronia/scripts/task.py current --source
```

## 3. 提交拆分建议

1. `feat(core): add opencode v2 adapter and adapter-scoped capabilities`
2. `feat(cli): add opencode v2 shim shard and build pipeline`
3. `feat(cli): select opencode adapter at init/update and reconcile shards`
4. `docs: opencode v2 upgrade, rollback, and pin`

每个提交都必须独立通过 `pnpm typecheck` + 对应 package test。

## 4. 风险检查点

- Wave 0 结束：确认 v1 fixture 未变；parity 通过。
- Wave 1 结束：确认 v1 shim 产物 sha256 不变。
- Wave 2 结束：确认 `pnpm test:idempotence` 与用户修改文件保护用例通过。
- 发布前：确认 `doctor` 在 1.x 与 2.x 各跑一次；确认 pin 两个方向都能切换。
