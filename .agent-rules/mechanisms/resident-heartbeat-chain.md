# 常驻心跳与可重入任务链路

## 结论

蓝河没有常驻进程，本项目的「常驻」由平台定时任务按周期在后台拉起 `app.ux` 的心跳方法实现；任务进度落盘，一个后台窗口跑不完就留给下一次唤醒。

## 涉及对象

| 对象 | 角色 |
| --- | --- |
| `blueos/src/platform/schedule.js` | 包 `@blueos.app.appmanager.schedule`；`register({intervalMs, method})` 用 type=2 真实时间流逝，休眠也累计 |
| `blueos/src/app.ux` | `agentTick(params)` 是系统后台拉起的心跳方法；未就绪时先补一次 `start()`，并用 `_starting` 防并发重复启动 |
| `blueos/src/agent-core/heartbeat.js` | `TICK_METHOD='agentTick'`、`start()` 注册心跳、`tick()` 在 `budgetMs` 内推进队列；`ticking` 防重入；注册失败时降级为进程内 `setInterval`（`source='local-timer'`） |
| `blueos/src/agent-core/task-queue.js` | 任务队列，KV `agent_task_queue`；状态 pending/running/done/failed，`messages` 与 `stepsUsed` 是续跑游标 |
| `blueos/src/agent-core/jobs.js` | 定时任务表，KV `agent_jobs`；到期只负责入队，错过轮次不补跑 |
| `blueos/src/agent-core/agent-loop.js` | `stepTask(task)` 单步推进（一次 LLM 往返 + 本地工具），`_prepareMessages` / `_finalizeTask` |
| `blueos/src/agent-core/mcp-client.js` | HTTP JSON-RPC 接 MCP server，`tools/list` 结果经 `registerProxy` 并入工具清单 |
| `blueos/src/agent-core/tool-registry.js` | `registerProxy` / `has`，外部工具名带 `<server>__` 前缀 |
| `blueos/src/platform/ble-service.js` | BLE GATT Server 入站服务面；UTF-8 编解码 + 写订阅回执 + notify 回结果。**本机 SDK 不认该 feature，当前只能显式装配，不进 `runtime.start()`** |
| `blueos/src/agent-core/runtime.js` | `tick` / `submitTask` / `runTaskToCompletion` / `dueJobsToQueue` / `handleInboundCommand` / `getState().resident` |
| `blueos/src/manifest.json` | `features` 含 `blueos.app.appmanager.schedule`、`blueos.bluetooth.ble`；`permissions` 含 `blueos.permission.BLUETOOTH` |
| `scripts/local-test/resident.test.mjs` | 心跳参数、单步续跑、预算退出、BLE 往返、MCP 注册的桩测 |

## 运行链路

```
系统按 interval 后台拉起
  └─ app.ux agentTick(params)
       └─ ensureStarted()：getInstance() → 未 ready 则 start()（_starting 互斥）
            └─ runtime.tick() → heartbeat.tick()
                 ├─ ticking=true（重入则直接 skip）
                 ├─ runtime.dueJobsToQueue()   jobs.due() → taskQueue.enqueue → save
                 └─ while (elapsed < budgetMs)
                      ├─ taskQueue.next() 为空则结束
                      ├─ agentLoop.stepTask(task)
                      │    ├─ pending → _prepareMessages(kind) → status=running
                      │    ├─ stepsUsed >= budget → 追加「强制收口」消息
                      │    ├─ llm.chat(messages)
                      │    │    ├─ 网络异常 → 不判死，返回 false（下个窗口重试同一步）
                      │    │    ├─ 是工具调用 → stepsUsed+1 → tools.execute → 结果回填 messages
                      │    │    └─ 是最终文本 → _finalizeTask
                      │    │         ├─ kind=event → 解析 {notify,vibrate} → 通知 + 振动
                      │    │         └─ 其它 → context 写 user/assistant，task.result
                      │    └─ 返回是否「有进展」
                      ├─ task.updatedAt=now → taskQueue.save()   ← 跨唤醒续跑的唯一依据
                      └─ 无进展则 break（预算未到也不空转）

外部指令入站（两条路，都不依赖手表监听端口）
  ├─ BLE：对端写 cmd 特征 → ble-service._onWrite → sendResponse(status=0)
  │        → runtime.handleInboundCommand(text)
  │             ├─ submitTask(source='ble')
  │             ├─ runTaskToCompletion(task, 20s)  ← 超预算则返回 accepted
  │             └─ 结果 {task_id,status,result} → JSON → notifyCharacteristicChanged
```

## 使用点

- `app.ux agentTick` — 平台心跳唯一入口。
- `runtime.submitTask` — BLE 指令、手动提交、测试都走它入队。
- `runtime.jobs.add` — 对外暴露的定时任务登记面（当前由代码/配置调用，尚无外部下发通道）。
- `mcpClient.registerTools` — 启动第 8 步，把外部工具并进提示词工具清单。
- `bleService` — 仅当 KV `ble_config.enabled === true` 才创建 GATT Server 并广播。

## 修改点

| 要做什么 | 改哪里 | 怎么改 |
| --- | --- | --- |
| 改心跳周期/预算 | `runtime.js` 构造 `new Heartbeat(this)` 的 `intervalMs` / `budgetMs` | 周期越短越省电差；预算必须小于平台窗口时长 |
| 新增任务来源 | `runtime.submitTask` 的 `kind`/`source` | `kind='event'` 走事件 prompt 与 2 步预算，其它走对话 prompt 与 4 步预算 |
| 新增定时任务 | `agent-core/jobs.js` `add()` | 只写指令文本，不要在 job 里直接执行动作 |
| 让闸门事件也走队列 | `runtime._onSample` | 把 `agentLoop.handleEvent` 换成 `submitTask({kind:'event', event})` + `tick()`；注意 gate/runtime 两处桩测的时序断言 |
| 接入新 MCP server | KV `mcp_config.servers[]` | 只支持 HTTP 传输；单 server 失败只 warn |
| 改 BLE 特征布局 | `platform/ble-service.js` 的三个 UUID 常量与 `characteristics` | 对端需按同一 UUID；`properties` 字段形态未真机核对 |

## 关键约束

1. 心跳 `triggerMethod` 的方法名必须写在 `app.ux` 的导出对象上（平台按名字在后台拉起），`heartbeat.js` 的 `TICK_METHOD` 与 `app.ux` 方法名必须一致。
2. 只有 `stepTask` 会推进任务；`handleUserInput` / `handleEvent` 仍是一口气跑完的旧入口，两条路径并存，改动主循环时别只改一边。
3. 任务状态只认 KV `agent_task_queue`：进程被杀、系统回收后靠它续跑，因此每步之后必须 `save()`。
4. 队列有容量收敛（`MAX_TASKS=20`、消息 `MAX_QUEUED_MESSAGES=12`，保留首条 system），长任务靠裁中段而非无限写。
5. MCP 与 BLE 都是「配置门控 + 失败降级」：没配置就不启用，单个 server/服务面失败不得阻断 `start()`。
6. `manifest.json` 的 `features`/`permissions` 必须与代码 import 一一对应，漏声明在真机上 import 即失败。

## 维护方式

- **本地验证**：`node scripts/local-test/run.mjs`，其中 `resident.test.mjs` 用 `scheduleStub.bind('agentTick', ...)` 模拟后台拉起，并覆盖跨唤醒续跑。
- **排查「Agent 不动」**：先看 `[Heartbeat] 注册心跳 ... jobId=`（-1 表示注册失败，可能是平台定时任务已满）；再看 `[Heartbeat] tick#N {...} elapsed=`，`advanced=0` 且队列非空通常是预算太小或 LLM 未配置。
- **排查任务卡住**：读 KV `agent_task_queue`，看该任务的 `status`/`stepsUsed`/`messages` 尾部；`running` 但不前进多为 LLM 网络失败（按设计不判死，等下个窗口重试）。
- **排查 BLE 不响应**：确认 KV `ble_config.enabled=true`；看 `[BleService] GATT 服务已广播`；`addService 返回 false` / 写订阅失败会降级为仅外连模式。
- **模拟器已知现象**：`scheduleJob` 返回 `generic error (200)`，`Scheduler` 记 `jobId=-1` 后心跳自动降级为 `local-timer`（只在应用存活期间跳）。降级不影响队列续跑语义，但**不等于常驻成立**，真机能否注册成功仍待验。
- **真机首测项**：① 一次后台窗口实际可用时长；② `scheduleJob` 的最小允许 interval 与任务数量上限；③ GATT `characteristics.properties` 的真实字段形态；④ `notifyCharacteristicChanged` 的对端可见性。

> 更新时间：2026-09-29
