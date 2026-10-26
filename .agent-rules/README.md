# pulse-agent Agent 规则统筹

> 本规则链路由 `project-rule-chain-init` 技能初始化生成。
>
> - **技能仓库**：https://github.com/Chelase/project-rule-chain-init
> - **作者**：Chelase
> - **技能版本**：1.0.0
> - **初始化时间**：2026-07-13

## 1. 目的

`.agent-rules/` 是本项目的 Agent 规则统筹、机制梳理、开发计划索引与跨会话接力目录。

以下文件都是桥接入口，不是独立规则库：

- `AGENTS.md`（默认生成，覆盖 Codex / 通用 Agent）
- `CLAUDE.md`（默认生成，覆盖 Claude Code）
- 其他 Agent 宿主约定的入口文件（如 `<agent-decided>.md`、`agent_readme.md`），仅在 `AGENTS.md` / `CLAUDE.md` 不覆盖该 Agent 时按需创建

如果桥接文件与根 `.agent-rules/` 冲突，以根 `.agent-rules/` 为准；当任务范围允许时，同步修正桥接文件，避免规则漂移。

## 2. 规则读取链路

在本项目开始分析、编辑、测试、评审或提交准备之前，Agent 必须读取：

1. 根据宿主工具入口读取对应桥接文件。默认只有 `AGENTS.md` 和 `CLAUDE.md`；其他 Agent（如 OpenClaw、Hermes）仅在不覆盖这两个文件时按需创建额外桥接入口。
2. 根 `.agent-rules/rules/README.md` 索引，按任务定位相关规则文件再精读。
3. 涉及具体机制、架构链路或业务模块时，先读取根 `.agent-rules/mechanisms/README.md` 索引，再按索引精读相关机制文档；文档很多时不要全量读取、不要逐个文件盲找。
4. 涉及具体开发任务时，先读取根 `.agent-rules/dev-plans/README.md` 索引，再按需读取相关计划文档。
5. 如果是延续上一轮会话、接力开发、继续未提交改动、提交准备或问题复盘，先读取根 `.agent-rules/handoffs/README.md` 索引，再按需读取最新的相关交接摘要。
6. 与任务相关的其他项目文档（如根 `ARCHITECTURE.md`、`docs/` 下的架构文档、README 等）。

记忆只用于提示存在规则目录，不能替代规则文件本身。执行任务时必须以 `.agent-rules/` 的当前文件内容为准。

## 3. 规则优先级

规则冲突时，按以下顺序处理：

1. 系统或宿主工具指令。
2. 用户当前明确提出的要求。
3. 根 `.agent-rules/rules/` 下的项目规则。
4. 根 `.agent-rules/mechanisms/` 下的稳定机制文档。
5. `AGENTS.md`、`CLAUDE.md` 或其他 Agent 桥接文件中的摘要说明。
6. 其他项目文档。

如果项目文档与当前代码/配置冲突，不要继续扩散过期描述。优先遵守当前有效规则或实现，并在任务允许时更新相关文档。

## 4. 目录分层

`.agent-rules/` 按文档性质分层：

- `rules/`：项目执行规则，例如 Git 协作原则、代码规范、任务执行行为约定。
- `mechanisms/`：项目稳定机制文档，描述系统当前已经存在的链路、协议、数据契约、风险边界。
- `dev-plans/`：开发计划，描述本期要把系统改成什么样。
- `handoffs/`：跨会话接力摘要，描述当前未提交状态、已做决策和下一步接手要点。
- `docs/`：参考资料，存放外部规范、技术参考、学习笔记等辅助文档。

分类判断：

- 写项目级"必须/不要/优先"这类执行约束，放 `rules/`。
- 写"系统现在如何工作、接口如何协作、字段如何解释"，放 `mechanisms/`。
- 写"本期改哪些文件、按什么步骤验收、进度如何"，放 `dev-plans/`。
- 写"上一轮会话做到哪里、哪些文件未提交、下一轮怎么接"，放 `handoffs/`。
- 写外部参考资料、技术规范摘要、学习笔记，放 `docs/`。

## 5. 当前规则文件

> 初始化时为空。新增规则时在此追加索引，并保持与 `rules/README.md` 一致。
> 示例格式：`- rules/<name>.md：一句话说明。`

## 6. 当前机制文档

- mechanisms/blueos-agent-runtime.md — BlueOS Agent 运行时的单例装配、启动序列、用户输入到工具执行的完整链路。
- mechanisms/event-gate-chain.md — 传感器/健康采样经闸门求值器筛选、跨门事件唤醒 Agent 并落振动/通知的完整链路。
- mechanisms/skill-invocation.md — SKILL.md 格式 skill 的加载、frontmatter 常驻与正文按命中注入、internal://files 覆盖。
- mechanisms/llm-configuration.md — 自定义供应商 LLM 配置：配置面板、KV 持久化、脱敏状态、连接测试与未配置降级。
- mechanisms/phone-first-boot-config.md — **目标态草案**：生产首启设备码 + 浏览器 H5（无手机 App）。
- mechanisms/resident-heartbeat-chain.md — 常驻心跳：平台定时任务后台拉起 app.ux、落盘队列单步续跑、BLE 入站服务面、MCP 工具桥。
- mechanisms/blueos-platform-constraints.md — BlueOS 官方文档核对出的平台硬约束（无常驻进程、无端口监听、app.ux 即首页、后台运行需商务开通等）。

> 新增机制文档时在此追加索引，并保持与 `mechanisms/README.md` 一致。
> 新增机制文档必须按 `mechanisms/README.md` 的七段强制结构编写（结论 → 涉及对象 → 运行链路 → 使用点 → 修改点 → 关键约束 → 维护方式），并遵守禁止写入内容清单。
> 示例格式：`- mechanisms/<topic>.md — 一句话说明覆盖范围。`

完成分析、梳理、排障复盘、架构理解或项目链路确认后，如果产生了可复用的系统事实，
必须按七段强制结构新增或更新相关机制文档，并同步更新本节与 `mechanisms/README.md` 的索引。

## 7. 开发计划目录

`.agent-rules/dev-plans/` 集中存放本项目进行中或近期要做的开发计划文档：

- 本目录文档描述"本期要把系统改成什么样"（流动的实施计划）；`.agent-rules/mechanisms/` 的机制文档描述"系统是什么样"。
- 每份开发计划顶部链接到配套机制文档；机制约束、协议契约、风险条款都在机制文档里，不要在计划文档里重复。
- 命名约定、结构要求、归档流程见 `dev-plans/README.md`。
- 涉及开发计划的任务必须先读 `dev-plans/` 下相关文档，再读 `mechanisms/` 下配套机制文档。

## 8. 会话交接目录

`.agent-rules/handoffs/` 存放跨会话接力摘要：

- 当用户说"继续""接着做""提交刚才的改动""根据上次状态处理"等延续性任务时，必须先读取本目录最新的相关交接摘要。
- 交接摘要只记录接力状态，不替代 `rules/`、`mechanisms/`、`dev-plans/`。
- 当交接摘要中的内容变成稳定机制或长期规则，应分别沉淀到 `mechanisms/` 或 `rules/`。

## 9. 维护规则

- 新的项目级 Agent 规则添加到 `.agent-rules/rules/`。
- 每当 Agent 完成分析、梳理、排障复盘、架构理解或项目链路确认任务后，若得到了后续开发或维护可复用的稳定事实，必须新增或更新 `.agent-rules/mechanisms/` 下的机制文档。
- 新的稳定机制梳理添加到 `.agent-rules/mechanisms/`，并同步更新 `mechanisms/README.md` 与本文件 §6 的索引。
- 新的开发计划添加到 `.agent-rules/dev-plans/`。
- 新的跨会话接力摘要添加到 `.agent-rules/handoffs/`。
- 目录中文档过多时，必须维护父级索引、拆分主题子目录，并在子目录内放置 `README.md`；查找时先读索引，不逐个文件盲找，不全量读取。
- 桥接文件保持简短，只指向 `.agent-rules/`，不要复制完整规则。默认只有 `AGENTS.md` 和 `CLAUDE.md`；其他 Agent 桥接入口按需创建，仅在默认两个不覆盖时才生成。
- 不同 Agent 入口只允许文件名和宿主适配说明不同，不允许维护多套规则正文。
- Agent 记忆只记录"应读取 `.agent-rules/`"和规则目录位置，不复制规则正文。
- 当出现长期有效的架构决策或项目发现时，优先更新 `rules/` 或 `mechanisms/`；如需记忆，只写索引指针。
- 改动必须围绕用户请求，不要借规则维护做无关重构。

## 10. 项目架构文档

本项目**只做 BlueOS**——唯一目标平台（见根 `ARCHITECTURE.md` §一）。采用两层结构：

| 层 | 目录 | 职责 |
|---|---|---|
| Layer 1 (契约) | `common/` | 对外契约：协议、身份模型、能力定义（外部生态按此接入） |
| Layer 2 (实现) | `blueos/` | BlueOS Agent 实现（唯一实现） |

项目愿景：全设备 Agent 生态（手机 → 车机 → 电脑 → 手表 → 服务器 → 眼镜）。
