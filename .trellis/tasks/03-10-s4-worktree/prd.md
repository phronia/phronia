# S4: Worktree submodule + PR 感知

> Parent: `03-10-v040-beta1` | Depends on: S1, S2, S3

## Goal

Parallel agent 的 worktree 创建和 PR 流程在 monorepo（含 submodule）下正常工作。

## Scope

### 4.1 start.py submodule 按需初始化

**问题**: `git worktree add` 不会初始化 submodule，worktree 中 submodule 目录为空。

**方案**: 按 task 目标 package 选择性初始化。

```
1. 从 task.json 读取目标 package
2. 从 config.yaml 查询哪些目标 package 是 submodule
3. 对 submodule 类型的 package: git submodule update --init <path>
4. 非 submodule → 跳过
5. 无 packages 配置 → 跳过（单仓模式）
```

| 场景 | 行为 |
|------|------|
| task.package 非 submodule | 不 init 任何 submodule |
| task.package 是 submodule | `git submodule update --init <path>` |
| task 涉及多 package | 逐个检查，只 init submodule 类型的 |
| 无 packages 配置 | 完全跳过 |

### 4.2 create_pr.py submodule 感知

**问题**: `git add -A` 只记录 submodule ref 变化，实际代码变更不会提交。

**方案**:
```
1. 检测改动是否在 submodule 目录内
2. 对每个有变更的 submodule:
   ├── cd <submodule>
   ├── git checkout -b <branch>
   ├── git add -A && git commit
   ├── git push && gh pr create
3. 回到主仓:
   ├── git add <submodule> (更新指针)
   └── 主仓 commit + PR
```

| 场景 | 行为 |
|------|------|
| 只改主仓代码 | 原有逻辑不变 |
| 只改 submodule | submodule PR + 主仓 ref-update PR |
| 两者都改 | submodule PR + 主仓 PR（含 ref + 主仓改动） |
| 无 packages 配置 | 完全跳过检测 |

### 4.3 cleanup.py

无需特殊处理（worktree remove 清理整个目录），增加日志提示。

---

## 受影响文件

| 文件 | 改动 |
|------|------|
| `packages/cli/src/templates/trellis/scripts/multi_agent/start.py` | submodule 按需 init |
| `packages/cli/src/templates/trellis/scripts/multi_agent/create_pr.py` | submodule 感知 commit/PR |
| `packages/cli/src/templates/trellis/scripts/common/config.py` | `get_submodule_packages()`（S1 已加） |

## Acceptance Criteria

- [ ] Worktree 中 submodule 目录正确初始化（仅 task 涉及的）
- [ ] submodule 内改动能正确 commit + 创建 PR
- [ ] 主仓 ref 更新包含在主仓 PR 中
- [ ] 无 submodule 的项目行为完全不变
- [ ] 单仓模式完全跳过 submodule 逻辑
