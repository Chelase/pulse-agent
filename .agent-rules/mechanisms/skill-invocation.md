# Skill 调用机制

## 结论

skill 是给 LLM 的程序性知识（何时做、按什么步骤做），以 `SKILL.md` 目录格式存放。frontmatter 常驻 system prompt 用于触发匹配，Markdown 正文只在 trigger 命中时注入，控制手表上的上下文与功耗成本。

## 涉及对象

| 对象 | 角色 |
| --- | --- |
| `common/skills/README.md` | 格式约定（frontmatter 字段、渐进式披露、覆盖方式、默认 skill 清单） |
| `blueos/src/assets/skills/<name>/SKILL.md` | skill 原文，人读与生态复制的来源 |
| `blueos/src/assets/skills/index.js` | 由 `scripts/sync-skills.js` 生成的模块，内嵌 SKILL.md 原文 |
| `scripts/sync-skills.js` | 生成器；改完 SKILL.md 必须重跑 |
| `blueos/src/agent-core/skill-registry.js` | frontmatter 轻量解析、加载、触发匹配、落盘与覆盖 |
| `blueos/src/agent-core/agent-loop.js` | `_skillBlock` 注入；事件路径用 `match(conditionId)`，对话路径用 `matchText(text)` |
| `blueos/src/platform/storage.js` | `ensureDir` + 文件读写，覆盖文件的落地通道 |
| `internal://files/agent/skills/<name>/SKILL.md` | 覆盖位置；存在即以它为准 |

## 运行链路

```
启动（runtime.start 的 skillRegistry.init 步骤）
  └─ SkillRegistry.init()
       ├─ _seedBuiltins()：逐个内置 skill，若 internal://files 无同名文件则
       │     ensureDir('skills/<name>') + writeFile(原文)
       └─ 逐个 SKILLS 条目：
            _loadOverride(id) 读 internal://files/agent/skills/<id>/SKILL.md
              ├─ 有内容 → 用它（source='override'）
              └─ 无内容 → 用内嵌原文（source='builtin'）
            parseFrontmatter(raw) → { meta, body }
            组装 { id, name, description, triggers, toolsAllowed, body, source }

调用时注入（agent-loop）
  ├─ 事件路径 handleEvent(event)
  │    └─ match(event.conditionId)   ← triggers 精确匹配闸门条件 id
  └─ 对话路径 handleUserInput(text)
       └─ matchText(text)            ← skill 名或任一 trigger 出现在文本里
  └─ _skillBlock(hit)
       ├─ 恒常：getFrontmatterBlock()  ← 所有 skill 的 name + description + triggers
       └─ 命中：+ 「当前适用技能：<name>」 + body 全文
  └─ 拼进 system prompt（事件路径与对话路径各一份）
```

`parseFrontmatter` 支持的写法（不引入 YAML 依赖）：

```
name: xxx                  → 标量
triggers: [a, b]           → 行内列表
tools_allowed:             → 块状列表
  - vibrate
```

## 使用点

- `runtime.js` 构造：`new SkillRegistry()`，作为第三个参数传给 `AgentLoop`。
- `runtime.js` `start()` 的 `skillRegistry.init` 步骤（在 `agentLoop.init` 之后）。
- `agent-loop.js` `_buildMessages(text)` 与 `handleEvent(event)`：两处调用 `_skillBlock`。
- `agent-loop.js` `_skillBlock`：`this.skills` 为空时直接返回空串，主链路不受影响。

## 修改点

| 要做什么 | 改哪里 | 怎么改 |
| --- | --- | --- |
| 新增 skill | `blueos/src/assets/skills/<name>/SKILL.md` | 建目录写文件，`triggers` 填闸门条件 id；然后跑 `node scripts/sync-skills.js` |
| 改已有 skill | 同上 | 改完必须重跑 `node scripts/sync-skills.js`，否则运行时仍用旧的内嵌副本 |
| 改格式约定 | `common/skills/README.md` + `skill-registry.js` 的 `parseFrontmatter` | 约定与解析器必须同步改 |
| 不重新打包改 skill | 手表 `internal://files/agent/skills/<name>/SKILL.md` | 直接覆盖文件，重启生效 |
| 调整注入时机 | `agent-loop.js` 的 `_skillBlock` / `match` / `matchText` | 三条路径要一起看 |
| 新增触发维度 | `skill-registry.js` 的 `match` / `matchText` + `common/skills/README.md` | 例如按数据类型或时间段匹配 |

## 关键约束

1. **`index.js` 是生成物，不要手改。** 改 SKILL.md 后必须重跑 `node scripts/sync-skills.js`，否则改动不生效。
2. **必须内嵌而不是运行时读 assets。** BlueOS 运行时无法直接读取打包进 assets 的文本文件，生成模块是唯一稳定可用的加载方式。
3. **frontmatter 常驻、正文按命中注入。** 不要把所有 skill 正文都塞进 system prompt——手表上下文与功耗预算撑不住。
4. **覆盖以文件为准。** `internal://files` 同名文件存在时，内置副本完全不再生效；覆盖文件写坏了会导致该 skill 失效，而不是回退。
5. **skill 不引入新的执行机制。** 工具执行仍走 `tool-registry`，skill 只提供「何时做、按什么步骤做」。
6. **`_seedBuiltins` 只在文件不存在时写入。** 不会覆盖用户已有的改动。
7. **`tools_allowed` 当前只是文档字段**，不做强制限制；引入权限分档时才会生效。

## 维护方式

- **新增 skill**：在 `blueos/src/assets/skills/<name>/` 建 `SKILL.md`（frontmatter 四字段），跑 `node scripts/sync-skills.js`，确认日志列出该文件。
- **排查「skill 没生效」**：依次看 `[SkillRegistry] loaded N skills:`（是否加载到）、`[AgentLoop] skill hit: <id>`（是否命中）、`[SkillRegistry] seeded skill file:`（覆盖文件是否落地）。命中但行为不符，多半是改完 SKILL.md 忘了重跑生成脚本。
- **排查「覆盖没生效」**：确认 `internal://files/agent/skills/<name>/SKILL.md` 存在且 frontmatter 合法；文件损坏时不会回退到内置副本。
- **验证**：制造一个命中 triggers 的事件，确认日志出现 `[AgentLoop] skill hit:`，且事件输出遵循 skill 声明的边界（例如不含疾病判断）。
- **引入社区 skill**：先看 License（OpenMinis GPLv3 / Operit LGPL-3.0 / rikkahub AGPL-3.0），再按 frontmatter 约定补齐 `triggers`。

> 更新时间：2026-09-14
