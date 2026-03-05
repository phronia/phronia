# Task Lifecycle Hooks

## Goal

支持在 task 生命周期事件（create, start, archive 等）后执行用户自定义脚本，方便集成 Linear、Jira 等外部任务管理工具。

## Requirements

- 在 `.trellis/config.yaml` 中配置 hooks
- 支持的事件：`after_create`, `after_start`, `after_finish`, `after_archive`
- Hook 通过环境变量获取 task 信息（TASK_NAME, TASK_DIR, TASK_STATUS 等）
- Hook 失败不阻塞主流程（warning 提示）

## Example Config

```yaml
hooks:
  after_archive:
    - "python3 scripts/sync-linear.py --task ${TASK_NAME} --status done"
  after_create:
    - "echo 'Task ${TASK_NAME} created'"
```

## Out of Scope

- Before hooks（拦截/阻止操作）
- Hook 的并行执行
- 内置 Linear/Jira 集成
