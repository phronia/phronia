# 社区与官方迁移资料

## 1. 官方迁移指南

- `https://opencode.ai/v2/docs/migrate-v1/`
  - V2 有三个明确的破坏性变更：插件 API、server API/client 契约、TUI 配置。
  - 原文：“V1 plugin implementations do not run in V2. Moving a file or renaming its config entry is not enough.”
  - `.opencode/` 下的 agent definitions、command definitions、skills 继续兼容。
  - 本地插件目录改为 `.opencode/plugins/`（`plugin/` 也兼容扫描）。

- `https://opencode.ai/v2/docs/build/plugins/migrate-v1`
  - V1：默认导出函数，返回 tool/hook 对象。
  - V2：`Plugin.define({ id, setup(ctx) })`，在 `setup` 里通过 `ctx.*.hook(...)` 注册。
  - 关键 hook 映射：

    | V1 | V2 |
    |---|---|
    | `experimental.chat.system.transform` | `ctx.session.hook("context")`，改 `event.system` |
    | `experimental.chat.messages.transform` | `ctx.session.hook("context")`，改 `event.messages` |
    | `chat.message` | `ctx.session.hook("prompt")` |
    | `experimental.session.compacting` | `ctx.session.hook("compaction")` |
    | `tool.execute.before/after` | `ctx.tool.hook("execute.before"/"execute.after")` |
    | `event` | `ctx.event.subscribe()` |
    | `dispose` | `setup` 返回 cleanup 函数 |
    | `shell.env` | `ctx.shell.hook("create.before")` |

## 2. 官方 v2 文档要点（server plugins）

- `context` hook “runs for the agent loop, including tool-driven continuations”：
  每个模型请求都会触发，包括一次用户消息里的多次工具循环。
- `prompt` hook “runs once during admission, not before every model call”。
- 多个插件可注册同一 hook，按插件顺序执行，后者能看到前者的修改。
- hook 抛错会导致被拦截的操作失败，因此插件必须自己吞掉可预期错误。

## 3. 真实移植案例

- `https://vinayakkulkarni.dev/articles/porting-a-plugin-to-opencode-2`
  - 首个失败就是默认导出形状不符：
    `Plugin must export a default definition with an id and an effect or setup function. (SchemaError(Expected object at ["default"]))`
  - 作者发现 **OpenCode 1.18.29+ 会读取同一默认导出上的 `server` 属性**，
    因此可以写一个同时服务两个宿主的对象：

    ```js
    export default { ...Plugin.define({ id: "geoql.mdr", setup }), server }
    ```

    这是“单文件双形状”的可行路径，但需要同时维护两套 hook 实现；
    Phronia 选择按 adapter 分 shard，而不是双形状，避免两套语义长期纠缠。
  - 该案例还把 skills 从“复制文件到用户目录”改成 `ctx.skill.transform` 由包内提供。
    对 Phronia 不适用：Phronia 的 skills 是用户可编辑的项目资产，应继续落地到 `.opencode/skills/`。

- GitHub issue `anomalyco/opencode#39345`
  - “plugins: all user plugins fail to load with SchemaError after V1→V2 upgrade”。
  - 维护者定性为 expected V2 behavior，指向迁移指南。说明这是普遍痛点，不是个别配置问题。

- GitHub PR `anomalyco/opencode#15224`
  - 提案新增 `session.start` hook，状态 open。
  - 结论：不能依赖官方 SessionStart；必须用 `context` hook + 首次请求判断。

## 4. 对 Phronia 的直接启示

1. **必须按 adapter 分 shard**：v1 文件留在 v2 目录里只会产生加载错误日志。
2. **不要给用户项目增加运行时依赖**：本地插件不会自动装依赖，v2 shim 应零依赖。
3. **不要在 `context` hook 里每次 spawn CLI**：一个工具循环会触发多次；
   用 `prompt` 边界或“最后一条 user message id”做缓存。
4. **会话身份改用 `OPENCODE_SESSION_ID`**：v2 已经提供，应删除命令前缀 hack。
5. **文件式资产不动**：agents/commands/skills 是 Phronia 的长期资产，v2 兼容，
   适配层只应替换插件 shard，避免模板分叉。
6. **保留 v1**：v1 仍是大量用户的现网版本；v2 支持不能以删除 v1 为代价。
