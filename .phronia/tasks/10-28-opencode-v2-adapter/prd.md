# OpenCode v2 平台适配

## Goal

让 Phronia 在 OpenCode v2 上获得与 v1 等价的上下文注入、会话身份和子代理协作能力，
同时把「按 harness 代际选择适配层」做成可长期维护的架构，而不是一次性补丁。

## 背景

OpenCode v2 重写了插件 API。v1 的默认导出函数在 v2 下直接加载失败
（`Plugin must export a default definition with an id and an effect or setup function`）。
Phronia 当前为 OpenCode 生成的三个 v1 插件（SessionStart、workflow-state、subagent context）
在 v2 下全部失效；`opencode --version` 探测到 2.x 时，adapter registry 也明确返回
`opencode@v2 is not implemented`。结果是：命令、agent、skill 还能用，但所有 hook 注入丢失。

## 本次任务范围（2026-10-28 确认）

**做**：OpenCode v2 的 adapter、能力矩阵、v2 shim、模板 base/shard 组合、init/update/doctor
接入、adapter 切换对账、recorded-first 选择优先级、跨 harness 的 host marker 身份隔离、文档。

**不做（拆为后续任务）**：

- `phronia mem` 读取 OpenCode v2 的 `session_v2` / `session_message` schema。
- harness 无关的 Run / Attempt / Checkpoint / Lease 编排层。
- `session bind` 子会话任务继承（先依赖 dispatch prompt 里的 `Active task:`）。

## Users and scenarios

- **新用户**：本机装的是 OpenCode 2.x，执行 `phronia init --opencode`。
  期望生成的配置能直接被 v2 加载，不需要手工改插件或装依赖。
- **存量用户**：项目里已有 v1 配置，之后把 OpenCode 升级到 2.x。
  期望 `phronia update` 能把插件 shard 从 v1 换成 v2，且保留用户改过的文件。
- **回退用户**：升级后发现问题，想回到 v1。期望通过 `config.yaml` 的
  `platforms.opencode.adapter: opencode@v1` 锁定代际，`update` 能切回。
- **维护者**：未来 OpenCode 出 3.x 时，只新增一个 adapter shard，
  不需要改 context core、agents、commands、skills。

## Functional requirements

### R1 版本感知的 adapter 选择

- `init`、`update`、`doctor` 必须在写模板前探测 harness 版本，并通过统一的
  `selectAdapter` 决定使用 `opencode@v1` 还是 `opencode@v2`。
- 选择优先级固定为：`config.yaml` pin > 探测成功的 semver 匹配 > manifest 记录
  （仅在探测不可用时）> fallback。探测成功时不得用旧记录覆盖新版本。
- 探测不到版本时保持 manifest 记录的 shard；首次初始化且无记录时回退 v1 并标记 degraded。
- 探测到 v2 且 v2 shard 可用时，选择 v2；不可用时明确报 unsupported，不静默套 v1 插件。
- 同一仓库多台机器、只有部分机器安装 OpenCode 时，`update` 不得因为本机探测失败
  而把另一代 shard 改回 fallback。

### R2 v2 插件 shim

- 生成一个零运行时依赖的单文件插件，放在 `.opencode/plugins/`，可被 v2 直接加载。
- 覆盖与 v1 等价的三类能力：
  1. 会话开始上下文（当前状态、workflow、spec 索引、first-reply notice）；
  2. 每轮 user prompt 的 workflow-state 面包屑；
  3. 子代理 dispatch 时的任务上下文注入与 `Active task:` 提示。
- 所有注入只影响外发模型请求，不写入 OpenCode 历史。
- 子代理会话不重复注入会话开始上下文。

### R3 会话身份

- v2 下使用 OpenCode v2 提供的真实会话身份，不再依赖给 shell 命令加 `export PHRONIA_CONTEXT_ID=...` 前缀。
- Python 脚本（`task.py`、`add_session.py` 等）在 v2 shell 中必须能解析到当前会话。
- 身份解析必须先识别宿主（`OPENCODE=1`、`ZCODE_PROJECT_DIR`、`CLAUDE_CODE_ENTRYPOINT` 等标记），
  再只查该宿主的 env 表；不能因为从另一个 harness 的 shell 继承到 `OPENCODE_SESSION_ID`
  而把 ZCode 的会话误判成 OpenCode，反向同理。
- 子代理会话应能沿父子链解析到父会话的任务；本次至少依赖 dispatch prompt 里的
  `Active task:`，不做自动绑定。

### R4 模板组合与生命周期

- OpenCode 模板必须拆成「代际无关的 base」和「按 adapter 的 shard」：
  agents、commands、skills 只保留一份；插件、`package.json` 等按代际分目录。
- `init` / `update` 使用同一套组合逻辑，保证写入内容与 update 期望内容不会漂移。
- adapter 切换时，`update` 必须移除旧 shard 中由 Phronia 写入且用户未修改的文件；
  用户修改过的文件保留并给出明确提示。
- 切换必须幂等：`v1 → v2 → v1` 后文件集合与直接安装对应代际一致。

### R5 诊断与可观测性

- `doctor` 必须显示：探测到的 harness 版本、选中的 adapter、adapter 状态、
  最近一次 handshake 的 adapterId，以及不一致原因。
- shim 写入 handshake 时必须带真实 adapterId（不能永远是 v1）。
- v2 下如果插件未加载（例如用户禁用了插件），doctor 能通过 handshake 缺失发现。

### R6 上下文契约

- core 的 `phronia context` 契约不因 v2 改变语义；v2 shim 通过 `hints`
  传递 session、agent、prompt、tool、path 等信息。
- v2 的工具名与参数差异（`shell`、`subagent`、`patch`、`path`）在 core 的
  tool-name 归一化层处理，不散落在 shim 里。
- v1 与 v2 对等价输入必须产出等价的 context blocks（parity 测试）。

### R7 mem 会话读取（本次不做）

- `phronia mem` 在 v2 数据库上能列出并提取新会话，作为独立后续任务。
- 本次只保证 v1 读取路径不回归。

### R8 文档

- 多平台文档说明 OpenCode v1 / v2 的差异、pin 方法、升级与回退步骤。
- changelog 记录破坏性边界：v1 插件不再适用于 v2，必须运行 `phronia update`。

## Non-functional requirements

- **N1 零用户侧依赖**：v2 shim 不得要求用户 `npm install` 任何包。
- **N2 不阻塞宿主**：v2 hook 内不得使用同步阻塞的长时间操作；CLI 调用必须有超时与 single-flight。
- **N3 失败可降级**：任何 hook 异常都不能让 OpenCode 的模型请求失败；按 `degrade` 策略记录诊断。
- **N4 隐私**：handshake 只记录 payload key，不记录 prompt、路径内容或 session id。
- **N5 向后兼容**：v1 的现有文件、hash 归属、pin 语义、doctor 输出保持可用。
- **N6 可测试**：adapter 选择、模板组合、shard 对账、contract parity 都要有单元测试，
  不依赖真实安装 OpenCode。

## Out of scope

- OpenCode v2 的 TUI/GUI/RPC 插件形态。
- 利用 v2 的 `ctx.skill.transform` 把 skills 打进插件包（Phronia 的 skills 是用户可编辑资产）。
- 为 OpenCode v3 预先实现 adapter。
- 改写 v1 插件实现（只保留、不优化）。

## Acceptance criteria

- [x] 在 OpenCode 2.x 上执行 `phronia init --opencode`，只生成 `.opencode/plugins/phronia.js`；
      真实宿主烟测能加载并注入上下文；新 CLI 的 handshake 写入 `adapterId: opencode@v2`。
- [x] v2 下首轮对话能收到 session-start 上下文；后续每轮能收到 workflow-state
      （真实 OpenCode v2 宿主烟测：注入 SessionStart，handshake 记录 user-prompt）。
- [ ] dispatch `phronia-implement` / `phronia-check` / `phronia-research` 时 prompt 中含
      `Active task:` 与任务上下文（shim 单测覆盖 prompt 改写；真实宿主 dispatch 待手工验证）。
- [x] v2 下 shell 中 `python3 ./.phronia/scripts/task.py current --source` 能解析到当前会话；
      从 OpenCode shell 继承的 `OPENCODE_SESSION_ID` 不会在 ZCode 宿主下生效。
- [x] 已有 v1 项目升级 OpenCode 后运行 `phronia update`，v1 三个插件文件被移除、v2 插件被写入；
      用户改过的文件保留并提示。
- [x] `v1 → v2 → v1` 切换两次后，文件集合与 hash 记录和直接安装一致，无残留。
- [x] `platforms.opencode.adapter: opencode@v1` 能在 2.x harness 上强制使用 v1 shard，且 pin 在 `update --force` 后仍保留。
- [x] 本机未安装 OpenCode 时运行 `phronia update`，不会把 manifest 中记录的 v2 shard 改回 v1（recorded-first，单元测试覆盖）。
- [x] 同一项目同时配置 `.opencode/` 与 `.zcode/` 时，两个平台的模板、handshake、adapter 记录互不覆盖；
      从另一个 harness 的 shell 继承的 `OPENCODE_SESSION_ID` 不会改变 ZCode 会话的身份归属。
- [x] v1 的现有测试、contract fixture、doctor 输出不回归；`pnpm verify` 全绿。
- [x] 文档包含升级、回退、pin 三节（`docs/opencode-v2.md`）。

## Constraints

- 不能删除 v1 shard；v1 仍是现网主力。
- 不改变 `phronia context` 的 schemaVersion 1；如需新字段，只能做向后兼容扩展。
- 用户项目中的 `.opencode/package.json` 可能是用户自己的，删除前必须确认是 Phronia 写入且未修改。
- 所有跨平台路径必须是 POSIX 形式的 hash key。
