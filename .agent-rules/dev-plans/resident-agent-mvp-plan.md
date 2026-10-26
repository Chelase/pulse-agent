# 手表常驻式 Agent MVP — 开发计划

> **机制**：`.agent-rules/mechanisms/resident-heartbeat-chain.md`（运行链路）、`.agent-rules/mechanisms/blueos-platform-constraints.md`（平台硬约束）
> **配套**：`.agent-rules/mechanisms/blueos-agent-runtime.md`

## 当前阶段

精简 MVP，分层照抄 hermes（gateway 常驻 / providers 可换模型 / skills / tools+cron / 对外服务面），落到蓝河平台约束上：

| hermes | 本项目落点 |
| --- | --- |
| 常驻 gateway 进程 | `platform/schedule.js` 定时任务 + `app.ux agentTick` |
| agent 主循环 | `agent-loop.stepTask()` 单步可重入 |
| cron 定时任务 | `agent-core/jobs.js` |
| 会话/记忆 | 已有 `context-manager`（最近 N 条，KV 落盘） |
| skills（agentskills.io 兼容） | 已有 `skill-registry`，不动 |
| 工具 + 外部工具 | `tool-registry.registerProxy` + `mcp-client`（仅 HTTP 传输） |
| 对外服务面 | `platform/ble-service.js` BLE GATT Server（平台无端口监听 API） |
| 子代理并行 | **不抄**：手表无进程、功耗不允许 |

## 改动范围

- 新增：`platform/schedule.js`、`platform/ble-service.js`、`agent-core/{heartbeat,task-queue,jobs,mcp-client}.js`、`scripts/local-test/resident.test.mjs`
- 修改：`agent-core/runtime.js`（九步→十四步装配 + tick/入队/入站入口）、`agent-core/agent-loop.js`（`stepTask`）、`agent-core/tool-registry.js`（`registerProxy`/`has`）、`app.ux`（`agentTick`）、`manifest.json`（schedule + ble feature、BLUETOOTH 权限、后台能力补 schedule）
- 契约：`common/capabilities/watch-capabilities.json` v0.3.0，新增 `scheduled_job` / `ble_gatt_service` / `mcp_tools`，顶层加 `runtime_model: resident-heartbeat`
- 测试基建：`scripts/local-test/stubs.mjs`（scheduleStub / bluetoothStub）、`build.mjs`（两个 `@blueos.*` 映射）
- 顺带修复：`llm-config-cli.test.mjs` 用 `node:http` 替掉全局 `fetch`，消除 Windows 退出码 3221226505（undici 保活连接未关 → libuv 断言，断言全过仍判失败）

## 步骤

1. **A 平台封装**：`schedule.js`（type=2 真实时间流逝 + interval + triggerMethod）、`ble-service.js`（GATT Server + UTF-8 编解码 + 写回执 + notify）。验收：桩可断言注册参数。
2. **B 常驻链路**：`task-queue` + `jobs` + `heartbeat` + `agent-loop.stepTask`。验收：一次唤醒只推进一步、进程重启后从 KV 续跑到收敛。
3. **C 入口装配**：`runtime` 十四步 + `app.ux agentTick` + manifest 声明。验收：`runtime.start()` 全过、`getState().resident` 有内容。
4. **D MCP**：`mcp-client` HTTP JSON-RPC（initialize → tools/list → tools/call），前缀 `<server>__`。验收：外部工具出现在提示词工具清单并可被调用。
5. **E 入站指令**：BLE 写特征 → `handleInboundCommand` → 队列 → notify 回结果；超预算返回 `accepted`。验收：桩测覆盖 completed/回执/notify 中文可逆。
6. **F 契约与文档**：能力声明 + 两份机制文档 + 本计划 + 双索引。

## 验收清单

- [x] 心跳用 `type=2`、周期 > 0、方法名与 `app.ux` 一致
- [x] 到期 job 入队并在一次唤醒内推进到收敛，结果落 KV
- [x] 预算为 0 时一步不推进、不调 LLM、任务留在队列
- [x] 单步中断后换新 `TaskQueue` 实例 `init()` 可恢复（stepsUsed / messages 不丢）
- [x] MCP 工具注册、可被 Agent 调用；`mcp_config` 清空后不残留
- [x] BLE 服务面：GATT 服务/广播参数正确，写指令→回执→notify 全链路，UTF-8 中文可逆
- [x] `ble_config` 缺失时不创建 GATT Server（降级为仅外连）
- [x] `manifest.json` features/permissions 与 import 一一对应
- [x] 全量桩测 9 个文件 / 222 项断言通过
- [ ] **真机：一次后台窗口实际可用时长**（决定 `budgetMs`）
- [ ] **真机：`scheduleJob` 最小 interval 与任务数上限**（-27/已注册的实测行为）
- [ ] **真机：GATT `characteristics.properties` 字段形态与 notify 对端可见性**
- [ ] 真机：`app.ux` 心跳在息屏/休眠后仍被拉起

## 不在本期做的事

- 不把闸门事件（`_onSample` → `handleEvent`）迁到队列：旧入口仍一口气跑完，迁移会牵动 gate/runtime 两处桩测时序，单列下一步。
- 不做子代理并行、不做 stdio 型 MCP、不做 HTTP 服务端（平台无该能力）。

## 进度

A/B/C/D/E/F 全部完成，本地桩测通过；真机三项仍是硬阻塞（本项目从始至终未上过真机）。

### 模拟器首跑记录（2026-09-28）

`simulator ... ErrExit code: 1`。定位：构建产物 `blueos/build/watch-round/manifest.json` 里工具链把 9 个
`blueos.*` feature 全翻译成 `system.*`/`service.*`，唯独 `blueos.bluetooth.ble` 原样保留 —— 本机 SDK 不认它，
import 进启动链路即崩。已把 BLE 从 `runtime.start()` 摘除（模块与桩测保留，需显式装配），
manifest 去掉该 feature 与 `blueos.permission.BLUETOOTH`，`schedule` 保留（已正常翻译成 `system.schedule`）。
判据与映射表见 `mechanisms/blueos-platform-constraints.md`。

> 更新时间：2026-09-28
