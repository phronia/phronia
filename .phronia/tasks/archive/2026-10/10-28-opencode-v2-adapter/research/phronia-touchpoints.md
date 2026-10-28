# Phronia 现有 OpenCode 集成触点清单

目标：找出“支持 v2”需要改动的全部位置，避免只换插件文件却漏掉 core/CLI/状态层。

## 1. Adapter 注册与选择

- `packages/core/src/platform/registry.ts:78-82`
  - `opencode@v1`：`>=1.0.0 <2.0.0`，`fallback: true`，envelopes 为 v1 三个 hook 名。
  - `opencode@v2`：`>=2.0.0 <3.0.0`，`unsupported: "opencode@v2 is not implemented"`。
- `packages/core/test/platform/adapter.test.ts:107` 固化“2.x → opencode@v2 → unsupported”。
- `selectAdapter` 已支持 `pin` 与 semver 选择，但目前只在 `doctor.ts` 和
  `adapter-manifest.ts` 使用；`init` / `update` 不参与选择。
- `refreshAdapterManifest`（`packages/cli/src/commands/adapter-manifest.ts`）不透传
  `config.yaml` 的 `platforms.<id>.adapter` pin；pin 只影响 doctor 之外没人用。
- `packages/core/src/platform/manifest.ts:writeHandshake` 记录 adapterId；
  `phronia context` 写入时用的是 `runtimeAdapter(platform).id`（`packages/cli/src/commands/context.ts:81`），
  而 `runtimeAdapter` 永远返回 `adaptersFor(platform)[0]`，也就是 **v1**。
  v2 shim 上报的 handshake 会被错误标记成 v1。

## 2. 能力矩阵

`packages/core/src/platform/capabilities.ts:101-112` 以 PlatformId 为键：

```ts
opencode: {
  behavior: {
    sessionStart: plugin("experimental.chat.messages.transform"),
    subagentContext: plugin("tool.execute.before"),
    workflowState: plugin("experimental.chat.messages.transform"),
    shellIdentity: toolPrefix("TRELLIS_CONTEXT_ID command prefix"),
    agentDefinitions: native(".opencode/agents"),
  },
  ...
  evidence: evidence("v1 plugin API; v2 shard pending"),
}
```

v2 的机制完全不同（`session.hook("context")`、`tool` 名 `subagent`、env `OPENCODE_SESSION_ID`），
能力矩阵必须变成“按 adapter 解析”，否则任何依赖矩阵的输出（doctor、onboard、docs）都会说谎。

## 3. 模板与构建

- `packages/cli/src/templates/opencode/`
  - `agents/phronia-{implement,check,research}.md`：文件式定义，v2 兼容，无需改。
  - `plugins/session-start.js`：v1 形状 `export default async ({directory}) => ({ "experimental.chat.messages.transform": ... })`。
  - `plugins/inject-workflow-state.js`：同上，注入 `<workflow-state>`。
  - `plugins/inject-subagent-context.js`：`tool.execute.before`，匹配 `bash` 与 `task`，
    改写 `args.command` 前缀（`export PHRONIA_CONTEXT_ID=...`）和 `args.prompt`。
  - `lib/context-visibility.js`：包含 **part id 序号运算**（`prt_` 十六进制 ordinal ± offset）
    来伪造 synthetic part；v2 的 `context` hook 不再需要。
  - `lib/session-utils.js`、`lib/phronia-client.js`、`lib/debug.js`。
  - `package.json`：`@opencode-ai/plugin: ^1.14.39`（v1 SDK）。
- `scripts/build-shims.mjs`
  - 硬编码 `ADAPTER = "opencode@v1"`、`OUT = templates/_generated/shims/opencode`、
    三个 entry。adapterId 写进文件头，供 `update` 分类。
- `packages/cli/src/configurators/opencode.ts`
  - `walkOpenCodeTemplateDir()` 无 adapter 参数，总是拼 v1 模板 + `_generated/shims/opencode`。
  - `collectOpenCodeTemplates()` 无 adapter 参数，`fromTemplates()` 直接注册。
- `packages/cli/src/configurators/index.ts`
  - `PlatformFunctions.collectTemplates?: () => Map`、`configure(cwd, options?)` 都没有 adapter 维度。
  - `collectPlatformTemplates(platformId)` 是 init/update 的唯一入口。
- `packages/cli/src/templates/extract.ts:getOpenCodeTemplatePath()` 只返回一个目录。
- `.phronia/.template-hashes.json` 是扁平 `path -> hash`，没有 adapter 归属字段；
  切换 adapter 时需要通过“旧 hash + 旧 shard 路径集合”判断哪些文件是 Phronia 写的、可以删。

## 4. init / update / doctor 生命周期

- `packages/cli/src/commands/init.ts:2085`：配置完成后才 `refreshAdapterManifest(cwd)`；
  配置阶段不 probe，因此 v2 用户仍然拿到 v1 模板。
- `packages/cli/src/commands/update.ts:822`：`collectPlatformTemplates(platformId)` 无 adapter；
  也没有“adapter 切换导致文件下线”的对账逻辑。历史 migration 是按 CLI 版本触发的，
  无法表达“harness 从 1.x 升到 2.x”这种运行期变化。
- `packages/cli/src/commands/doctor.ts:295-321`：会 probe 并报告 adapter，但
  handshake adapterId 与 `runtimeAdapter` 恒为 v1 的问题会让 v2 永远 schema-drift。
- `packages/cli/src/commands/adapter-manifest.ts`：不透传 pin。

## 5. Context 契约与工具名

- `packages/core/src/context/types.ts` 已有 `ContextEvent`、`hints.toolName/agentType/prompt/sessionId/taskRef/filePath`
  等字段，足够表达 v2；shim 应该填 `hints`，而不是伪造宿主 payload。
- `packages/core/src/context/index.ts` 的 `pre-tool-use` 已识别 `shell` 与 `subagent`；
  `EDIT_TOOLS` 缺少 v2 的 `patch`。
- `packages/core/src/context/pre-edit.ts:readFilePath` 已支持 `path` 键。
- `packages/core/src/context/subagent/index.ts:normalizeAgentType` 已识别 `phronia-*`。

## 6. 会话身份

- `packages/core/src/state/platform/env-tables.ts` 没有 opencode 条目。
- `packages/cli/src/templates/workflow/scripts/common/active_task.py` 的
  `_ENV_SESSION_KEYS` 同样没有 opencode。
- 现有 v1 方案：插件把 `PHRONIA_CONTEXT_ID` 前缀加到每条 bash 命令上。
  `packages/cli/test/regression.test.ts:3901` / `:4031` 记录了“v1 没有真实 env 身份”的结论。
- v2 源码 `packages/core/src/tool/plugin/shell.ts:216` 确认会设置 `OPENCODE_SESSION_ID`，
  可以推翻上述结论并删掉命令前缀路径（v2 shard 内）。

## 7. mem 读取

- `packages/core/src/mem/adapters/opencode.ts` 读取 `session` / `message` / `part` 三表。
- v2 schema 是 `session_v2` / `session_message`；旧表在迁移后仍保留，但新会话只写新表。
- 需要 schema 探测 + 双读取路径；不能破坏现有 v1 读取。

## 8. 测试与文档

- `packages/testing/fixtures/contract/opencode-v1-session-start/`：v1 contract 回放。
- 无 v2 fixture、无 adapter 切换的幂等性测试。
- `docs-site/advanced/multi-platform.mdx`、`docs-site/beta/advanced/multi-platform.mdx`
  仍只描述 `.opencode/` 一套文件。
