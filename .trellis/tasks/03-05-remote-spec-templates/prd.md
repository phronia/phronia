# Remote Spec Templates - 支持从自定义远程仓库下载 spec 模板

## Goal

允许用户配置自定义远程仓库作为 spec 模板源，而不仅限于 Mindfold 官方 marketplace。这样企业/团队可以维护自己的 spec 模板仓库，通过 `trellis init --template` 下载使用。

## What I already know

- 当前模板索引 URL 硬编码为 `https://raw.githubusercontent.com/mindfold-ai/docs/main/marketplace/index.json`
- 使用 `giget` 库下载，格式为 `gh:mindfold-ai/docs/{templatePath}`
- 支持 3 种下载策略：skip, overwrite, append
- 模板类型目前仅支持 `spec`（有预留 `skill`, `command`, `full`）
- `init.ts` 中有交互式模板选择 UI
- `update.ts` 保护 `.trellis/spec/` 不被覆盖

## Assumptions (temporary)

- 自定义仓库需要遵循与官方 marketplace 相同的 index.json 格式
- 主要支持 GitHub 仓库（giget 也支持 GitLab、Bitbucket）
- 配置通过 CLI flag 传入，不需要持久化配置文件

## Open Questions

1. 自定义仓库的配置方式：CLI flag (`--registry <url>`) vs 配置文件 vs 两者都支持？
2. 是否需要支持多个源合并（官方 + 自定义）？还是自定义源完全替代官方源？
3. 自定义仓库的 URL 格式：仅 GitHub？还是也支持 GitLab / 任意 HTTP？

## Requirements (evolving)

- [ ] 支持通过参数指定自定义模板源
- [ ] 自定义源使用相同的 TemplateIndex 格式
- [ ] 下载流程复用现有 giget 机制
- [ ] 错误处理：源不可达时给出清晰提示

## Acceptance Criteria (evolving)

- [ ] `trellis init --registry <url>` 可以从自定义 GitHub 仓库下载模板索引
- [ ] 模板选择 UI 展示自定义源的模板列表
- [ ] 下载失败时 fallback 或给出明确错误信息

## Definition of Done

- Tests added/updated
- Lint / typecheck / CI green
- Docs/notes updated if behavior changes

## Out of Scope (explicit)

- 持久化配置文件（后续版本考虑）
- 模板发布/上传工具
- 非 spec 类型模板的自定义源

## Technical Notes

- 核心文件：`src/utils/template-fetcher.ts`, `src/commands/init.ts`, `src/cli/index.ts`
- `giget` 支持 `gh:`, `gitlab:`, `bitbucket:` 等前缀
- `TEMPLATE_INDEX_URL` 和 `TEMPLATE_DOWNLOAD_SOURCE` 是需要参数化的两个常量
- `getInstallPath()` 映射模板类型到本地路径
