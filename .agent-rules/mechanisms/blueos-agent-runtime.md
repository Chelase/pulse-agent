# BlueOS Agent 运行时启动与对话链路

## 结论

BlueOS 手表 Agent 由 `AgentRuntime` 单例统一装配和启动，所有子系统（身份、上下文、LLM、工具、skill、闸门、传感器、健康、常驻心跳）都通过它初始化。手表端不提供交互 UI，但 `app.ux` 本身是平台要求的首页兼后台回调宿主——「无 UI」不等于「无页面」。

## 涉及对象

| 对象 | 角色 |
| --- | --- |
| `blueos/src/app.ux` | 应用入口，`onCreate` 里 `new AgentRuntime()` 并调用 `start()` |
| `blueos/src/agent-core/runtime.js` | 单例装配器 + 启动序列 + `getState()` / `handleUserInput()` / `handleExternalRequest()` / `_onSample()` |
| `blueos/src/agent-core/identity.js` | 生成/读取 deviceId，拼出 `blueos_watch:<id>` 形式的 rootId |
| `blueos/src/agent-core/context-manager.js` | 最近 10 条消息，整体读写一个 KV key |
| `blueos/src/agent-core/agent-loop.js` | 构造 messages → 有界 ReAct 循环 → 解析工具调用 → 执行 → 回填 → 收敛；含事件入口 `handleEvent` |
| `blueos/src/agent-core/llm-client.js` | 从 internal `llm-config.json` 或 KV `llm_config` 读配置；按 `apiMode` 选协议适配器发请求 |
| `blueos/src/agent-core/llm-adapters.js` | 三种请求协议适配器（openai-chat / anthropic-messages / openai-responses）；模式清单契约在 `common/models/api-modes.json`，两边 id 由桩测卡住不漂移 |

| `blueos/src/agent-core/tool-registry.js` | 7 个内置工具的注册与按名派发 |
| `blueos/src/agent-core/skill-registry.js` | SKILL.md 加载、frontmatter 解析、触发匹配、internal://files 覆盖 |
| `blueos/src/agent-core/gate-evaluator.js` | 闸门求值器，单信号比较 + 持续时长 + 静默期 |
| `blueos/src/agent-core/sensor-bridge.js` | 订阅佩戴/抬腕/计步，维护内存 state 并 `_emit` 采样 |
| `blueos/src/agent-core/health-bridge.js` | 订阅心率、拉今日步数，维护内存 state 并 `_emit` 采样 |
| `blueos/src/platform/storage.js` | KV + 文件双通道，文件统一落在 `internal://files/agent`；目录创建幂等（平台在目录已存在时会走 fail） |
| `common/models/gate-conditions.json` | 闸门条件契约（默认集内嵌在 `gate-evaluator.js`） |
| `blueos/src/agent-core/task-queue.js` | 落盘任务队列（KV `agent_task_queue`），跨唤醒续跑的状态载体 |
| `blueos/src/agent-core/jobs.js` | 定时任务表（KV `agent_jobs`），到期只入队不执行 |
| `blueos/src/agent-core/heartbeat.js` | 心跳注册与预算内推进；`TICK_METHOD='agentTick'` |
| `blueos/src/agent-core/mcp-client.js` | HTTP 型 MCP 客户端，外部工具并入工具清单 |
| `blueos/src/platform/ble-service.js` | BLE GATT 入站服务面（默认关闭） |
| `blueos/src/platform/schedule.js` | 平台定时任务封装（type=2 真实时间流逝） |
| `common/capabilities/watch-capabilities.json` | 对外能力声明，含 `runtime_model: resident-heartbeat` |
| `common/skills/README.md` | skill 格式约定（实际文件在 `blueos/src/assets/skills/`） |

> 常驻链路（心跳 → 单步续跑 → 入站指令）见 `resident-heartbeat-chain.md`；平台侧硬约束见 `blueos-platform-constraints.md`。

> 事件链路的完整流转见 `event-gate-chain.md`；skill 加载与注入见 `skill-invocation.md`。

## 运行链路

```
app.ux onCreate
  └─ new AgentRuntime()          （构造即装配全部子系统，写入模块级 _instance）
  └─ runtime.start()             （串行十一步，每步 5s 超时；关键步骤失败即停，
                                  其余步骤失败降级继续，最后再起引导）
       ├─ step1 identity.init       Storage.get(agent_device_id) → 无则生成并写回      [关键]
       ├─ step2 context.init        Storage.get(agent_context) → this.messages          [关键]
       ├─ step3 agentLoop.init      llm.init() → Storage.readFile(llm-config.json) 优先，否则 Storage.get(llm_config)  [关键]
       ├─ step4 skillRegistry.init  落盘内置 skill 到 internal://files，再逐个加载
       ├─ step5 gateEvaluator.init  尝试读 gate-conditions.json 覆盖，失败用内置集
       ├─ step6 taskQueue.init      从 KV agent_task_queue 恢复未跑完的任务
       ├─ step7 jobs.init           从 KV agent_jobs 恢复定时任务表
       ├─ step8 mcpClient.init      读 KV mcp_config → initialize + tools/list → registerTools
       ├─ step9 sensorBridge.start  逐个能力探测后 subscribe，缺失只 warn 不抛
       ├─ step10 healthBridge.start 心率 subscribe + _refreshSteps()
       ├─ step11 heartbeat.start    Scheduler.register({intervalMs, method:'agentTick'})，3s 不回调按失败降级
       └─ ready = 关键步骤全成功
  └─ configOnboarding.start()    与 ready 解耦：核心装配完成就出码（无 setupBaseUrl 则 phase=no-url）

首页状态面板（pages/index/index.ux）
  └─ 每秒读 runtime.getState()：ready / failedStep / steps / onboarding.phase
       ├─ 未就绪 → 「停在 <失败步骤>（已完成步数/总步数）」
       ├─ 有降级步骤 → 文案后附「降级 <步骤名>」
       └─ waiting → 渲染二维码 + 设备码

后台心跳（常驻的唯一落点，详见 resident-heartbeat-chain.md）
  └─ 系统按 interval 拉起 app.ux agentTick → runtime.tick() → heartbeat.tick()
       ├─ dueJobsToQueue()          到期 job 入队
       └─ while (elapsed < budgetMs) taskQueue.next() → agentLoop.stepTask(task) → save()

无交互 UI（但 app.ux 是平台首页）
  └─ app.ux 负责创建/启停 runtime，并承载 agentTick 心跳与通知按钮回调
  └─ 模型配置由仓库侧 `scripts/llm-config.js` CLI 或设备码 H5（`scripts/setup-server/`）完成

外部调用（程序化入口，非 UI；手表不提供输入界面）
  └─ runtime.handleUserInput(text)   ready=false 时直接返回“Agent 尚未就绪”
       └─ agentLoop.handleUserInput
            ├─ context.addMessage('user')  → _trim → _save（每条消息一次 KV 全量写）
            ├─ llm.isConfigured() false → 返回未配置提示，不请求网络
            ├─ _buildMessages(text)        system prompt + 工具清单 + skill 块 + 最近 8 条
            ├─ _runLoop(messages, 4)       有界 ReAct 循环，见下
            └─ context.addMessage('assistant', 结论文本)

_runLoop(messages, maxSteps)
  └─ 循环 maxSteps 次：
       ├─ llm.chat(messages) → 无工具调用 → 返回该内容作为最终回复
       └─ 有工具调用 → 执行 → 结果作为 user 消息回填 → 下一轮
  └─ 达防失控硬顶（`loop.stepHardLimit`，默认 50）→ 追加「已达步数上限，直接给结论」提示 → 再调一次 LLM 强制收口

传感器/健康事件（见 event-gate-chain.md）
  └─ bridge._emit(dataType, value) → runtime._onSample
       ├─ gateEvaluator.evaluate(dataType, value) → null 则丢弃
       └─ 跨门 → agentLoop.handleEvent(event) → _runLoop(messages, 2)
            └─ {notify, vibrate} → notification_send + vibrate

外部任务（外部生态经统一任务入口下发）
       └─ handleUserInput(instruction) → {task_id, status, result}
```

## 使用点

- `app.ux onCreate` — 前台启动点；`app.ux agentTick` — 后台心跳入口（两者都进 runtime）。
- `app.ux onCreate/onDestroy` — BlueOS 执行入口，启动和停止 runtime（含心跳注销）。
- `tool-registry.js` — 通过构造注入的 `fileManager` / `sensorBridge` / `healthBridge` 反向使用运行时子系统。
- `agent-loop.js` — 通过构造注入的 `skillRegistry` 注入 skill 块（可为 null，降级不影响主链路）。
- `runtime.js` 构造器 — 注入 `agentLoop.setEnvironmentProvider(() => this._environmentSnapshot())`，系统提示的「运行环境」段取真实就绪态与计数。提示分节与工具权限规则见 `agent-harness-layer.md`。
- `blueos/src/README.md` 记录程序化配置与 CLI/Web 控制面。

## 修改点

| 要做什么 | 改哪里 | 怎么改 |
| --- | --- | --- |
| 新增内置工具 | `agent-core/tool-registry.js` `_registerBuiltins()` | push `{name, description, parameters, execute}`；平台调用先落到 `platform/`，参数签名必须与 `platform/` 封装一致 |
| 新增闸门条件 | `common/models/gate-conditions.json` + `gate-evaluator.js` 的 `DEFAULT_CONDITIONS` | 两处同步；`cooldownSeconds` 必填 |
| 新增 skill | `blueos/src/assets/skills/<name>/SKILL.md` | 写完后跑 `node scripts/sync-skills.js` |
| 新增启动步骤 | `agent-core/runtime.js` `start()` 的 `steps` 数组 | 追加 `{name, fn}`；能失败但不该阻塞启动的步骤要在 `fn` 内部自行 catch |
| 配置自定义供应商 / endpoint / model | `scripts/llm-config.js` + `scripts/setup-server/` + `agent-core/llm-client.js` | CLI/H5 写配置；`sync-simulator` 复制为 internal `llm-config.json`；当前按 OpenAI-compatible Chat Completions 请求 |
| 换 LLM 协议 | `agent-core/llm-adapters.js` 加一个模式 + `common/models/api-modes.json` 加同 id 条目 | `chat()` 只按 `apiMode` 选路，不再改客户端；端点末尾路径由 `endpointSuffix` 约束控制面校验 |
| 调整循环步数 | `agent-loop.js` 的 `stepHardLimit` 实例字段（默认取常量 `TOOL_STEP_HARD_LIMIT = 50`） | 常规不做步数封顶，只留防失控硬顶；调小会提前强制收口，调大直接增加每次触发的 LLM 调用数，注意功耗 |
| 调整上下文长度 | `ContextManager` 构造参数与 `agent-loop.js` `getRecentMessages(8)` | 两处要一起看，`maxMessages` 是条数硬上限，`maxChars` 是体积上限（只丢最旧的整条消息） |
| 新增平台能力 | `blueos/src/platform/` 加封装 + `manifest.json` `features`/`permissions` | 未在 manifest 声明的 feature 在真机上 import 即失败 |
| 配置模型 | `scripts/llm-config.js` / `scripts/setup-server/server.js` | 在 CLI 或设备码 H5 修改，必要时 `sync-simulator` 到 internal 文件；不要在 BlueOS 增加配置页面 |

## 关键约束

1. `AgentRuntime` 是模块级单例：`new AgentRuntime()` 与 `getInstance()` 返回同一对象，构造函数在已有实例时直接 return，不要在构造里放二次初始化逻辑。
2. `start()` 是串行 + 每步超时的：单步 5s 不返回按失败处理（真机上出现过平台定时任务回调不来、启动永远停在这一步）。`identity.init` / `context.init` / `agentLoop.init` 三步失败即停止装配、`ready=false`、`failedStep` 记录失败步骤名；其余步骤（skill / 闸门 / 队列 / jobs / MCP / 传感器 / 健康 / 心跳）失败只降级，不阻断启动。`start()` 不再向外抛错，失败信息通过 `getState().failedStep` 与 `getState().steps` 暴露。MCP 客户端与心跳在内部处理各自的失败场景（未配置跳过、平台不可用降级）。
   引导 `configOnboarding.start()` 与 `ready` **解耦**：核心装配完成就启动，否则手表屏永远停在「启动中」，用户连配置入口都看不到。
3. 手表端不做交互 UI，但 `app.ux` 是平台定义的「应用首页」，缺失则应用无法启动，且心跳与通知按钮回调都挂在它上面；`pages/index` 现在是**首启配置面板**（设备码 + 二维码 + 启动状态），是手表上唯一的状态与排障读数面——`ready=false`、`failedStep`、降级步骤都显示在这里。`handleUserInput` 只保留为外部调用的程序化入口。
4. 传感器与健康数据只存在内存 state 里，进程重启即归零；落 KV 的只有 deviceId、上下文、`llm_config`、`setup_config`。
5. `platform/storage.js` 的文件接口全部相对 `internal://files/agent`，传入的 `path` 是相对路径、不可越界；**目录创建必须幂等**——平台在目录已存在时也会走 fail（消息形如「目录/文件 xxx 已经存在。」），`recursive: true` 也不例外，且错误码不固定。不能把 mkdir 的 fail 一律当错误，也不能靠具体错误码判断，必须用 `file.access` 复核。违反这条会让第二次启动、以及每次 `writeFile` 都抛错。
6. `manifest.json` 的 `features` 与代码 import 必须一一对应；`config.background.features` 已声明 fetch / sensor / health / notification / vibrator / schedule。注意官方 manifest 文档另有**顶层** `background` 字段（示例为 `{type:'health', patterns:['getRealtimeHeartRate']}`），与本项目 `config.background.features` 的关系尚未核对。

## 维护方式

- **新增机制**：先在 `platform/` 封装原生 API，再在 `agent-core/` 用封装，最后同步 `manifest.json`。
- **排查启动失败**：手表上没有控制台，直接看首页——`停在 <步骤名>（n/11）` 就是失败步骤，后面的错误细节看 `[Runtime] step<N> failed: <name>, error: ...`。也可看 `[Runtime] startup: ready|not ready, steps=n/11, failedStep=` 一行汇总。
- **排查「卡在启动中不动」**：整条链每步都有 5s 超时，卡住不再意味着永远不动；若首页步数停在中途且 `steps` 长度不变，说明该步正在等平台回调（历史上心跳注册就这样卡过，现已超时降级为进程内定时器）。
- **排查「Agent 未就绪」**：手表端无状态页面以外的入口，直接看首页的失败步骤名与 `[Runtime] startup:` 日志；LLM 未配置不是启动失败原因，只会让引导进 `no-url`。
- **排查文件类报错**：看到「目录/文件 … 已经存在。」说明有 mkdir 结果没被幂等处理；看到「目录不存在」说明父目录没先 `ensureDir`。
- **排查模拟器仍显示旧页面**：先检查 `blueos/src/` 是否无 `pages/`、`ui/`、`global.js` 且 `manifest.json` 无 router；再清理项目内被忽略的 `blueos/build/`，关闭并重新打开 BlueOS Studio，clean/rebuild/reinstall。不要直接删除用户 AppData 下的模拟器目录，除非明确确认要清理缓存。
- **验证**：BlueOS Studio 打开 `blueos/` 目录构建 `app.rpk`，真机看日志确认 rootId 打印、心率回调到达、`[Runtime] started` 出现。

> 更新时间：2026-10-29
