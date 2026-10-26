# 规则目录（rules/）

本目录存放必须长期遵守的项目级 Agent 规则。

## 判据

写项目级"必须 / 不要 / 优先"这类执行约束，放本目录。
若是描述系统当前如何工作，放 `../mechanisms/`；若是本期实施计划，放 `../dev-plans/`。

## 约定

- 同类规则归入一个文件，文件名用语义化短横线命名，例如 `git-operations.md`、`execution-behavior.md`。
- 每个规则文件结构清晰：用途、约束条目、（必要时）当前状态。
- 当单个文件内容过多（超过 200 行或难以快速定位）时，拆分为多个文件并在本索引中标注。
- 新增 / 删除规则后，同步更新本清单与 `../README.md` §5。

## 当前规则文件

> 初始化时只预置 `git-operations.md`；以下其余文件为按需新增的常见示例，默认不创建。
>
> 已预置：
> - `git-operations.md`：Git 协作工具、约定式提交、中文提交规范。
> - `complex-feature-mechanism.md`：复杂跨模块功能实施时强制同步生成机制文档的规则。
> - `project-onboarding.md`：项目速览（技术栈、目录结构、核心模块、特殊机制、常用开发路径），由 Agent 首次分析项目时填充。
>
> 可按需新增（示例，非默认创建）：
> - `repo-context.md`：仓库背景、技术栈、目录职责边界。
> - `system-architecture.md`：系统架构约束。
> - `doc-conventions.md`：文档命名与产出约定。
> - `execution-behavior.md`：任务执行行为约定（如是否主动跑构建）。
