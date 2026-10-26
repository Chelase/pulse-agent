# 开发计划目录

本目录集中存放本项目当前在做或近期要做的开发计划文档。

## 1. 用途

- 记录"为了实现某个能力，要改哪些文件和模块、按什么顺序、改完算什么样"。
- 与 `.agent-rules/mechanisms/` 下的机制文档一一对应。
- 小任务优先使用 issue tracker；需要跨模块协调、机制沉淀或接力时写入本目录。

## 2. 文件命名

| 来源机制文档 | 配对开发计划 |
| --- | --- |
| `.agent-rules/mechanisms/<topic>.md` | `.agent-rules/dev-plans/<topic>-plan.md` |

## 3. 文档结构约定

每份开发计划文档应包含至少：

1. **配套机制文档链接**（顶部一行）。
2. **当前阶段**：选定的方案 / 范围。
3. **改动范围**：模块 + 文件清单。
4. **步骤**：每一步给出改动文件、关键代码片段、验收方式。
5. **验收清单**：可勾选的最终冒烟清单。
6. **不在本期做的事**：与下一阶段的边界。
7. **进度**：步骤当前状态。

## 4. 归档

开发计划完成后，在文档末尾追加 `## 归档` 小节，文件保留在 `dev-plans/` 至少到下个里程碑结束。

## 5. 当前在册

- [resident-agent-mvp-plan.md](./resident-agent-mvp-plan.md) — **当前生效（主线）**。精简 MVP：照抄 hermes 分层，落到蓝河平台约束上的常驻心跳 + 可重入任务队列 + skill/MCP 执行层 + BLE 入站服务面。本地桩测通过，真机三项待验。
- [device-code-first-boot-config-plan.md](./device-code-first-boot-config-plan.md) — 设备码首启配置（一期代码已接入，真机待验）。
- [mvp-core-capabilities-plan.md](./mvp-core-capabilities-plan.md) — 2026-09-06 重排后的 MVP 主线：真机基线 → 多步工具循环 → 事件驱动链路 → Skill 机制 → 对外接入面。四步代码全部落地，UI 层推迟。
- [blueos-agent-mvp-plan.md](./blueos-agent-mvp-plan.md) — 初版 MVP 计划（Phase 1 执行层已完成待真机验证；Phase 2–4 的排序已被上 plan 取代，保留作背景）。
