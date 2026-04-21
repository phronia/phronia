# Bootstrap 体验补齐：新开发者引导 + 承接 onboard 职责

## 背景

### 两个交织的缺口

**缺口 1：已有项目里 `trellis init` 不给新开发者任何引导**

`init.ts:619` 的判断：
```ts
const isFirstInit = !fs.existsSync(path.join(cwd, DIR_NAMES.WORKFLOW));
```

`init.ts:1343` 的分支：
```ts
if (isFirstInit) {
  createBootstrapTask(cwd, developerName, projectType, monorepoPackages);
}
```

**问题**：新开发者加入一个已有 Trellis 项目时 `.trellis/` 已存在 → `isFirstInit = false` → **根本不创建 bootstrap task**。他只拿到一个 `init_developer.py` 写进去的 identity，然后就面对一堆陌生的目录、task、spec，没有任何引导说"从哪开始"。

**缺口 2：`/onboard` 命令在 beta 版本被移除，职责没人接**

历史上 `/onboard` 命令负责：
- 引导 AI 或人类 了解项目架构
- 扫描 spec / task / workflow 熟悉约定
- 生成"项目 onboarding 总览"

beta 版本删除后，这个能力**没有迁移到任何地方**：
- Bootstrap task 的 PRD 只谈"填 spec"
- 新开发者首次打开 Claude / Cursor 没有自动引导流程
- Skills market 里虽然有 `onboard` skill，但没有在 init 时被触发或推荐

### 现状 Bootstrap PRD 的覆盖

看 `init.ts::getBootstrapPrdContent()`（`init.ts:104-256`）：

| 章节 | 内容 | 性质 |
|---|---|---|
| Purpose | 介绍 spec 为什么重要 | ✅ |
| Your Task | 按项目类型列出 spec 文件清单 | ✅ |
| Step 0: Import from Existing Specs | 从 CLAUDE.md / .cursorrules 迁移 | ✅ |
| Step 1: Analyze the Codebase | 让 AI 提炼模式 | ⚠️ 泛泛 |
| Step 2: Document Reality | 写真实模式不是理想模式 | ✅ |
| Completion Checklist | finish + archive | ✅ |

**完全没有**：
- ❌ "先了解项目"（架构、核心模块、关键业务概念）
- ❌ 人类新开发者 onboard 与 AI onboard 的共用流程
- ❌ 已存在 `.trellis/spec/` 时怎么用（是通过 spec 来理解项目，还是补齐缺失部分）
- ❌ 项目创建者 vs 加入者两种角色的分流

---

## 任务目标

1. **修复 init 分支**：已有 Trellis 项目 + 新开发者加入 → 生成 **joiner-onboarding** 引导任务（不是 bootstrap-guidelines，是不同内容）
2. **扩展 Bootstrap PRD**：承接被删除的 `/onboard` 命令的职责，加"了解项目"步骤
3. **区分两种 bootstrap**：
   - **Creator Bootstrap**（项目第一次 init）：填 spec、导入已有约定
   - **Joiner Onboarding**（新开发者加入已有项目）：读 spec、了解架构、熟悉 workflow

---

## 设计

### 分支逻辑重构

`init.ts:1343` 改为：

```ts
if (isFirstInit) {
  // 项目首次 init：创建 creator bootstrap（填 spec）
  createBootstrapTask(cwd, developerName, projectType, monorepoPackages);
} else if (isNewDeveloperForProject(cwd, developerName)) {
  // 已有项目 + 新开发者：创建 joiner onboarding
  createJoinerOnboardingTask(cwd, developerName);
}
```

**"新开发者"判断依据**：
- `.trellis/workspace/<developer>/` 目录不存在 → 是新开发者
- 或 `.trellis/.developers` 注册表里没有该 name

### Creator Bootstrap PRD 扩展

在现有 PRD 的开头插入 "Step -1: Understand Your Project"（给项目创建者自己梳理）：

```markdown
### Step -1: Understand Your Project (for AI)

Before filling spec files, let AI read the codebase to understand:
- What's this project for? (domain, users, key workflows)
- What's the architecture? (layers, modules, data flow)
- What are the core entities / concepts?

Ask AI:
- "Read README.md, AGENTS.md, and key entry files, then summarize the project"
- "Map the directory structure and explain the role of each top-level dir"
- "Identify the 3-5 most important modules and why"

Output goes to: `.trellis/spec/_project-overview.md` (or similar).
```

### Joiner Onboarding Task（新任务类型）

**task name**：`00-join-<developer>`（类似 `00-bootstrap-guidelines`，带 developer 名字避免碰撞）

**PRD 内容大纲**：

```markdown
# Joining: Onboard Yourself to This Trellis Project

Welcome! You're joining an existing Trellis project.
Here's a guided path to get productive fast.

## Step 1: Read the Project Overview

- `.trellis/spec/` — coding conventions (start here)
- `.trellis/workflow.md` — how this team works with AI
- `.trellis/tasks/` — active work, recent archive
- `AGENTS.md` / `README.md` — high-level orientation

Ask AI:
- "Summarize .trellis/spec/ — what coding conventions do I need to know?"
- "Look at the last 5 archived tasks — what patterns of work do people do?"

## Step 2: Understand Architecture

Ask AI:
- "Map the directory structure"
- "What are the 5 most important modules?"
- "What data flows through the system?"

## Step 3: Identify Your Assigned Work

- Check `.trellis/workspace/<you>/` if it exists
- Run `task.py list --assignee <you>`
- Look at My Tasks section in workflow-state

## Step 4: Try a Small Task

Pick any small P3 task or fix a typo. Run the full workflow once to learn.

## Completion

When you feel oriented:
```bash
python3 ./.trellis/scripts/task.py finish
python3 ./.trellis/scripts/task.py archive 00-join-<you>
```
```

### 触发逻辑

新建辅助函数：

```ts
function isNewDeveloperForProject(cwd: string, developer: string): boolean {
  const workspacePath = path.join(cwd, ".trellis/workspace", developer);
  return !fs.existsSync(workspacePath);
}

function createJoinerOnboardingTask(cwd: string, developer: string): boolean {
  // 类似 createBootstrapTask，但 task name 带 developer，内容用 joiner PRD
  ...
}
```

---

## 子任务

### 1. 分支逻辑

- [ ] `init.ts` 加 `isNewDeveloperForProject()` 判断
- [ ] 在 `isFirstInit = false` 且新开发者时调用 `createJoinerOnboardingTask()`
- [ ] Single source of truth 写 JSON + PRD 内容（避免 init.ts / create_bootstrap.py 双份）

### 2. Creator Bootstrap PRD 扩展

- [ ] 在 `getBootstrapPrdContent()` 插入 "Step -1: Understand Your Project" 段
- [ ] Python 版 `create_bootstrap.py` 同步（或消除重复）

### 3. Joiner Onboarding Task 新建

- [ ] 新 task.json 模板（`00-join-<developer>`，priority P1，dev_type "docs"）
- [ ] 新 PRD 模板（对应上面大纲）
- [ ] Monorepo / 单 repo 分支（joiner 可能只碰一个 package）

### 4. Skills / Commands 集成（可选）

- [ ] 检查 marketplace 的 `onboard` skill 是否仍有效
- [ ] 如果还用，PRD 里指引 "run `/onboard` or activate the onboard skill"
- [ ] 如果不再用，确认所有 onboard 知识都沉到 PRD 里了

### 5. 文档

- [ ] README 补"新开发者加入已有项目"场景
- [ ] `spec/cli/backend/*` 记录两种 bootstrap 的语义
- [ ] Changelog 注明修复了新开发者 init 体验的空白

### 6. 测试

- [ ] 空目录 `trellis init` → creator bootstrap
- [ ] 已有 `.trellis/` 的项目，新开发者 `trellis init --developer new-user` → joiner onboarding
- [ ] 已有 `.trellis/` + 已注册开发者（重复 init）→ 不生成重复 task
- [ ] joiner onboarding task 的 archive 后，再次 init 不再生成

---

## 非目标

- **不自动执行** onboarding（只生成任务，AI 读到 PRD 自己走流程）
- **不恢复** `/onboard` 命令本身（命令删除的决定已做）
- **不改** marketplace 的 `onboard` skill（独立的 skill 生态）
- **不自动**探测"这个 developer 是不是项目维护者"—— 第一个 init 的人是 creator，其他都是 joiner

---

## 优先级

🔴 **P1** —— 新开发者加入体验是 Trellis 推广的关键漏斗。目前新人只能拿到一个 identity 然后面对黑盒，是体验事故。

## 风险

- **两种 bootstrap 的边界模糊**：单人项目里"加新开发者"和"同一人换机器"区分不开。Mitigation：检查 `.trellis/workspace/<name>/`，存在即视为"不是新人"，哪怕是换机器也不重复打扰
- **PRD 内容膨胀**：往 PRD 里堆太多指引会让人没耐心读。Mitigation：joiner PRD 控制在 80 行内，深度指引放 skill / docs site
- **和 `04-21-session-scoped-task-state` 的交互**：joiner onboarding 创建后会 set 为 current-task，如果同时有别的窗口在跑会污染。依赖后者完成后再发布最终体验

## 关联

- `04-21-session-scoped-task-state` —— joiner 自动 set current-task 前，得先做好多窗口隔离
- `04-21-polyrepo-detection` —— 独立
- marketplace `onboard` skill —— 承接旧 `/onboard` 命令的替代
