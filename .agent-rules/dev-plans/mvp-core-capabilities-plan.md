
> **配套机制文档**：`.agent-rules/mechanisms/blueos-agent-runtime.md`（现有运行时装配与调用链路）。
> **架构**：`ARCHITECTURE.md`；**上一版 MVP 计划**：`blueos-agent-mvp-plan.md`（本计划重排其 Phase 2–4）。

## 背景与重排理由


- 原 Phase 3（UI 层）整体推迟，现有状态页维持现状即够用；
- 原 Phase 2（事件驱动链路）并入「Agent 执行能力」主线——它是手表形态的命脉；


## 当前阶段


## 一、主线与顺序

```
Step 0  真机基线 + 版本化        ← 解锁一切验证，其他步骤都依赖它
Step 1  Agent 执行能力：多步工具循环
Step 2  Agent 执行能力：事件驱动链路（原 Phase 2）
Step 3  Skill 调用机制
```

依赖关系：Step 1 的循环是 Step 2/3 的执行底座；Step 4 依赖 Step 2 的 `handleEvent` / 现有 `handleUserInput` 稳定后才能包装成对外任务接口。Step 3 与 Step 4 的契约层（schema / 能力声明）可并行先行。

## 二、步骤

### Step 0 — 真机基线 + 版本化（前置）

**改动文件**：无代码改动；`git init` + 按中文约定式提交规则建立版本基线。

**要做**：
1. `git init`，现有代码与文档全量首次提交（`chore: 初始化仓库` 类粒度可拆几笔）。
2. BlueOS Studio 构建 `app.rpk`，模拟器/真机安装启动；按 `mechanisms/blueos-agent-runtime.md` 的排查方法确认九步启动全过。
3. 通过 `scripts/llm-config.js` CLI 或 Web 配置服务写入本地配置，用 `sync-simulator` 同步到模拟器，再观察一次 LLM 往返。

**验收**：日志看到 rootId 打印、`[Runtime] step9` done；执行层日志确认配置文件加载，连接测试或一次 Agent 请求返回非空结果。

### Step 1 — 多步工具循环（执行能力核心）

现状缺口：`agent-loop.js` 一次 LLM 调用最多执行一个工具就结束，工具结果不回填，不是真正的 Agent 循环。

**改动文件**：
- `blueos/src/agent-core/agent-loop.js` — `_processReply` 改为有界 ReAct 循环
- `blueos/src/agent-core/llm-client.js` — `max_tokens` 256 → 512 并可由 `llm_config` 覆盖

**关键设计**：
- 循环：LLM 回复含工具调用 → 执行 → 结果作为消息回填 → 再调 LLM → 直到无工具调用或达步数上限（对话路径上限 4，事件路径上限 2，功耗约束）。
- 工具调用沿用提示词 + JSON 解析（不依赖各家 OpenAI 兼容端点的 function-calling 差异）；原生 `tools` 参数作为后续增强选项。
- 最终回复必须落一条自然语言结论进上下文，不是裸的工具执行结果。

**验收**：构造需两个工具串联的请求（如「查心率，若高于 100 就写文件并振动」），日志可见 ≥2 次工具调用且最终回复是结论性文本。

### Step 2 — 事件驱动链路（手表形态命脉，原 Phase 2）

现状缺口：sensor/health 回调只更新内存 state，没有任何路径通向 agentLoop，闸门求值器不存在——Agent 永远不会被传感器唤醒（`ARCHITECTURE.md` §三已知偏差）。

**改动文件**：
- `blueos/src/agent-core/gate-evaluator.js`（新增）
- `blueos/src/agent-core/agent-loop.js` — 增加 `handleEvent(event)`
- `blueos/src/agent-core/sensor-bridge.js` / `health-bridge.js` — 回调接闸门
- `blueos/src/agent-core/runtime.js` — 装配 gateEvaluator
- `blueos/src/manifest.json` — `background.features` 补齐 sensor/health
- `.agent-rules/mechanisms/event-gate-chain.md`（新增，七段结构）

**关键设计**：
- 闸门求值器只做单信号比较（`dataType` + `operator` + `threshold` + `sustainedSeconds` + `cooldownSeconds`），条件集读 `common/models/gate-conditions.json` 默认内嵌、预留文件覆盖；不做 AND/OR（架构已决策）。
- `sustainedSeconds` 用「越限起始时间戳」实现：采样越限记起点，回到阈值内重置；`cooldownSeconds` 按 condition 记最近触发时间，进程重启归零（MVP 可接受）。
- `handleEvent` 与 `handleUserInput` 平行：事件走独立轻量上下文（system + 事件载荷），**不写对话历史**；system prompt 要求输出「面向用户的简短提醒 + 是否振动」。
- 事件路径默认产出走 `notification_send` + `vibrate`。

**验收**：真机运动或注入测试事件制造持续高心率，看到 事件 → 闸门 → LLM → 振动/通知 完整链路；同条件在冷却期内不重复触发。

### Step 3 — Skill 调用机制

定位：**skill 是给 LLM 的程序性知识**（何时做、按什么步骤做），tool 是原子动作。

**格式对齐 SKILL.md 生态（2026-09-13 调研后定稿）**：不自造 JSON schema，采用 Claude / Codex / OpenClaw / Hermes / OpenMinis 通用的 `SKILL.md` 目录格式（YAML frontmatter + Markdown 正文），可直接消费社区既有技能库。

**改动文件**：
- `common/skills/README.md`（格式约定：frontmatter 字段 = `name` / `description` / `triggers`（手表扩展：事件类型匹配）/ `tools_allowed`）
- 默认 skill 1–2 个（SKILL.md 目录），如 `health-alert-handling`（先查数据 → 描述性提示 → 绝不给医疗建议）
- `blueos/src/agent-core/skill-registry.js`（新增，含轻量 frontmatter 解析）
- `blueos/src/agent-core/agent-loop.js` — `_buildMessages` 注入命中 skill

**关键设计（渐进式披露，OpenMinis 验证过的模式）**：
- frontmatter（name + description + triggers）**常驻** system prompt，用于触发匹配；
- Markdown 正文（完整 instructions）**仅在 trigger 命中时**注入——控制上下文成本，手表功耗预算下尤其重要；
- skill 目录默认打包进 `blueos/src/assets/`，预留 `internal://files` 同名覆盖（改配置不重新打包）；
- 工具执行仍走 `tool-registry`，skill 不引入新执行机制；

**验收**：健康异常事件触发时，LLM 的行为步骤与 skill 声明一致，且输出为描述性提示而非医疗建议。


**改动文件**：
- `blueos/src/agent-core/runtime.js` — 增加 `handleExternalRequest(task)`
- `common/capabilities/watch-capabilities.json` — 收敛与被动形态一致

**关键设计**：
- `handleExternalRequest` 是对外统一任务入口：包装 agent-loop，产出 `{task_id, status, result}`；`handleUserInput` 语义并入其中。
- transport 仅 HTTP `fetch`（已在 background.features）；WebSocket 长连接推迟。
- 能力声明修正：`agent_conversation` 现描述「抬腕即达的对话、voice 输入」与「手表不做交互输入」决策冲突，改为被动任务执行/提醒类表述。

**验收**：mock hub 日志看到注册 + 心跳；从 mock hub 下发一个任务，手表执行并回传结果。

## 三、总验收清单

- [x] 仓库已 `git init` 并有版本基线
- [ ] 真机启动全过，rootId 打印 ← **唯一阻塞项，需真机**
- [ ] LLM 直连真机可用（一次完整对话往返）← 需真机
- [x] 多步工具循环：≥2 个工具串联任务正确完成（本地桩验证，14 项断言）
- [x] 事件链路：持续高心率触发 闸门 → LLM → 振动/通知，冷却期内不重复（本地桩验证，23 项断言）
- [x] skill 注入生效：命中时注入声明步骤，未命中只常驻 frontmatter（本地桩验证，26 项断言）
- [x] mock hub：注册 + 能力声明 + 心跳 + 任务下发 → 结果回传 全流程（本地桩验证，16 项断言）

> 说明：原清单写「两份机制文档」。实施中发现 skill 机制同样满足 `rules/complex-feature-mechanism.md`
> 的触发条件（assets 生成物 → registry → agent-loop → storage 四处穿插），故按规则增补为三份。

## 四、不在本期做的事

| 事项 | 理由 |
|------|------|
| UI 增强 / Widget / 表盘（原 Phase 3） | 用户定调面板 UI 不重要；现有状态页够用 |
| 传感器原始数据上行（heart-rate / activity 上报接口） | 先保事件级互通，数据流后续再做 |
| WebSocket 长连接 | 需后台常驻，功耗不划算；契约保留 |
| 语音 / 视觉 / 端侧 LLM | 非 MVP 必需 |

## 五、风险与应对

| 风险 | 应对 |
|------|------|
| BlueOS 后台对 sensor/health 订阅的保活策略未知 | Step 2 真机优先验证；声明式闸门可翻译为系统低功耗阈值检测，作为兜底方案 |
| 电量查询 API 不可得 | 心跳 `battery_level` 置 -1 并在契约标注 unknown |
| 手表直连 LLM API 在目标网络不可用 | Step 0 最先验证；不可用则触发评估降级路径优先级（违反本期边界，需重新决策） |

## 六、外部参考（2026-09-13 手机 Agent 调研）

调研对象：[OpenMinis](https://github.com/OpenMinis/OpenMinis)（iOS/Android 端侧 Agent）、[Operit](https://github.com/AAswordman/Operit)（Android Agent 平台）、[rikkahub](https://github.com/rikkahub/rikkahub)（Android LLM 客户端）。三者均为手机侧 Kotlin/Swift 实现，**代码不可直接移植**（BlueOS 是 JS 运行时）；可搬的是设计与契约。

| 来源 | 借鉴点 | 落到哪 |
|------|--------|--------|
| OpenMinis | SKILL.md 目录格式 + 渐进式披露（frontmatter 常驻、正文按命中加载）；与 Claude/Codex/OpenClaw/Hermes 技能生态兼容 → 可直接消费社区技能库 | Step 3（已采纳，见上） |
| OpenMinis | 设备能力全部封装为工具（健康/日历/提醒/闹钟/联系人…）的清单式做法 | Step 1 后续扩工具时对照 |
| Operit | 触发器分类：传感器事件之外还有定时、系统事件（亮屏/充电/Intent） | Step 2 后续扩展：闸门输入源增加系统事件/定时 tick |
| Operit | 工具权限三档（自动/询问/禁止）→ 手表无 UI 可询问，简化为静态 per-tool 分档 | Step 1 可选项：tool-registry 加 `permission` 字段 |
| Operit | 上下文溢出自动总结（替代硬截断）；按任务分模型（便宜模型跑事件、强模型跑对话） | 后续：context-manager 升级、`llm_config` 扩展 |
| rikkahub | 提示词变量（时间/模型名注入 system prompt）；MCP 客户端（仅 HTTP 型可行） | 提示词变量 Step 1 顺手可做；MCP 远期可选，功耗存疑 |

**明确不搬**（与手表形态或离线自治原则冲突）：Linux 沙箱/终端（proot/iSH/Alpine）、浏览器自动化、无障碍 UI 自动化、本地 LLM（MNN/llama.cpp，违反离线自治原则）、语音 STT/TTS 管线、角色卡/多角色群聊、聊天式 UI。

**License 提示**：借鉴设计无碍；直接复制代码需遵守各自协议（OpenMinis GPLv3、Operit LGPL-3.0、rikkahub AGPL-3.0）。JS 移植场景基本不触发，引入社区 SKILL.md 技能文件时逐个看其 License。

## 七、进度

| 步骤 | 状态 |
|------|------|
| Step 0 真机基线 + 版本化 | **部分完成**：Git 基线已建立；真机启动验证仍待做 |
| Step 1 多步工具循环 | **已实现，待真机验证** |
| Step 2 事件驱动链路 | **已实现，待真机验证** |
| Step 3 Skill 调用机制 | **已实现，待真机验证** |

> 更新时间：2026-09-14

## 八、实施记录（2026-09-14）

四步代码全部落地，各自独立提交。本地桩测试覆盖 175 项断言全过；**真机验证仍是唯一未清的阻塞项**。

| 提交 | 内容 |
|------|------|
| `feat(agent-core): Agent 主循环改为有界 ReAct 多步工具循环` | Step 1 |
| `feat(agent-core): 接通事件驱动链路，Agent 可被传感器唤醒` | Step 2 |
| `feat(agent-core): 引入 SKILL.md 格式的 skill 调用机制` | Step 3 |

实施中偏离原计划的决定，需复核：

1. **skill 加载方式**：BlueOS 运行时读不到打包进 `assets` 的文本文件，故新增
   `scripts/sync-skills.js` 把 `SKILL.md` 原文生成成可 `import` 的 `assets/skills/index.js`。
   原文保留在磁盘上，改完必须重跑生成脚本。若后续确认 BlueOS 有可用的资源读取 API，可去掉这一步。
2. **事件产出形式**：`handleEvent` 采用「约定 JSON `{notify, vibrate}` + agentLoop 落地通知/振动」，
   而非让模型自己调两次工具——单次回复只能带一个工具调用，走工具会多吃一轮 LLM 调用。
3. **心跳捎带任务**：本期无长连接，任务下发改为「心跳响应携带 `tasks[]`」的轮询方式，
4. **能力声明收敛**：`agent_conversation`（含 voice 输入）替换为 `agent_task_execution`，
   移除 `watch_face_customization`，并给每项加 `status`。这是契约变更，需确认。
5. **`background.features`**：除 sensor / health 外还补了 notification / vibrator，
   因为事件路径的默认产出就在后台发通知与振动。feature 名称沿用顶层 `features` 的写法，
   **正确性需真机确认**。

## 九、仍未接通的数据源

闸门条件集里的 `low_blood_oxygen` 与 `battery_critical` 目前没有采样来源：
`health-bridge` 只订阅心率（`spo2` 字段无写入），也没有电量桥接。两条条件不会触发。

## 十、部署/调试配置入口（2026-09-15）

手表端 UI 已移除。模型配置属于仓库控制面：

- CLI：`node scripts/llm-config.js set/show/clear/sync-simulator`。
- Web：`node scripts/setup-server/server.js --host 0.0.0.0 --port 8790`，浏览器打开本地地址配置供应商、endpoint、API Key、model。
- 本地文件：`config/llm-config.local.json`（含 API Key，已忽略，不提交）。
- 模拟器同步：`sync-simulator` 将配置复制成 `llm-config.json` 到 BlueOS 模拟器 `internal://files/agent`，BlueOS 启动时优先读取该文件；没有同步文件时兼容 KV `llm_config`。
- 未配置：执行层照常启动，不发 LLM 网络请求；启动失败只通过 runtime 日志定位，不依赖手表页面显示。

架构边界：BlueOS 只承载无 UI 的执行层 Agent；详细链路见 `.agent-rules/mechanisms/llm-configuration.md`。

> 更新时间：2026-09-15
