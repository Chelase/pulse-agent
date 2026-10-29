# Agent Harness 分层（提示组装 / 工具权限 / 输出治理）

## 结论

Agent 的系统提示由 `PromptAssembler` 分节组装，工具按 `permission` 分为读写两级并由 `ToolRegistry.execute` 统一裁决，工具结果进入模型上下文前统一经 `formatToolResult` 截断；三者共同保证「模型看到的提示可控、工具调用有边界、上下文不会被单次输出挤爆」。

## 涉及对象

| 对象 | 角色 |
| --- | --- |
| `blueos/src/agent-core/prompt-assembler.js` | 系统提示分节容器：按 `order` 排序、重名抛错、空节跳过 |
| `blueos/src/agent-core/runtime-environment.js` | 运行环境快照文案生成（就绪态、时间、工具数、技能数、待办数） |
| `blueos/src/agent-core/tool-output.js` | 工具结果回填前的体积治理（超限截断 + 标记） |
| `blueos/src/agent-core/tool-registry.js` | 工具注册表；持有 `permission` 字段，执行前裁决、异常包装 |
| `blueos/src/agent-core/agent-loop.js` | 组装调用方：`_systemPrompt` / `_executeTool` / `_runLoop` |
| `blueos/src/agent-core/runtime.js` | 注入真实运行环境；`_environmentSnapshot()` 是快照原料的唯一真来源 |
| `blueos/src/agent-core/context-manager.js` | 对话历史的条数与体积双上限 |
| `scripts/local-test/harness-layer.test.mjs` | P0/P1 验收用例 |

## 运行链路

```
runtime 构造
  └─ agentLoop.setEnvironmentProvider(() => this._environmentSnapshot())
       ↑ 就绪态 / 工具数 / 技能数 / 待办数的真实来源

AgentLoop._systemPrompt(base, skillHit)
  ├─ capabilities = 工具清单 + skill frontmatter 常驻块
  ├─ environment  = environmentSnapshot(provider ? provider() : 兜底计数)
  ├─ assembled    = PromptAssembler.assemble({environment, capabilities})
  │                persona(10) → environment(20) → capabilities(30) → rules(50)
  └─ 返回 [assembled, base(对话或事件协议), _skillBlock(hit)] 按序拼接

AgentLoop._runLoop / stepTask
  └─ tools.execute(name, params, {kind})
       ├─ 工具不存在 → {status:'rejected', reason:'unknown_tool'}
       ├─ kind==='event' 且 permission==='write' → {status:'rejected', reason:'event_policy'}
       ├─ 工具抛异常 → {status:'error', reason:'tool_error', message}
       └─ 正常返回
  └─ formatToolResult(result) → 回填给模型（>4000 字符则截断并标记 truncated）
```

工具 `permission` 现状：内置 `file_read` / `get_heart_rate` / `get_step_count` / `get_sensor_data` 为 `read`；`file_write` / `notification_send` / `vibrate` 为 `write`。外部工具经 `registerProxy` 注册，默认 `ask`。

事件判定后的落地动作（`_emitVerdict`）以 `{kind:'runtime'}` 执行，因此**不受**事件写入禁令约束——禁令只针对模型在事件上下文里自行发起的写入。

## 使用点

- `agent-loop.js` `_systemPrompt`：对话入口（`handleUserInput` / `_buildMessages`）、事件入口（`handleEvent`）、落盘任务（`_prepareMessages`）三条路径都经它组装系统提示。
- `agent-loop.js` `_executeTool`：工具调用的唯一出口；`tool-registry.execute` 只在其他模块直接调用时才绕过它。
- `runtime.js` 构造器：`setEnvironmentProvider` 的唯一注入点。
- `context-manager.js` `_trim`：`addMessage` 每次落 KV 前调用。

## 修改点

| 要做什么 | 改哪里 | 怎么改 |
| --- | --- | --- |
| 增删系统提示分节 | `prompt-assembler.js` 的 `createPromptAssembler()` | 加 `{name, order, render}`；`name` 必须唯一，否则构造即抛错 |
| 改运行环境字段 | `runtime-environment.js` 的 `environmentSnapshot` + `runtime.js` 的 `_environmentSnapshot()` | 两处同时改：文案生成与原料来源 |
| 改工具输出上限 | `tool-output.js` 的 `MAX_TOOL_RESULT_CHARS` | 默认 4000；截断后必须保留 `status` 与 `note` |
| 给工具分级 | `tool-registry.js` 注册时的 `permission` | `read` / `write` / `ask`；`ask` 不受事件禁令拦截 |
| 放开某类事件的写入 | `tool-registry.js` `execute` 的事件分支 | 事件上下文下的写入一律拒绝，需要放开只能改判定条件 |
| 改对话历史上限 | `context-manager.js` 构造参数 | `maxMessages`（条数）与 `maxChars`（体积）分别生效 |

## 关键约束

1. `ToolRegistry.execute` **不抛异常**。未知工具、事件写入、工具内部异常都必须返回带 `status` / `reason` 的结构，异常只作为 `message` 字段回填给模型。
2. 拒绝结果**必须回填给模型**，不能静默丢弃——否则模型会以为自己调成功了，编造结论。
3. `PromptAssembler` 的分节 `name` 唯一性在构造期校验，不在组装期；重名直接抛错。
4. 运行环境快照只能来自 `runtime._environmentSnapshot()`；`agent-loop` 里的兜底分支（工具/技能计数）仅用于未注入时的退化，不得当成真实状态。
5. 上下文体积上限只丢**最旧的整条**消息，不截断单条内容；最后一条永远保留。
6. 事件路径的工具步数硬顶是 2（`EVENT_STEP_HARD_LIMIT`），与对话路径的 50 不同——事件追求低延迟低功耗。

## 维护方式

- **新增提示分节**：在 `createPromptAssembler()` 加一节并给唯一 `name` 与 `order`；用 `order` 控制位置，数值不要复用。
- **排查「模型看到的工具不对」**：看系统提示里的「可用工具列表」段是否含目标工具；工具由 `tool-registry.getTools()` 汇总，外部工具还要确认 `mcpClient.registerTools` 成功。
- **排查「事件没发通知」**：事件里模型自行调 `notification_send` 会被 `event_policy` 拒绝（写入类工具）。这是预期行为，落地通知由 `_emitVerdict` 以 `kind:'runtime'` 发出。
- **排查「上下文写爆 KV」**：看 `context-manager` 的 `_trim` 是否生效；条数与体积是两个独立上限，调小 `maxChars` 会先丢旧消息。
- **验证**：桩测 `node scripts/local-test/run.mjs`，其中 `harness-layer.test.mjs` 覆盖 P0（工具拒绝/异常/事件写入禁令/拒绝回填）与 P1（分节排序、提示内容、输出截断、环境快照、上下文体积上限）。

> 更新时间：2026-10-29
