# Karpathy LLM Wiki — 推特调研

> 调研时间：2026-04-22
> 数据源：Twitter/X（via `opencli twitter`）
> 关联：对 Memory plugin 设计的外部锚点 + 目录约定参考

## 一手：Karpathy 本人 2 条核心推

### Farzapedia 推（2026-04-?）

- URL: https://x.com/karpathy/status/2040572272944324650
- 热度：8.8k 赞 / 1.25M views

点名了个人化记忆的 **4 核心原则**（直接适用于 Trellis Memory plugin 设计原则）：

1. **Explicit** — memory artifact 是**可浏览、可审计的**（不是黑盒 embedding），你能看到 AI 知道什么、不知道什么，可直接 inspect 和 manage
2. **Yours** — 数据在你本地，不在某家 AI 厂商的系统里，你完全控制自己的信息
3. **File over app** — 就是一堆 md + 图片等**通用格式文件**，能被整个 Unix 工具链、任意 agent 原生消费；任意数据可导入、任意界面可查看（Obsidian / vibe-coded UI）
4. **BYOAI** — Claude / Codex / OpenCode 都能插上来用；甚至可以拿这堆 md 去 fine-tune 一个开源模型，让 AI 在 weights 里"懂你"而不只是 attend 你的数据

原文金句：
> agent proficiency is a CORE SKILL of the 21st century

### 补充推（回复 @kepano）

- URL: https://x.com/karpathy/status/2039832199399350722

> yes, this is why I maintain and carefully curate all the data in raw/ , which is authoritative, and the derived wiki is kept separate and maintains backlinks to original content.

**重要分层决策**：
- `raw/` 是 authoritative source（人类 curate）
- `wiki/` 是 LLM 维护的 derived 层
- 两者之间**维护 backlinks**（derived → raw）

## 二手：社区落地（Karpathy 推后 12 天内涌现）

### llm_wiki（@nash_su，推特转述）

- URL: https://x.com/i/status/2046393001140986216
- 规模：12 天 2k⭐
- 定位："基于 Karpathy 大神的个人知识管理方法论做的全平台落地实现"
- 信号：需求真实存在，v0.3.6 已经稳定

### jackwener/llm-wiki（GitHub 参考实现深度分析）

- Repo: https://github.com/jackwener/llm-wiki
- npm: `@jackwener/llm-wiki`
- 定位：**Agent-native persistent knowledge management — compile knowledge once, query forever**
- Tech: TypeScript (ESM, Node 20+) + Commander.js + gray-matter + pg + tsup + Vitest
- 关键论断：**The tool itself doesn't call LLMs**. 只提供 skill 文件，让任意 agent（Claude Code / Codex）操作 wiki；Obsidian 是人类界面（无自建 GUI）

**Vault 结构（Trellis Memory plugin 直接可抄）**：
```
my-wiki/
├── CLAUDE.md              # Claude Code 入口（auto-loaded）
├── AGENTS.md              # Codex 入口（auto-loaded）
├── wiki-purpose.md        # Wiki scope 和 audience
├── wiki-schema.md         # 页面类型、命名规范、frontmatter 规则
├── wiki-log.md            # append-only 操作日志
├── wiki/                  # AI-maintained 页面（Obsidian 兼容）
├── sources/               # Raw immutable 源文件
│   └── YYYY-MM-DD/        # 按日期切分
├── .claude/skills/llm-wiki.md
├── .agents/skills/llm-wiki.md
└── .llm-wiki/
    ├── config.toml
    └── sync-state.json
```

**4 个核心操作（slash commands）**：
| 操作 | 用法 | 作用 |
|---|---|---|
| `/ingest <path>` | 读 source → 抽实体 → 建/更新 wiki 页 + `[[wikilinks]]` → 拷贝到 `sources/YYYY-MM-DD/` |
| `/query <question>` | 搜 wiki → 合成答案 → **valuable insights 写回 wiki（knowledge compounding）** |
| `/lint` | 检测 broken links / orphans / contradictions / stale / frontmatter drift → auto-fix safe 部分 |
| `/research <topic>` | 超出 wiki：web 搜 → 存 sources → ingest → 合成报告 |

**两文件 bootstrap 模式（最重要的架构点）**：

1. **Entry files**（`CLAUDE.md` / `AGENTS.md`，vault 根）：
   - 每次 session 自动加载
   - 只几十行，**极力保持小**（session-start context 便宜）
   - 告诉 agent：这是 wiki vault / purpose + schema 在哪 / 有哪些 slash command / 完整 skill 文件在哪
2. **Skill file**（`.claude/skills/llm-wiki.md` + `.agents/skills/llm-wiki.md`）：
   - **按需加载**（agent 调用 command 时）
   - 完整 playbook：每个操作的 step-by-step、页面 schema、frontmatter 规则、worked examples、invariants
   - 同一份 skill 装到两个平台目录 → 一套 vault 跨 Claude Code / Codex

**Invariants（硬约束）**：
- `sources/` 是 immutable，任何修改只能在 `wiki/`
- **每次操作必须**：append 一行到 `wiki-log.md` + 跑 `llm-wiki sync`
- 每次操作前读 `wiki-purpose.md` + `wiki-schema.md`（+ 可选 `wiki-agent.md`）

**Frontmatter 规范**（wiki 页）：
```yaml
---
title: Page Title
description: One-line summary
aliases: [alt names, abbreviations, translations]  # 改善 search + wikilink 匹配
tags: [domain-specific from wiki-schema.md]
sources: [YYYY-MM-DD/source-filename.md]           # 必填，每个 claim 可追溯
status: open | resolved | wontfix                   # issue/bug 页必填
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

**Source 拆分原则**：
- 大 source **按主题或日期拆分**（`chat-2026-04-17.md` / `browser-timeout-discussion.md`）
- 支持细粒度增量 re-ingest
- 拷贝后打 `ingested: YYYY-MM-DD` 和 `wiki_pages: [...]` frontmatter

**CLI 命令（tool-side，不调 LLM）**：
| 命令 | 作用 |
|---|---|
| `llm-wiki init` | 一键初始化（vault 文件 + bootstrap + 两平台 skill） |
| `llm-wiki search` | BM25 关键词搜索（CJK bigram 分词）+ 可选 DB9 vector → RRF fusion |
| `llm-wiki graph` | 分析 `[[wikilink]]` 图：community / hub / orphan / wanted 页面 |
| `llm-wiki status` | 统计 + health |
| `llm-wiki sync` | 追 mtime + SHA256，同步 embeddings 到 DB9 |
| `llm-wiki skill install` | 装 skill 到 agent workspace（升级时刷新） |

**可选云端**：DB9 做 vector search（`embedding(text)::vector(1024)` + HNSW），配置 `.llm-wiki/config.toml` 即启用。**MVP 不依赖**。

**Knowledge compounding（最有意思的设计点）**：
- `/query` 不只是答题，如果答案产生了**有价值的新知识**（连接 3+ 页 / 解决矛盾 / 填补 gap），会写回 wiki
- 新页打 `source_type: query-synthesis`
- **这让 wiki 随使用增长，不只随 ingest 增长** —— 是和传统 RAG 最根本的差异

### obsidian-ai-orange-book

- URL: https://x.com/i/status/2046718580255756577
- ⭐ 693 / GitHub Trending
- 核心做法：`CLAUDE.md + index.md` 做 **80% 工作**
- **在 CLAUDE.md 里写死 3 个触发词**：
  - `加到 wiki` → 自动归档 + 合并同类项 + 级联更新
  - `我知道啥关于 XX` → 先查 wiki 再答
  - `lint wiki` → 自检死链和矛盾
- 7 个 copy-paste workflow
- **对 Trellis 的启示**：skill 的 activation pattern / trigger 语义可直接借鉴

### ianneo_ai 实测（一人企业落地）

- URL: https://x.com/i/status/2042909644574924855
- 目录约定：
  ```
  raw/        # 原始素材，Claude 只读不改
  wiki/       # Claude 消化后的笔记，按主题分
  index.md    # 全局索引
  log.md      # 每次操作日志
  CLAUDE.md   # 三个触发词
  ```
- 外围工具：Obsidian 可视化 + Claude Code 大脑
- **目录约定范本**：Trellis Memory plugin 可采用同构布局

### llm-wiki-compiler（命令行工具）

- URL: https://x.com/i/status/2044664587329630473
- 两阶段 pipeline：先全源提取概念，再逐个生成 wiki 页面
- **基于哈希的增量编译**（只处理变更源）
- `query` 命令 + `--save` 存为新页面
- 可借鉴点：增量编译思路，Trellis 如果做 compile 步骤可以参考

### LLM Wiki v2（@berryxia 转述）

- URL: https://x.com/i/status/2043471951134646282
- **"活的记忆系统"** 进化方向：
  - ✅ Confidence Scoring（可信度分数：来源数量 + 最近确认 + 矛盾检测）
  - ✅ Memory Tiers（working / episodic / semantic / procedural，分层压缩 + 不同生命周期）
  - ✅ Knowledge Graph（typed entity + 关系，支持图遍历）
  - ✅ Automated Hooks（新来源自动摄入、会话结束自动压缩、定时维护 + 衰减）
  - ✅ Forgetting Curves（长期不访问的知识降权）
  - ✅ Contradiction Resolution（根据来源权威度和时效性主动解决冲突）
- **Trellis 决策：MVP 明确拒绝**，复杂度爆炸，是独立研究方向

### Rowboat（@_avichawla）

- URL: https://x.com/i/status/2041798871383441807
- 关键论点：**wiki 模型在"演化型 work context"上失效**
  - wiki 适合：研究、概念及其关系（相对稳定）
  - wiki 不适合：deadline / plan / meeting / commitment（context 跨对话持续演化）
- Rowboat 的解法：typed-entity knowledge graph
  - 每个 decision / commitment / deadline 是一个独立 md 文件
  - backlinks 指向涉及的人和项目
  - 从 Gmail / Granola / Fireflies 摄入对话
  - 运行后台 agent 做日报装配
- **Trellis 决策：out of scope**（已在 PRD out-of-scope 明示 graph 栈）
  - 但知道**边界**很重要：Trellis Memory 服务于**代码/项目知识**（相对稳定，wiki 合适）
  - 不服务于**通用生活 work context**（需要 graph）

### wiki9（@dxhuang）

- URL: https://x.com/i/status/2041594299041874255
- "Agent-native LLM Wiki powered by DB9"
- 核心做法：**不在工具里嵌 LLM 调用**，而是生成 `AGENTS.md + skill 文件`，让任意 agent（Claude Code / Cursor / Windsurf）直接操作 wiki
- **对 Trellis 的启示**：这个架构范式和 Trellis 哲学 100% 一致（配置生成器 + 平台原生扩展点），可以当作实现参考

## 对当前 PRD（plugin-system-design）的调整建议

### 1. 加"Design Principles"章节，引用 Karpathy 4 原则

在 Memory plugin 需求里写：
> 设计原则对齐 Karpathy Wiki LLM 4 原则：Explicit / Yours / File over app / BYOAI。

价值：**省自证**，外部锚点。

### 2. 目录约定扩展：`sources/` + `wiki/` 分层（对齐 jackwener/llm-wiki）

当前 PRD（第 93 行）：`.trellis/memory/*.md`

建议改为（和 jackwener/llm-wiki 对齐）：
```
.trellis/memory/
  wiki-purpose.md        # 这个 memory vault 的 scope 和受众
  wiki-schema.md         # 页面类型、命名、frontmatter 规则
  wiki-log.md            # append-only 操作日志
  wiki/                  # AI-maintained 页（Obsidian 兼容，含 [[wikilinks]]）
  sources/YYYY-MM-DD/    # Raw immutable 源（只读）
  _index.md              # 可选：路由表（省 token）
```

依据：Karpathy 本人明确的 raw vs derived 分层 + jackwener/llm-wiki 参考实现 + ianneo_ai 实测验证。

**关键约束**（直接搬 llm-wiki invariants）：
- `sources/` immutable，修改只能在 `wiki/`
- 每次操作强制 append `wiki-log.md` + 跑 sync
- Frontmatter `sources:` 字段必填（claim 可追溯）

### 3. Skill 命令集直接对齐 jackwener/llm-wiki 四件套

不再自造，直接用 `/ingest` + `/query` + `/lint` + `/research` 四个 slash command。

每个命令的 step-by-step、frontmatter 规则、invariants 从 `jackwener/llm-wiki/skills/llm-wiki.md`（15.8KB）拿来改，省掉自写 skill 的成本。

**Trellis 特化**：
- `/ingest` 增加"优先 ingest 代码 session / PR / spec"的 MUST 规则
- `/query` 默认 scope 是 project memory，不是个人知识
- `/research` 保持原样

### 4. 两文件 bootstrap 模式可复用到 Trellis 跨平台分发

jackwener/llm-wiki 解决了一个 Trellis 本来就要解决的问题：**一套 skill 跨 Claude Code + Codex**。

其模式：
- Entry: `CLAUDE.md` / `AGENTS.md` auto-load（几十行，极小）
- Skill: `.claude/skills/llm-wiki.md` + `.agents/skills/llm-wiki.md` 按需加载（完整 playbook）

**对 Trellis 的启示**：Memory plugin 的 adapter 层**不需要平台特化的业务逻辑**，只需要把同一份 skill 分发到各平台的 skills 目录。这和 Trellis 现有 Shared Templates 机制完全契合，不新增子系统。

### 5. Knowledge compounding 机制值得纳入

`/query` 写回 valuable insights 是传统 RAG 没有的能力。
- Trellis Memory plugin 建议**默认启用** compounding
- 标记为 `source_type: query-synthesis` 和人工 ingest 区分
- 这让 memory 不只是"被动记录"，而是"主动沉淀"

### 6. CLI 工具侧职责边界清晰化

jackwener/llm-wiki 明确：**tool 不调 LLM，只做索引 / 搜索 / graph / sync**。LLM 调用全在 agent 的 skill 里。

**对 Trellis 的启示**（重要决策）：
- Trellis 本身（`trellis` CLI）**也不调 LLM**，只做资源分发 / schema 检查 / migration
- Memory plugin 如果需要 CLI 侧能力（BM25 search、graph 分析），走**独立 sub-CLI**（`trellis memory search` / `trellis memory graph`），不混进 AI 调用
- 这和 Trellis "配置生成器，runtime 在 AI CLI 里" 的哲学一致

### 4. Out of Scope 显式加一条

```markdown
- **首批不做**：confidence scoring / memory tiers / forgetting curves / contradiction resolution
  —— 这些是独立研究方向（LLM Wiki v2 方向），MVP 保持 Karpathy 原始简洁哲学
```

### 5. _index.md 路由表已命中共识

当前 PRD 第 98 行已写明。Karpathy 社区独立验证了这是对的，无需调整。

## 信号汇总：Trellis Memory plugin 踩中了共识

- Karpathy 4 原则 = Trellis 气质
- 社区 12 天内涌现 N 个方案 = 需求真实存在
- **jackwener/llm-wiki 已经是接近"成品参考实现"**，Trellis Memory plugin 不需要从零设计，只需要：
  - 复用其 vault schema（sources/wiki/log/purpose/schema）
  - 复用其 4 个 slash command 语义（ingest/query/lint/research）
  - 复用其 CLAUDE.md + AGENTS.md + skill 分发模式（和 Trellis 跨平台分发天然契合）
  - 特化：scope 收敛到代码/项目域
- wiki9 + jackwener/llm-wiki 的"生成 AGENTS.md + skill 文件让 agent 直接操作"架构范式 = 和 Trellis 哲学 100% 一致
- Rowboat 的边界（work context）提醒：Trellis Memory 的定位是**项目知识**（相对稳定 → wiki 合适），不是**通用生活 work context**（需要 graph）

## 决策速记（待 brainstorm 确认）

1. Memory plugin vault 结构**直接采用 jackwener/llm-wiki schema**（不自造）
2. Skill 内容以 `jackwener/llm-wiki/skills/llm-wiki.md` 为基础改写，加 Trellis 代码场景的 MUST/NEVER 规则
3. Trellis CLI 侧不调 LLM（和 llm-wiki 一致）；如需 search/graph 走 `trellis memory <subcmd>`
4. 和 Trellis 已有 spec 体系的关系：
   - `.trellis/spec/` = 人类 curate 的规范（authoritative）
   - `.trellis/memory/` = AI 维护的项目知识 wiki
   - 两者是**互补**，不是替代。Memory 可以 ingest spec 但不改 spec
5. Claude Memory Tool `memory_20250818` 6 命令的对齐仍然保留（兼容 Anthropic 原生通道），但**vault 结构走 llm-wiki 风格**而不是 Claude 默认的扁平结构
