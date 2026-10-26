# Skill 格式约定

本目录定义手表 Agent 的 skill 格式约定。**本目录只放约定文档，不放具体 skill 文件。**

## skill 是什么

**skill 是给 LLM 的程序性知识——「何时做、按什么步骤做」；tool 是原子动作。**

- tool 回答「能做什么」：`get_heart_rate`、`vibrate`、`notification_send`
- skill 回答「该怎么做」：健康异常事件发生时，先补上下文、再区分异常与正常波动、
  提醒只写描述性提示、绝不给医疗建议

两者不重叠：skill 不引入新的执行机制，工具执行仍然走 `tool-registry`。

## 为什么用 SKILL.md 目录格式

不自造 JSON schema。采用 Claude / Codex / OpenClaw / Hermes / OpenMinis 通用的
`SKILL.md` 目录格式（YAML frontmatter + Markdown 正文），好处是**可以直接消费社区既有
技能库**，不用为手表单独维护一套生态。

## 文件布局

```
blueos/src/assets/skills/
├── index.js                        ← 由 scripts/sync-skills.js 生成，勿手改
└── health-alert-handling/
    └── SKILL.md                    ← skill 原文
```

**为什么有 `index.js`**：BlueOS 运行时无法直接读取打包进 assets 的文本文件，所以
`scripts/sync-skills.js` 把 SKILL.md 原文内嵌成可 `import` 的模块。SKILL.md 原文同时保留在
磁盘上，供人阅读、供生态复制、供覆盖时作模板。

```bash
# 改完 SKILL.md 后必须重新生成
node scripts/sync-skills.js
```

## frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | skill 标识，全局唯一，与目录名一致 |
| `description` | 是 | 一句话说明何时适用；**常驻 system prompt**，用于触发匹配 |
| `triggers` | 是 | 触发条件列表。**手表扩展**：填闸门条件 id（见 `common/models/gate-conditions.json`），事件路径按此命中 |
| `tools_allowed` | 否 | 该 skill 期望使用的工具，仅作文档与后续权限分档的依据，当前不强制限制 |

```markdown
---
name: health-alert-handling
description: 处理健康类闸门事件时的处置步骤，只给描述性提示，绝不给医疗建议
triggers:
  - sustained_high_heart_rate
  - low_heart_rate
tools_allowed:
  - get_heart_rate
  - notification_send
---

# 正文（Markdown）
```

## 渐进式披露（关键设计）

| 部分 | 何时进入上下文 |
|------|---------------|
| frontmatter（name + description + triggers） | **常驻** system prompt，用于触发匹配 |
| Markdown 正文（完整 instructions） | **仅 trigger 命中时**注入 |

手表功耗与上下文预算都紧，常驻全文不可接受。这个模式由 OpenMinis 验证。

## 触发方式

- **事件路径**：`event.conditionId` 命中 `triggers` 里的某一项 → 注入该 skill 正文。
- **对话路径**：用户文本里出现 skill 的 `name` 或任一 `trigger` 字符串 → 注入该 skill 正文。
  手表不做交互输入，这条路径主要用于外部程序化调用。

## 覆盖：改 skill 不必重新打包

首次启动时，`SkillRegistry` 会把内置 skill 原文落盘到：

```
internal://files/agent/skills/<name>/SKILL.md
```

之后同名文件存在即以**文件为准**，内置副本不再生效。改 skill 只需替换这个文件，不用重新
构建 `app.rpk`。

## 当前默认 skill

| skill | 触发 | 作用 |
|-------|------|------|
| `health-alert-handling` | `sustained_high_heart_rate` / `low_heart_rate` / `low_blood_oxygen` | 健康异常事件的处置步骤与表达边界 |

## 引入社区 skill 前先看 License

OpenMinis 为 GPLv3、Operit 为 LGPL-3.0、rikkahub 为 AGPL-3.0。借鉴设计无碍；直接复制
skill 文件需遵守其各自协议。

> 相关机制文档：`.agent-rules/mechanisms/skill-invocation.md`
