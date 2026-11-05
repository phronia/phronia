# Centralized worktree root with managed gitignore

## Goal

把 worktree 存储位置收敛为一个受管理的集中根目录，默认 `.phronia-workspace/`（仓库根下，与 `.phronia/` 平级），并保证该目录始终被 git 忽略。旧位置（`.phronia/worktrees/` 以及 `attach --path` 指向的仓库外目录）保持只读兼容。

## Problem

worktree 根目录当前由三处常量各自的字面量 `.phronia/worktrees` 决定，另有一处 Python 侧 `layout.json` 副本；而 `.gitignore` 只包含相对模式 `worktrees/`，只对 `.phronia/.gitignore` 生效。

由此产生三个真实缺陷：

1. **自定义根目录不被忽略。** 用户把 `parallel.worktree_dir` 设为 `.phronia-workspace` 或任何仓库根下的目录名后，`.phronia/.gitignore` 的 `worktrees/` 不再匹配，新建的 worktree 内容会出现在主检出的 `git status` 中，存在误提交风险。`services/workspace.ts:2318` 的注释明确写着 Phronia "never edits `.gitignore`"，这是当前设计的已知空白。
2. **位置分散导致清理不可靠。** `attach --path` 允许任意位置，注册表（`<git-common-dir>/phronia/worktrees.json`）能列出来，但用户视角下"这一堆同级目录"无法按目录批量识别与回收。
3. **默认值重复定义。** `readers.ts:27`、`policy.ts:23`、`layout/index.ts:102`、`layout.json:26`、`safe_commit.py:54`、`gitignore.txt:14` 各自持有路径字面量，任何变更都要人工同步，是长期技术债。

## Requirements

### R1 单一解析来源

worktree 根目录必须只有一个解析函数，输入为（配置值、主检出根），输出为绝对路径 + 相对路径（用于 gitignore 与展示）。其余所有层必须从该结果派生：

- core 配置层只负责读取并校验配置，不承载默认路径语义之外的拼接逻辑。
- CLI services（`workspace.ts`、`coordinator.ts`）通过该解析函数取根目录。
- Python scripts（`layout.json`、`safe_commit.py`）读取 CLI 写出的派生值或等价的共享常量，不得再维护独立字面量。
- templates 的 gitignore 只描述"如何忽略"，不硬编码目录名。

### R2 默认根目录

- 默认值改为 `.phronia-workspace`（仓库根下）。理由：与 `.phronia/` 平级便于识别与整体删除；在仓库内，因此单个 git 仓库即可忽略、无需父目录约定；不进入 `.phronia/` 内部以免与受管模板文件混淆。
- `parallel.worktree_dir` 仍可配置为相对或绝对路径，语义不变。
- `parallel.worktree.location: ephemeral` 的 `/tmp` 行为保持不变。

### R3 受管 gitignore

- `phronia init`、`phronia update`、`phronia task workspace ensure` / `worktree add` 在写入前确保根目录被忽略。
- 忽略规则写入方式：优先在仓库根 `.gitignore` 的 Phronia 受管块内写入解析后的相对路径；若项目使用 `.phronia/.gitignore`，在其内写入相对该文件的正确模式。两者都通过 `utils/managed-block.ts` 做幂等插入，绝不整文件覆盖。
- 若配置为绝对路径或仓库外路径，跳过 gitignore 写入并给出明确提示（无法用忽略规则覆盖仓库外目录）。
- 用户手工删除该块时，下次 ensure 重新补回；用户手工修改块内其他内容时不得被覆盖。

### R4 旧路径只读兼容

- 读取顺序：共享注册表 → `task.json.worktree_path` 遗留字段。旧路径 worktree 必须能 attach / commit / integrate / archive。
- 新建 worktree 一律落在新根目录。不自动迁移、不自动删除旧目录。
- `phronia doctor` 报告：当前根目录、是否存在旧路径 worktree、每条旧记录的可回收状态（landed/clean/dirty），并给出清理命令。

### R5 可观测

`workspace ensure --json`、`worktree list --json`、`worktree add --json` 必须暴露解析后的根目录，以及该目录是否已被忽略（布尔 + 判定依据）。`doctor` 输出同样字段。

### R6 只对新任务生效

默认根目录的变更不得改变既有任务的位置。分界依据是任务自身的持久化记录，不是项目版本号。

- 已注册在任何位置的 worktree（旧根目录、外部 attach 路径、`task.json.worktree_path` 遗留字段）继续按原位置解析，不得被重新指向新根目录。
- 只有新创建的任务的 worktree 落在新根目录。
- 判定必须能处理"注册表条目存在但目录已删除"的情形：此时报缺失，不猜新路径。

### R7 升级平滑

- `phronia update` 在检测到旧根目录下仍有 worktree 时，输出一行说明（不阻断、不改退出码）：告知旧目录位置、已完成任务可回收、新任务将落在新根。
- 升级不得移动、删除或重写任何既有 worktree 目录与注册表条目。
- 受管 gitignore 块在升级时补齐；若用户此前手工维护过等价规则，不产生重复条目。

### R8 未完成旧任务的兼容

升级时处于 `planning` / `in_progress` 的旧任务必须继续可用：

- 其 worktree 在旧位置时，`commit` / `integrate` / `archive` / `workspace ensure` 全部按旧位置工作。
- 无 worktree 的旧任务在首次 `ensure` 时不得因为"换了默认根"而失败或被迫迁移。
- 旧任务完成后，归档回收对旧位置同样生效（包含释放空间报告）。

## Acceptance Criteria

- [ ] 修改默认根目录只需改一处常量；`pnpm test` 中不存在需要同步修改的第二处字面量（回归测试除外）。
- [ ] 在全新项目中运行 `init` 后，`.phronia-workspace` 已被忽略；创建 worktree 后 `git status` 干净。
- [ ] 在配置 `parallel.worktree_dir: .custom-wt` 的项目中，`init`/`update`/`ensure` 后 `.custom-wt` 被忽略。
- [ ] 配置为绝对路径或仓库外路径时，不写 gitignore，且输出明确提示。
- [ ] 已有旧路径 worktree 的项目：`worktree list` 能列出，`commit`/`integrate`/`archive` 正常，`doctor` 给出位置与回收建议。
- [ ] 受管块幂等：连续运行 init/update/ensure 不产生重复条目；用户块外内容不被修改。
- [ ] `--json` 输出包含解析后的根目录与忽略状态。
- [ ] 升级后旧任务的 worktree 路径逐字节不变（对照升级前后的 `worktree list --json`）。
- [ ] 旧位置 worktree 的旧任务可完整走完 commit → integrate → archive，且回收的是旧位置目录。
- [ ] 升级不改写注册表以外的任何既有文件；注册表仅在必要时追加缺失条目。

## Notes

- 该子任务必须先于另两个子任务实施：它们都把"集中根"当作既定前提。
- 目录搬迁是一次性破坏性变更，因此只改默认值、不搬旧数据；旧项目的迁移由用户在 `doctor` 提示后自行决定。
- 用户已确认：**只对新任务生效**，升级平滑，未完成的旧任务必须零手工步骤继续（R6-R8）。
- 风险点：注册表是"重建可推导"的（`shared-runtime.ts` 在注册表缺失时会用 `git worktree list` 重建）。重建逻辑必须保持既有路径原样，不能因为默认值变了就把已存在的 worktree 映射到新根。
