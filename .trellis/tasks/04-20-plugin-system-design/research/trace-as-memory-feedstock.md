# Trace 定位切换：从 observability/attribution → Memory 底座

> 创建日期：2026-04-23
> 触发：2026-04-22~23 会话，用户明确表态
>
> > "我需要的不是被后端观测生态接收，以及核心是记录用户 message 和 ai message，别的其实无关紧要，我们的 trace 更多是偏向构造 memory 的底座"
>
> 本文件沉淀定位切换后的两种实现路径（Case 1 / Case 2），以及被放弃的原路线清单。
> **结论未合入 PRD**，PRD 的 Trace 章节仍保留 OTel / exporter 原话，需后续决策后统一修订。

---

## 一句话定位

**Trace 不是 observability，不是 code attribution，是 Memory 的原料流**。核心 payload 仅保留 user message + assistant message 时序，**所有对外标准对齐需求全部作废**。

---

## 正式被放弃的原 PRD 路线

以下项来自当前 PRD L115-130 的 "Trace Plugin（架构重构：OTel 为内核 + 可插拔 exporter）"，在定位切换下**不再适用**：

| 原项 | 放弃原因 |
|---|---|
| "内部 source of truth 对齐 OpenTelemetry GenAI" | Memory 消费对话文本，不需要 span 树 / token 计量 / trace_id 穿链 |
| "Pluggable Exporters（agent-trace / opentraces / git-ai / langfuse / otel-otlp）" | 这些是对外发布格式，Memory 是内循环。没有消费者要 |
| "Conversation Transcript 归集（跨平台统一 schema）" | 统一不是目标，Memory 各平台 ingest 可以不同 |
| "Hook 订阅 PostToolUse / UserPromptSubmit / SessionStart/End / Stop / SubagentStop" | 只保留 Stop 一个就够（结束再采）。过度采集增加复杂度 |
| "OpenCode tool.execute.after + event firehose" | 同上，只需等 session 结束再一次性 dump |
| Acceptance Criteria "commit 时生成 `.agent-trace/traces.jsonl`" | 彻底作废 |

以下相关 research 在新定位下**降级为参考/历史资料**：
- `research/agent-trace-spec.md`
- `research/agent-trace-ecosystem.md`
- `research/otel-mcp-semconv.md`
- `research/cursor-trace-ux.md`

它们**不被删除**（决策可能再变），但 PRD 后续修订时引用应标注"定位切换前"。

---

## 核心设计：`.developer` 文件作为 opt-in 开关

### 既有状态（2026-04-23 实测）

`.trellis/.developer` **已存在**，是 ini 格式的**单文件**（不是目录），双重 gitignored：

```ini
name=taosu
initialized_at=2026-01-17T16:09:39+08:00
```

Gitignore 证据：
- 仓库根 `.gitignore:149` — `.trellis/.developer`
- `.trellis/.gitignore:2` — `.developer`

### 扩展方案

**新增 key 即开关**，无需新建目录 / CLI / 任何数据库：

```ini
name=taosu
initialized_at=2026-01-17T16:09:39+08:00

# Trace plugin opt-in（新增）
trace.enabled=true
trace.mode=session              # session | digest | off
trace.digest.model=haiku-4.5    # (仅 mode=digest 时用)
trace.digest.min_turns=5        # 少于 N 轮不摘要，直接跳过
```

Hook 脚本检测逻辑（伪码）：
```python
cfg = parse_ini(".trellis/.developer")
if cfg.get("trace.enabled") != "true": return
mode = cfg.get("trace.mode", "off")
```

### 为什么这个设计好

- **per-developer 天然隔离**：`.developer` 本身就是 per-project + per-machine 的个人标识，traces 归属这个人符合既有语义
- **零新概念**：不引入新的配置层、新 CLI 子命令、新 DB
- **`trellis plugin trace enable` 如果做**，只是这个 ini 的 CRUD 糖，不是必须
- **与 git 隔离的保障已存在**：`.developer` 已经双重 gitignore，顺势把 `.traces/` 也 gitignore 即可

---

## 存储路径

```
.trellis/
  .developer                ← 既有，identity + trace 开关
  .traces/                  ← 新增，per-developer，gitignored
    session-{uuid}.jsonl    ← Case 1 的原始留档
    digests/                ← Case 2 的摘要产出（如启用）
      2026-04-23-session-xxx.md
  .gitignore                ← 加一行 .traces/
```

**为什么放 `.trellis/.traces/` 而不是 `.trellis/workspace/{user}/traces/`**：
- `workspace/{user}/` 是进 git 的（journal、plan 共享），traces 是纯个人日志，语义冲突
- `.traces/` 与 `.developer` 对称（都是 per-developer 个人产物）
- 不跨项目污染（项目删除就一起删）

---

## Case 1：纯 session capture（简单版）

### 流程

```
┌──────────────────────────────────────────┐
│ Claude Code session                      │
│   user ↔ AI ↔ tools ……                   │
└──────────────────┬───────────────────────┘
                   │ Stop hook 触发
                   ↓
           check .developer
           trace.enabled=true ?
                   │ yes
                   ↓
  cp ~/.claude/projects/<norm>/<session>.jsonl
     → .trellis/.traces/session-{uuid}.jsonl
                   │
                   ↓
           DONE（零 LLM 调用）
```

### 实现

- **Claude Code**：Stop hook（或 SessionEnd hook）直接拷贝已有的 `~/.claude/projects/<normalized>/<session_id>.jsonl`
- **OpenCode**：plugin 订阅 session 结束事件，从 `~/.local/share/opencode/storage/session/` dump 出来

### 成本

- 代码量：30~50 行 python hook + 几十行 OpenCode plugin
- Token：**0**（纯文件操作，不调 LLM）
- 磁盘：每 session 几百 KB ~ 几 MB，长期得清理（见下"未决事项"）

### 价值

- **retrospective context**：半年后 debug 时翻回去看"当时为什么这么写"
- **Case 2 的数据前提**：没原始留档，摘要错了无从对证
- **临时记忆**：即使不做 Memory plugin，用户也能 grep 自己过往 session

### 限制

- 无结构化 insight，要翻阅时还是 jsonl 原貌
- 跨 session 关联靠自己
- 磁盘增长无上限

---

## Case 2：一步到位（llm-wiki 式，session capture + digest subagent）

### 流程

```
Case 1 完成后，继续：
                   ↓
           spawn digest subagent
           ("Haiku/Sonnet，提炼这次 session
             的关键决策/学习/待办")
                   ↓
           写 .trellis/.traces/digests/
                   {date}-session-xxx.md
                   （带 frontmatter: session_id, tags, refs）
                   │
                   ↓
          （可选）写 memory/sources/ ——
           仅当用户显式 /promote
```

### 实现

- 在 Case 1 的 Stop hook 末尾加 `spawn subagent` 调用
- subagent prompt 固定：读 `.trellis/.traces/session-{uuid}.jsonl` → 输出 markdown（模板参考 llm-wiki 的 ingest 产物）
- subagent 用 **Haiku 4.5 足够**（结构化抽取任务，不需要 Sonnet/Opus）

### Token 节流策略

1. **门槛过滤**：`trace.digest.min_turns` 少于 N 轮或字节数过小直接跳过
2. **Haiku 摘要、非流式**：一次性生成，不交互
3. **可关闭自动**：`trace.mode=session` 时只做 Case 1，`trace.mode=digest` 才启用。默认建议 session（保守）
4. **手动触发为主**：`/trellis:digest-session <id>` slash，用户自己判断要不要摘
5. **批量摘要**（V2）：积累 N 个 session 共用上下文一次摘

### 成本估算

假设每天 10 个 session，每 session 平均 10 轮、2000 tokens in / 500 tokens out 的摘要：

- Haiku 4.5：10 × ($0.001 × 2 + $0.005 × 0.5) ≈ **$0.045/day** ≈ $1.4/月
- Sonnet 4.6：同规模约 **$0.25/day** ≈ $7.5/月
- Opus 4.7：约 **$1.25/day** ≈ $37/月

**选 Haiku 4.5 足够便宜，可以默认启用**；其他 model 留给高价值场景。

### 价值（Case 1 之上的增量）

- **knowledge compounding**：多次 session 的 insight 累积在 digests 目录，支持后续 grep / 二次抽取
- **进 Memory plugin 的现成 source**：digest markdown 已经是 frontmatter + 结构化内容，可直接喂 `/ingest`
- **跨 session 模式发现**：summary 后更容易发现重复问题

### 限制

- 摘要失真风险（jakevin7 警告的"错误级联"）—— 缓解靠保留 Case 1 原始 + /promote 人审闸
- Token 成本（可控但非零）
- 摘要质量依赖 prompt 工程，初期需要调

---

## Case 1 vs Case 2 决策矩阵

| 维度 | Case 1 | Case 2 |
|---|---|---|
| 实现成本 | 低（几小时） | 中（1~2 天，含 prompt 调） |
| Token 成本 | 0 | $1~8/月（Haiku）or $30+/月（Opus） |
| 失真风险 | 0（原始留档） | 存在（靠原始兜底 + 人审闸） |
| 立即价值 | retrospective context | + knowledge compounding |
| 依赖 | 无 | 依赖 Case 1（原始留档） |
| 可降级 | — | 可关闭回到 Case 1 |

**推荐分阶段**：
1. **Phase 1**（本次发版）：Case 1 上线，`trace.enabled=true` 默认 `trace.mode=session`
2. **Phase 2**（Memory plugin 核心落地后）：加 `trace.mode=digest`，与 Memory ingest 通道对齐
3. **Phase 3**（按实际反馈）：自动 digest、批量摘要、跨 session 模式挖掘

---

## 对 PRD 结构的影响

**如果采纳本文档结论**，PRD 后续需要整章重写：

1. **删除**：L61-65 "Trace 架构决策调整"（OTel / exporter 内核论）
2. **删除**：L115-130 Trace Plugin Requirements 全部
3. **删除**：Q3（traces 是否与 task 绑定）—— 新定位下明确不绑 task，绑 developer
4. **新增**：Trace 作为 Memory plugin 的"session capture"采集组件章节
5. **降级**：Trace 不再是独立 Plugin，并入 Memory plugin 的 ingest pipeline
6. **Out of Scope 调整**：明确"不做 observability 对接、不做 code attribution、不做跨 tool exporter"

**PRD 未动**，等明确决策后统一修订。

---

## 未决事项（Open Questions）

### OQ-T1：Traces 磁盘增长怎么管
- 自动清理（N 天以前删除）？
- 自动压缩（gzip 旧 session）？
- 配置项 `trace.retention_days=30`？
- 如果 Case 2 生成了 digest，原始 jsonl 能否"摘要后归档压缩"？

### OQ-T2：Digest 自动 vs 手动的默认值
- 保守：默认手动 `/trellis:digest-session`，用户按需触发
- 激进：默认自动 digest，省 token 靠门槛过滤
- 个人倾向：保守起步，观察用户反馈再放宽

### OQ-T3：Digest 产出格式
- llm-wiki sources/ 的 frontmatter 模板（`ingested:` / `sources:` / `wiki_pages:`）？
- 还是更轻量的纯 markdown？
- 参考 `research/karpathy-llm-wiki.md` 的 schema 借鉴

### OQ-T4：跨平台 session 如何合并
- 一个 task 可能跨多个 Claude Code session
- 也可能横跨 Claude Code + OpenCode
- 合并在 Case 1 层（jsonl concat）还是 Case 2 层（digest 互相 reference）？

### OQ-T5：`trellis plugin trace enable` CLI 要不要做
- 做：CRUD `.developer` ini，友好但多一层代码
- 不做：教用户直接编辑 `.developer` ini（他们已经看过这个文件）
- 个人倾向：先不做，看反馈

---

## References

- 既有 `.developer` 文件设计：`/.trellis/.developer`（本 repo）
- llm-wiki digest 模式参考：`research/karpathy-llm-wiki.md`
- 被搁置的 observability 生态研究：`research/agent-trace-ecosystem.md`、`research/otel-mcp-semconv.md`
- 定位切换前的 FP 分析（部分结论仍适用，部分作废）：`research/fp-spec-memory-trace-boundary.md`

