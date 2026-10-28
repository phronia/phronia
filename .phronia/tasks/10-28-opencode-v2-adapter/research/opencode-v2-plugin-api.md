# OpenCode v2 插件 API 调研

调研对象：`anomalyco/opencode`，浅克隆 commit `86ce19d96eccbfb95af3ff3189c7071575f94339`（2026-10-27），
本地路径 `/tmp/opencode-v2-src`。本机 CLI 版本 `opencode v2.0.32`。

## 1. 插件入口与加载

- 包名：`@opencode/plugin`，仓库内版本 `2.2.0`（`packages/plugin/package.json`）。
- 插件定义（`packages/plugin/src/promise/plugin.ts:62`）：

  ```ts
  export interface Plugin {
    readonly id: string
    readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
  }
  export function define(plugin: Plugin) { return plugin }
  ```

  `define` 是恒等函数。运行时只校验默认导出形状 `{ id, setup }` 或 `{ id, effect }`
  （`packages/core/src/plugin/module.ts` 的 `Module` schema 与 `loadServer`）。
  因此**本地插件可以不 import `@opencode/plugin`**，直接 `export default { id, async setup(ctx) {} }`，
  不产生任何运行时依赖。

- 本地发现目录：`.opencode/plugin/` 与 `.opencode/plugins/` 都扫描
  （`packages/core/src/plugin/source-directory.ts`）。条目可以是单文件 `.ts`/`.js`，
  也可以是目录；目录按 `package.json` 的 `name` + `exports`（`server`/`tui`/`rpc`/`gui-experimental`），
  没有 `exports` 时按根文件名 `server`（否则 `index`）解析（`packages/plugin/src/host.ts:resolve`）。
- 本地插件目录**不会被自动安装依赖**。`Npm.add` 只用于 `opencode.json(c)` 里声明的非本地包
  （`packages/core/src/plugin/module.ts`）。这进一步支持“零依赖单文件 shim”的选择。
- 加载失败语义：默认导出形状不符会抛
  `Plugin must export a default definition with an id and an effect or setup function`
  （v1 插件在 v2 下的典型报错，见 GitHub issue #39345）。

## 2. 可用 hook（Promise API）

来自 `packages/plugin/src/promise/*.ts` 与官方文档 `https://opencode.ai/v2/docs/build/plugins/server/`：

### session hooks

| Hook | 触发时机 | 可变字段 |
|---|---|---|
| `session.hook("prompt")` | 用户消息 admission，**每个 prompt 一次**，不随每次模型调用重复 | `prompt.text/files/agents/skills`、`metadata`、`delivery` |
| `session.hook("context")` | 主 agent loop 的**每次模型请求**，包括工具调用后的续跑 | `system: SystemPart[]`、`messages: Message[]`、`tools`、`options` |
| `session.hook("compaction")` | 压缩摘要请求 | 同上，另可设 `result` 跳过模型调用 |
| `session.hook("generate")` / `("title")` | 辅助请求 | 同上 |

`context` 的修改**只影响本次外发请求，不写入历史**——这正是 v1 需要
`experimental.chat.messages.transform` + 伪造 part 才能达到的效果。

`SystemPart` = `{ type: "text", text: string, cache?: CacheHint, metadata?: ... }`
（`packages/ai/src/schema/messages.ts:23`）。`Message` 是 Effect Schema.Class，
`role` 为 `system | user | assistant | tool`，`content` 是 part 数组
（`packages/ai/src/schema/messages.ts:240`）。普通对象在 hook 里直接 push 即可被下游读取。

### tool hooks

`packages/plugin/src/promise/tool.ts`：

```ts
tool.hook("execute.before", (event) => {
  // event: { tool, sessionID, agent, messageID, id, input }
  // input 是可变的 unknown；就地改字段或整体替换 event.input 都会生效
})
tool.hook("execute.after", (event) => {
  // completed: { result, ... } | error: { error, ... }
})
```

`packages/core/src/tool.ts:305` 会把 hook 返回的 `event.input` 传给真正的 execute，
所以 `execute.before` 里改 `input.prompt` 对 `subagent` 工具有效。

### shell hooks

`packages/plugin/src/promise/shell.ts`：

```ts
shell.hook("create.before", (event) => {
  // { command, cwd, timeout, shell, env }
  event.env.PHRONIA_CONTEXT_ID = "..."
})
```

注意：**该事件没有 sessionID**。不能据此可靠地把 shell 命令绑定到某个会话。

## 3. v2 的会话身份

- shell 工具在子进程 env 里注入 `OPENCODE_SESSION_ID = context.sessionID`
  （`packages/core/src/tool/plugin/shell.ts:216`）。这是 v2 相对 v1 的关键改善：
  Python 脚本可以直接从环境变量拿到真实会话 ID，不再需要“命令前缀 export”这种 hack。
- `Session.Info` 含 `parentID`（`packages/schema/src/session.ts:34`），
  子代理会话可沿 `parentID` 链回溯根会话；插件侧可 `ctx.session.get({ sessionID })` 读取。
- `subagent` 工具的 `execute.after` 结果 metadata 含子会话 `sessionID`
  （`packages/core/src/tool/plugin/subagent.ts:262`），可用于建立父子会话映射。

## 4. v2 工具重命名与参数变化

`packages/core/src/database/v1-migration.bun.ts:996`：

```ts
const RENAMED_TOOLS = { bash: "shell", task: "subagent", apply_patch: "patch" }
```

- `read` / `edit` / `write` 的参数从 `filePath` 改为 `path`。
- `skill` 工具参数从 `name` 改为 `id`。
- `subagent` 工具参数：`agent`（原 `subagent_type`）、`prompt`、`description`、
  `sessionID`（原 `task_id`）、`model`、`background`。
- `todowrite` 不再是默认工具。

v2 工具名清单（`packages/core/src/tool/plugin/*.ts`）：
`read` `write` `edit` `patch` `glob` `grep` `shell` `subagent` `todo` `skill`
`webfetch` `websearch` `question`。

## 5. 文件式定义兼容性

官方迁移文档明确：`agent definitions`、`command definitions`、`skills` 等
`.opencode/` 下的文件式配置继续可用，只有插件实现需要移植。

- Agent：`{agent,agents}/**/*.md`（`packages/core/src/config/plugin/agent.ts:19`）。
  v1 的 `permission:`（单数 map）会经 `ConfigMigrateV1.migrateAgent` 迁移为 v2 的
  `permissions` 规则集，并做 `bash→shell`、`task→subagent`、`write/patch→edit` 的动作名映射
  （`packages/core/src/v1/config/migrate.ts:26-45`）。现有 Phronia agent 文件无需改动。
- Command：`{command,commands}/**/*.md`（`packages/core/src/config/plugin/command.ts:138`），
  继续支持 `$ARGUMENTS` / `$1` 模板与 shell 插值。
- Skill：`<config-root>/skills` 下的 `SKILL.md`（`packages/core/src/config/plugin/skill.ts:90`），
  frontmatter 支持 `name` / `description` / `metadata` / `disable-model-invocation`。

## 6. 存储

- 数据库仍是 `<XDG_DATA>/opencode/opencode.db`（`packages/cli/src/database-path.ts`），
  但 schema 改为 `session_v2` / `session_message`（`packages/core/src/database/schema.gen.ts`），
  不再有 v1 的 `session` / `message` / `part` 三表（旧表在迁移后保留，但新会话只写新表）。
- `session_message` 行：`id / session_id / type / seq / time_created / time_updated / data(JSON)`，
  `type` 包括 `user` `assistant` `compaction` `system` `synthetic` `skill` `shell` `idle` 等
  （`packages/schema/src/session-message.ts`）。

## 7. 未被上游支持的缺口

- 没有 `session.start` hook。社区 PR #15224 仍处于 open 状态（2026-04 更新），
  因此“会话开始注入”只能落在 `context` hook 上，用“是否已有 assistant 消息 / 是否出现 compaction 边界”判断。
- v2 的 `context` hook 每个模型请求都会跑；直接每次 spawn CLI 会在一个工具循环里放大成多次进程启动。
  必须在 shim 侧做按 prompt/会话的缓存。
