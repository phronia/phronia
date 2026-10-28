# OpenCode v2 适配 — 技术设计

## 1. 设计目标与原则

1. **Platform 是产品，Adapter 是代际。** 已有 registry 注释已经确立这个划分，
   本设计把它从“注册表里有两条记录”推进到“整条链路都按 adapter 解析”。
2. **Core 拥有语义，shim 拥有传输。** shim 只做三件事：把宿主事件翻译成 `hints`、
   调用 `phronia context`、把返回的 plan 应用回宿主事件。任何任务解析、spec 选择、
   prompt 拼装都不进入 shim。
3. **用户项目零运行时依赖。** v2 本地插件不会自动安装依赖，shim 必须是单文件、
   只 import `node:*`。`@opencode/plugin` 只作为 Phronia 仓库的开发期类型依赖。
4. **不确定性显式化。** 版本探测失败 → degraded；adapter 未实现 → unsupported；
   shim 未加载 → handshake 缺失。绝不静默复用上一代实现。
5. **文件是接口。** agents、commands、skills 是用户可编辑的长期资产，只保留一份；
   adapter 只替换“插件 + 包清单”这一层。

## 2. 目标分层

```
┌─────────────────────────────────────────────────────────────┐
│ OpenCode v2 host                                            │
│  session.hook("context")   tool.hook("execute.before")      │
└───────────────▲──────────────────────────▲──────────────────┘
                │ apply plan               │ mutate input.prompt
┌───────────────┴──────────────────────────┴──────────────────┐
│ shim: .opencode/plugins/phronia.js  (generated, zero deps)  │
│  - event → ContextRequest(hints)                            │
│  - cadence/cache/single-flight                              │
│  - plan → system / messages / prompt mutation               │
└───────────────────────────┬─────────────────────────────────┘
                            │ spawn `phronia context --json`
┌───────────────────────────▼─────────────────────────────────┐
│ @phronia/core                                               │
│  platform/registry.ts      adapter 选择与能力矩阵            │
│  context/*                 session-start / user-prompt /    │
│                            subagent-spawn / pre-edit        │
│  state/*                   session identity / task / spec   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ CLI lifecycle                                               │
│  adapter resolve → template compose → write/reconcile →     │
│  manifest/handshake → doctor                                │
└─────────────────────────────────────────────────────────────┘
```

## 3. 核心决策

### D1 按 adapter 分 shard，而不是单文件双形状

社区案例证明可以写 `export default { ...Plugin.define(...), server }` 同时服务
1.18.29+ 与 2.x。但 Phronia 的 v1 插件依赖 `experimental.chat.messages.transform`
和伪造 part ID，v2 用 `session.hook("context")`；两套语义塞进一个文件会长期互相污染，
也无法在 `update` 时按代际做文件对账。**选择：`adapters/v1/` 与 `adapters/v2/` 两个 shard。**

### D2 v2 shim 零依赖、单文件、纯 JS

- 运行时只 `export default { id, setup }`；`Plugin.define` 只是恒等函数，不需要 import。
- 开发期用 `.ts` 源文件 + `import type { Plugin } from "@opencode/plugin"` 获得类型检查，
  esbuild 构建时类型被擦除，产物仍是零依赖 JS。
- 不生成 `.opencode/package.json`（v1 的 `@opencode-ai/plugin` 依赖随 v1 shard 一起下线）。
  若用户的 `.opencode/package.json` 是 Phronia 写入且未被修改，切到 v2 时删除；
  否则保留并提示。

### D3 shim 只调用 CLI，不把 core 打进产物（第一期）

- 保持 core 单一实现、shim 纯传输的边界。
- 代价是每个“计算点”一次 CLI 启动（约 100ms 量级）。
- 通过 cadence 把计算点压到每轮 1 次 user-prompt、每会话 1 次 session-start、
  每次 dispatch 1 次 subagent，而不是每个模型请求 1 次。
- 预留优化位：若实测 CLI 启动成为瓶颈，可在 `build-shims` 里把
  `handleContext` 打进 shim（core 无动态 import，可行），但这需要调整构建顺序
  （先 build core 再 build:shims），作为独立 wave，不在第一期混入。

### D4 注入位置：system 用于会话级，messages 用于每轮

- **session-start** → `event.system.push(...)`。会话内只注入一次，system 前缀稳定，利于缓存。
- **workflow-state** → `event.messages` 末尾追加一条 `role: "system"` 消息。
  不扰动 system 前缀，只影响本轮请求。
- **subagent context** → `tool.execute.before` 就地改写 `event.input.prompt`。
  与 v1 的“prompt mutation”语义一致，core 侧 `mutations[0].op === "set-prompt"` 直接复用。

### D5 会话身份用 `OPENCODE_SESSION_ID`，删除命令前缀

v2 的 shell 工具已在子进程 env 注入真实会话 ID。方案：

- core 与 Python 的 session env 表都新增 `opencode / OPENCODE_SESSION_ID`，provenance
  标记为 `real` 并注明确认依据（源码 `tool/plugin/shell.ts`）。
- v2 shim 不再改写 shell 命令，不需要 Windows/PowerShell 引号逻辑。
- 子会话：shim 在 subagent 的 `execute.after` 里拿到 `result.metadata.sessionID`，
  调用新的 `phronia session bind --platform opencode --parent <id> --child <id>`，
  把父会话的 current task 克隆到子会话的 session 文件。Python 读同一份文件即可，
  无需跨语言查询数据库。

### D6 上下文计算按“最后一条 user message”缓存

`context` hook 在一次用户消息内会随工具循环触发多次。缓存键：

```
sessionID + "\0" + lastUserMessageIdentity + "\0" + eventKind
```

`Message.id` 在 v2 schema 里是 optional，缺失时用最后一条 user message 内容的
SHA-256 前缀代替。

session-start 不在“无 assistant 消息”时注入，而是**每个插件进程、每个会话注入一次**，
这样进程重启/会话恢复后模型仍能重新获得方向感；同时记录 messages 里的 compaction
数量，数量变化时清掉该会话的缓存，压缩后重新注入一次。续跑的模型请求命中缓存，
不会重复开销。

### D7 选择优先级：pin > detected > recorded > fallback

`selectAdapter` 只负责“给定版本和 pin 选 adapter”。真正的安装期选择由 CLI 的
`resolveAdapter` 完成，优先级固定：

```
config pin
  > probe 成功且 semver 命中某个 adapter
  > manifest.platforms.<id>.adapterId   （仅在 probe 不可用/未知时）
  > fallback（opencode 为 v1）
```

注意 recorded 不能覆盖成功的 probe：探测到 2.x 时必须选 v2，否则升级后仍写 v1 shard。
recorded 的作用是“这台机器没装这个 harness 时，不要改动上次安装的事实”。
这条规则同时解决：本机没装某个 harness 时 `update` 不会降级它的 shard；
同一仓库在不同机器间同步时，probe 结果不会互相覆盖。

### D8 身份解析先认宿主，再查 env

`OPENCODE_SESSION_ID` 是 v2 在 shell 子进程里设置的，但当 ZCode 从 OpenCode 的 shell
启动（或反向）时，子进程会继承父 harness 的身份变量。现有全表顺序查找会把工作记到
错误的会话上。规则：

- 先看宿主标记：`OPENCODE=1`、`ZCODE_PROJECT_DIR`、`CLAUDE_CODE_ENTRYPOINT`、
  `CODEX_THREAD_ID` 等，确定唯一宿主。
- 宿主确定后，只查该宿主的 env 条目；不再回退到其他平台的条目。
- 宿主无法确定时，才走现有全表顺序，并保留 shell ticket。
- TS 与 Python 两份实现必须同时改，并加跨 harness 继承的回归测试。

## 4. Core 变更

### 4.1 Adapter 注册

`packages/core/src/platform/registry.ts`

```ts
const OPENCODE_V2_EVENTS = {
  "session-start": "opencode-v2-session-context",
  "user-prompt": "opencode-v2-session-context",
  "subagent-spawn": "opencode-v2-tool-before",
  "pre-tool-use": "opencode-v2-tool-before",
} as const;

adapter("opencode", {
  major: 2,
  harnessRange: ">=2.0.0 <3.0.0",
  envelopes: OPENCODE_V2_EVENTS,
  // 不再 unsupported；运行时以 handshake 证明
})
```

- `detect()` 保持 `unknown`（版本探测由 CLI probe 提供；运行时只有 handshake 是证据）。
- `runtimeAdapter(platform)` 的调用点必须改为“优先用请求里的 adapterId”。
  新增 `adapterForRuntime(platform, adapterId)`，缺失时回退 `adaptersFor()[0]` 并记诊断。

### 4.2 能力矩阵按 adapter 解析

`packages/core/src/platform/capabilities.ts` 当前以 `PlatformId` 为键。改为：

```ts
interface CapabilityProfile {
  behavior: { sessionStart, workflowState, subagentContext, shellIdentity, agentDefinitions };
  toolNames: { shell: string; subagent: string; edit: string[] };
  ...
}

const PLATFORM_PROFILES: Record<PlatformId, CapabilityProfile>
const ADAPTER_OVERRIDES: Record<string, Partial<CapabilityProfile>> = {
  "opencode@v2": {
    behavior: {
      sessionStart: plugin("session.hook context"),
      workflowState: plugin("session.hook context (per-prompt cache)"),
      subagentContext: plugin("tool.hook execute.before (subagent)"),
      shellIdentity: envVar("OPENCODE_SESSION_ID"),
      agentDefinitions: native(".opencode/agents"),
    },
    toolNames: { shell: "shell", subagent: "subagent", edit: ["edit", "write", "patch"] },
  },
};

export function capabilitiesFor(platform: PlatformId, adapterId?: string | null) {
  return { ...PLATFORM_PROFILES[platform], ...ADAPTER_OVERRIDES[adapterId ?? ""] };
}
```

保留旧的 `CAPABILITIES[platform]` 作为默认 profile，避免改动所有消费方。

### 4.3 工具名归一化

`packages/core/src/context/index.ts`

- `EDIT_TOOLS` 增加 `patch`。
- `pre-tool-use` 分派从“平台硬编码”改为读 `request.hints.toolName`，再用
  `capabilitiesFor(platform, adapterId).toolNames` 比较：
  - `shell` → `buildPreShell`
  - `subagent` / `task` / `agent` → `buildSubagentSpawn`
  - `edit` / `write` / `patch` → `buildPreEdit`
- `readToolName` 已经支持 `tool_name` / `toolName` 等键；v2 shim 直接填 `hints.toolName`。

### 4.4 Context 请求扩展（向后兼容）

`packages/core/src/context/types.ts` 的 `hints` 增加：

```ts
/** Host session that owns this turn (root session for child-agent work). */
sessionId?: string;
/** Parent session id, when the host exposes a child-agent session. */
parentSessionId?: string;
/** Adapter id observed by the shim, e.g. opencode@v2. */
adapterId?: string;
```

`platform` 已含 `adapterId`，`hints.adapterId` 只用于 shim 无法填 `platform` 的老调用路径；
优先使用 `platform.adapterId`。

### 4.5 Handshake 使用真实 adapterId

`packages/cli/src/commands/context.ts`：

```ts
const adapterId =
  request.platform.adapterId ?? runtimeAdapter(platform).id;
writeHandshake(root, platform, request.event, adapterId, input);
```

CLI 增加 `--adapter <id>`，shim 调用时传入。`doctor` 的 schema-drift 判断随之正确。

### 4.6 Session identity

`packages/core/src/state/platform/env-tables.ts` 与
`packages/cli/src/templates/workflow/scripts/common/active_task.py`：

```ts
{ platform: "opencode", keys: ["OPENCODE_SESSION_ID"], provenance: "real",
  note: "OpenCode 2.x shell tool injects it into child env" }
```

保留 `PHRONIA_CONTEXT_ID` 作为最高优先级 override（测试、桥接、父会话绑定）。
v1 现有的命令前缀路径继续工作，不做删除。

### 4.7 子会话绑定

新增 core API：

```ts
// packages/core/src/state/session/bind.ts
export function bindSession(options: {
  root: string; platform: string; parentKey: string; childKey: string;
}): { written: boolean; task: string | null };
```

- 读取父会话文件，克隆 `current_task` / `worktree` / `repo_root`，
  写入 `<worktree>/<childKey>.json`，`keySource: "parent-bind"`。
- 幂等：子会话已有 `current_task` 时不覆盖。
- CLI：`phronia session bind --platform opencode --parent <id> --child <id>`。
- v2 shim 在 subagent `execute.after` 中调用；失败只记 debug，不影响宿主。

### 4.8 mem 读取

`packages/core/src/mem/adapters/opencode.ts`：

1. 打开 DB 后先探测表名：
   - `session_v2` + `session_message` → v2 读取器；
   - `session` + `message` + `part` → 现有 v1 读取器。
2. v2 读取映射：
   - `session_v2.id/title/directory/parent_id/time_created/time_updated`；
   - `session_message.type/user/assistant` 的 `data.text` 或 `data.content`；
   - `data.type === "compaction"` 作为压缩边界；
   - `data.type === "synthetic"` 默认过滤（与 v1 的 synthetic part 过滤一致）。
3. 保留现有零依赖 SQLite parser；不引入 native 依赖。
4. 两种读取器共享 `DialogueTurn` 输出，`mem` 上层无感知。

## 5. v2 shim 设计

### 5.1 形状

```js
// .opencode/plugins/phronia.js（构建产物）
export default {
  id: "phronia.opencode.v2",
  async setup(ctx) {
    registerContextHook(ctx);
    registerToolHook(ctx);
  },
};
```

- `id` 固定，用于插件存储与诊断；不要随版本变化。
- `setup` 内的注册全部 `await`，并在返回的 cleanup 里 `dispose()`。
- 任何注册失败都只记日志，不让 `setup` reject（否则整个插件被禁用）。

### 5.2 Hook 映射

| 需求 | v1 实现 | v2 实现 |
|---|---|---|
| session-start | `experimental.chat.messages.transform` + 伪造 part | `session.hook("context")`，条件注入 `event.system` |
| workflow-state | 同上，每请求重算 | `session.hook("context")`，按 last user message 缓存 |
| subagent context | `tool.execute.before` 匹配 `task`，改 `args.prompt` | `tool.hook("execute.before")` 匹配 `subagent`，改 `event.input.prompt` |
| shell identity | 命令前缀 `export PHRONIA_CONTEXT_ID=...` | 宿主自带 `OPENCODE_SESSION_ID`；删除前缀逻辑 |
| subagent 子会话绑定 | 无 | `tool.hook("execute.after")` + `phronia session bind` |

### 5.3 事件 → ContextRequest

```js
function contextRequest(ctx, event, kind) {
  return {
    schemaVersion: 1,
    event: kind,
    platform: { id: "opencode", adapterId: "opencode@v2" },
    projectRoot: ctx.location.directory,
    input: {},
    hints: {
      sessionId: event.sessionID,
      agentType: event.agent,
      toolName: event.tool,
      prompt: lastUserText(event.messages),
      hasAssistantMessages: hasAssistant(event.messages),
    },
  };
}
```

- `input` 保持 `{}`；所有语义走 `hints`，避免 shim 复制宿主 payload 形状。
- subagent 事件额外填 `agentType: normalizeAgent(event.input.agent)`、`prompt`、`taskRef`。

### 5.4 Cadence 与缓存

```
context hook:
  key = sessionID + lastUserMessageIdentity
  generation = count of compaction parts in messages
  if (!sessionStartCache.has(sessionID + "#" + generation)):
      → compute session-start; cache   // once per session per process
  if (!breadcrumbCache.has(key)):
      → compute user-prompt; cache
  apply cached blocks
```

- `Map` 上限：每会话最多 8 个 key，按插入序淘汰；进程结束即释放。
- single-flight：`Map<key, Promise<Response>>`，并发模型请求共享一次 CLI 调用。
- CLI 超时 8s，超时返回空 plan 并记 debug。
- `PHRONIA_HOOKS=0` / `PHRONIA_DISABLE_HOOKS=1` / `OPENCODE_NON_INTERACTIVE=1`
  保留现有短路语义。

### 5.5 失败策略

- hook 回调内部 `try/catch`，只写 `TMPDIR/phronia-plugin-debug.log`（沿用 v1 的 debug 模块）。
- CLI 非零退出 → 空 plan，不抛。
- `session bind` 失败 → 不影响 dispatch。
- 不向 model 注入任何错误文本，避免污染上下文。

## 6. 模板组合

### 6.1 目录布局

```
packages/cli/src/templates/opencode/
  base/
    agents/phronia-{implement,check,research}.md
  adapters/
    v1/
      plugins/{session-start,inject-workflow-state,inject-subagent-context}.js
      lib/{debug,phronia-client,context-visibility,session-utils}.js
      package.json
    v2/
      plugin.ts                 # 源文件，构建后成为 plugins/phronia.js
  _generated/shims/
    v1/*.js
    v2/phronia.js
```

`commands/` 仍来自 `templates/common/commands`，skills 仍来自 bundled skills，
两者与代际无关。

### 6.2 组合函数

```ts
export interface AdapterTemplateShard {
  adapterId: string;
  /** 该 shard 写入的路径（相对项目根） */
  files(): Map<string, string>;
  /** 该 shard 独占、切换时需要下线的路径 */
  ownedPaths(): Set<string>;
}

export function openCodeShard(adapterId: string, ctx): AdapterTemplateShard;
export function collectOpenCodeTemplates(adapterId: string): Map<string, string> {
  return merge(baseTemplates(), commands(), skills(), openCodeShard(adapterId).files());
}
```

- `collectPlatformTemplates(platformId, options)` 增加 `adapterId` 参数。
- `configurePlatform(platformId, cwd, { adapterId })` 同步增加。
- 未传 adapterId 时由调用方先解析；configurator 内部不做 probe（保持纯函数、可测试）。

### 6.3 Hash 归属

不改 `.template-hashes.json` schema（v3 扁平 map）。切换时：

```
stale = ownedPaths(oldAdapter) - ownedPaths(newAdapter) - allOtherTemplatePaths
for path in stale:
  onDisk = read(path)
  if onDisk missing: removeHash
  else if hash(onDisk) == trackedHash: delete(path); removeHash
  else: keep; warn("modified, not removed")
```

- `allOtherTemplatePaths` 是本次期望模板的全集，防止误删被其他平台/其他 shard 复用的路径。
- 该对账是幂等的，可以每次 `update` 都跑。

## 7. 生命周期流程

### 7.1 init

```
1. resolve platform ids from flags/interactive
2. for each opencode: adapter = resolveAdapter(cwd, "opencode", { probe: true, pin })
3. configurePlatform("opencode", cwd, { adapterId: adapter.id })
4. refreshAdapterManifest(cwd, { pins })
5. if adapter.status !== "ok": print actionable hint
```

### 7.2 update

```
1. configured = getConfiguredPlatforms(cwd)
2. for each configured platform: adapter = resolveAdapter(...)
3. desired = collectPlatformTemplates(platform, { adapterId })
4. reconcileAdapterFiles(cwd, platform, previousHashes, desired, adapter)
5. normal template diff / modified-file prompt / write
6. refreshAdapterManifest(cwd, { pins })
```

`resolveAdapter` 放在 `packages/cli/src/platform/selection.ts`：

```ts
export function resolveAdapter(cwd, platform, opts): {
  adapterId: string; status: AdapterStatus; harnessVersion: string | null;
  reason: string; source: "pin" | "probe" | "recorded" | "fallback";
}
```

- 读 `readConfig(cwd).adapterPins[platform]`。
- `probeHarnessVersion(platform)`。
- `selectAdapter({ platform, detection, pin })`。
- 若 `status === "unsupported"` 且当前已安装 shard 存在，返回“保持现状 + unsupported”，
  由调用方打印提示，不写新文件。

### 7.3 doctor

- 显示 `adapterId / harnessVersion / status / reason / fallback`。
- handshake adapterId 与选中 adapter 不一致 → `schema-drift`。
- v2 下 handshake 缺失超过一个会话周期 → 提示“插件可能未加载”。

## 8. 测试策略

| 层 | 测试 |
|---|---|
| adapter 选择 | pin 优先、1.x→v1、2.x→v2、未知→degraded、unsupported 不静默回退 |
| 能力矩阵 | `capabilitiesFor("opencode", "opencode@v2")` 的 toolNames/behavior |
| context core | `patch` 走 pre-edit；`subagent` hints 归一化；v1/v2 parity |
| 模板组合 | base 只出现一次；v1/v2 shard 路径不重叠；命令/skill 不变 |
| 对账 | v1→v2 删除未修改文件；保留已修改文件；v1→v2→v1 幂等 |
| shim（单元） | 假 ctx 对象注册 hook；模拟 context 事件，断言注入位置与缓存命中 |
| handshake | `--adapter opencode@v2` 写入真实 adapterId |
| mem | 构造 v2 schema 的最小 SQLite fixture，断言可列出/提取 |
| 回归 | 现有 `packages/cli/test/regression.test.ts` 全量通过 |

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| v2 2.x 小版本继续改 hook 形状 | shim 入口做能力探测：`typeof ctx.session?.hook === "function"`；缺失时 no-op + doctor 提示 |
| `context` hook 每次模型调用都跑 | 按 last user message 缓存 + single-flight；必要时再走 inline bundle |
| 注入到 system 破坏 prompt cache | session-start 每会话一次；workflow-state 走 messages 尾部 |
| 用户修改过 v1 shim | 对账只删 hash 匹配文件；否则保留并提示 |
| 本地插件不会装依赖 | shim 零依赖；不生成 `.opencode/package.json` |
| 子会话任务解析 | `execute.after` 绑定父会话；失败时依赖 prompt 中的 `Active task:` |
| mem schema 变化 | 表名探测 + 双读取器；fixture 覆盖两种 schema |
| 构建顺序 | 若引入 inline bundle，`build:core` 必须先于 `build:shims`；第一期不引入 |

## 10. 实施波次

- **Wave 0（core）**：registry v2、能力矩阵按 adapter、tool 名归一化、handshake adapterId、
  env 表、contract fixtures、parity 测试。
- **Wave 1（shim）**：v2 插件源文件、构建 shard、cadence 缓存、失败降级、
  session bind 调用。
- **Wave 2（lifecycle）**：模板拆分、`resolveAdapter`、init/update 接入、
  shard 对账、pin、doctor 输出。
- **Wave 3（完整性）**：文档、changelog。

> 本次任务不包含 mem v2 读取与 Run/Attempt 编排层；两者作为独立后续任务。

每一波都能独立验证；Wave 0 不写用户文件，Wave 1 可在临时目录手工加载，
Wave 2 才改变 `init`/`update` 行为。

## 11. 明确不做

- 不把 v1 shim 改造成“双形状”单文件。
- 不删除 `PHRONIA_CONTEXT_ID` 通道（测试、桥接、v1 仍在用）。
- 不引入 `@opencode/plugin` 到用户项目。
- 不改 `phronia context` 的 schemaVersion。
- 不在第一期做 in-process core bundling。
