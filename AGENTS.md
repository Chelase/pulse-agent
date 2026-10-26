# AGENTS.md

本文件是 Codex 和其他 Agent 的桥接入口，不重复维护完整规则。

在本项目开始分析、编辑、测试、评审或提交准备之前，必须先读取：

1. `.agent-rules/README.md`（规则读取链路总纲）
2. `.agent-rules/` 下实际存在的全部项目规则和相关机制文档
3. `ARCHITECTURE.md`（架构方案与关键决策）
4. `README.md`（项目概览）
5. 与任务相关的其他项目文档

项目级规则统一维护在根 `.agent-rules/`。

## 规则优先级

1. 系统或宿主工具指令。
2. 用户当前明确提出的要求。
3. 根 `.agent-rules/rules/` 下的项目规则。
4. 根 `.agent-rules/mechanisms/` 下的稳定机制文档。
5. 本文件或其他 Agent 桥接文件中的摘要说明。
6. 其他项目文档。

## 项目速览

pulse-agent 是一个**独立的手表 Agent 实现**，目标平台只有 vivo 蓝河 BlueOS：脱离任何生态可完整执行；对外契约使其可被外部生态发现与接入（可选，生态连接由外部实现）。采用两层结构：

- `common/` — 对外契约层（协议契约、身份模型、能力定义），外部生态按此接入
- `blueos/` — BlueOS 实现层（JS + .ux），唯一实现

详细架构见 `ARCHITECTURE.md`。
