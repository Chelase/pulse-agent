/**
 * 常驻式 Agent 验收：心跳注册 → 到期任务入队 → 单步推进 → 预算退出 → 跨唤醒续跑 → BLE 入站 → MCP 工具。
 *
 * app.ux 是 .ux 文件、不参与镜像，所以这里用 scheduleStub.bind 显式把
 * 「系统后台拉起 agentTick」接回 runtime.tick()，与 app.ux 里的实现一一对应。
 * AgentRuntime 是模块级单例，本文件必须独占一个进程。
 */

import { AgentRuntime } from './.build/agent-core/runtime.mjs'
import { TaskQueue } from './.build/agent-core/task-queue.mjs'
import { ToolRegistry } from './.build/agent-core/tool-registry.mjs'
import { MCPClient } from './.build/agent-core/mcp-client.mjs'
import { Heartbeat } from './.build/agent-core/heartbeat.mjs'
import { BleService, BLE_SERVICE_UUID, bleCodec } from './.build/platform/ble-service.mjs'
import { memory, setKV, getKV, fetchStub, scheduleStub, bluetoothStub, healthStub } from './stubs.mjs'
import { check, checkTrue, summary, sleep, scriptedLLM } from './harness.mjs'

memory.reset()

setKV('llm_config', { endpoint: 'https://llm.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model' })
setKV('ble_config', { enabled: true })
setKV('mcp_config', { servers: [{ name: 'kb', url: 'http://mcp.test/mcp' }] })

// MCP：按 JSON-RPC 的 method 分别应答
fetchStub.respond('mcp.test', (body) => {
  if (body.method === 'initialize') return { jsonrpc: '2.0', result: { protocolVersion: '2024-11-05', capabilities: {} } }
  if (body.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      result: { tools: [{ name: 'lookup', description: '查知识库', inputSchema: { q: 'string' } }] }
    }
  }
  if (body.method === 'tools/call') return { jsonrpc: '2.0', result: { content: [{ type: 'text', text: '知识库命中：心跳阈值 120' }] } }
  return { jsonrpc: '2.0', error: { code: -32601, message: 'method not found' } }
})

const runtime = new AgentRuntime()
scheduleStub.bind('agentTick', (params) => runtime.tick(params))

// ---------- 启动：心跳 / BLE / MCP 都要装上 ----------
fetchStub.respond('/chat/completions', scriptedLLM(['不应该在这一步被调用']))
await runtime.start()

check('runtime ready', runtime.ready, true)

const job = [...scheduleStub.jobs.values()][0]
check('心跳只注册 1 个任务', scheduleStub.jobs.size, 1)
check('心跳用真实时间流逝（休眠也累计）', job.type, 2)
check('心跳方法名与 app.ux 一致', job.triggerMethod, 'agentTick')
checkTrue('心跳带周期 interval', job.interval > 0)

// 入站服务面不挂在默认启动链路上（当前 SDK 不认 blueos.bluetooth.ble，
// 一旦 import 进 runtime 会让整个应用在模拟器里起不来），需要显式装配。
const ble = new BleService((text) => runtime.handleInboundCommand(text))
check('BLE 服务面可按配置启用', await ble.start(), true)

const server = bluetoothStub.lastServer
checkTrue('BLE GATT Server 已创建', !!server)
check('GATT 服务 UUID 正确', server.services[0].serviceUuid, BLE_SERVICE_UUID)
check('GATT 两个特征（写入口 + 读/通知出口）', server.services[0].characteristics.length, 2)
check('BLE 广播可连接', server.advertising.setting.connectable, true)
checkTrue('MCP 工具并入 ToolRegistry', runtime.toolRegistry.has('kb__lookup'))

checkTrue('启动时队列为空', runtime.getState().resident.pendingTasks === 0)
check('心跳来源为平台定时任务', runtime.getState().resident.heartbeatSource, 'schedule')

// ---------- 平台定时任务注册失败时降级为进程内定时器 ----------
// 模拟器上 scheduleJob 返回 generic error(200)，不降级就再也没有心跳
const fakeRuntime = { dueJobsToQueue: async () => 0, taskQueue: { next: () => null }, agentLoop: {} }
const hb = new Heartbeat(fakeRuntime, { intervalMs: 40 })
scheduleStub.failNext = true
check('注册失败返回 -1', await hb.start(), -1)
check('降级为进程内定时器', hb.source, 'local-timer')
const ticksBefore = hb.ticks
await sleep(130)
checkTrue('降级后仍在按周期心跳', hb.ticks > ticksBefore)
hb.stop()
check('stop 清掉降级定时器', hb.source, '')

// ---------- 到期 job → 入队 → 一次唤醒内多步推进 ----------
await runtime.jobs.add({ name: 'daily-summary', instruction: '总结今天的心率情况', intervalMs: 60000 })
// 把下一轮时间拨到过去，模拟「到点了」，不靠 sleep 赌时序
runtime.jobs.jobs[0].nextRunAt = Date.now() - 1

const toolCallReply = JSON.stringify({ tool: 'get_heart_rate', params: {} })
const finalReply = '今天心率整体平稳，只有一次短暂偏高'
fetchStub.respond('/chat/completions', scriptedLLM([toolCallReply, finalReply]))
memory.requests.length = 0

const tick1 = await scheduleStub.fire('agentTick')
check('心跳入队 1 个到期任务', tick1.enqueued, 1)
check('心跳推进了 2 步', tick1.advanced, 2)
check('一次唤醒内跑了 2 次 LLM 往返',
  memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1).length, 2)

const persisted = getKV('agent_task_queue')
check('队列已落盘', Array.isArray(persisted), true)
check('落盘任务已收敛', persisted[persisted.length - 1].status, 'done')
check('落盘结果文本正确', persisted[persisted.length - 1].result, finalReply)
check('下一轮时间已推后（错过不补跑）', runtime.jobs.list()[0].nextRunAt > Date.now(), true)

// ---------- 心跳预算：还有活时按预算退出，绝不在一个窗口里硬撑 ----------
runtime.heartbeat.budgetMs = 0
for (let i = 0; i < 3; i++) {
  await runtime.submitTask({ kind: 'conversation', instruction: '排队任务 ' + i, source: 'budget-test' })
}
fetchStub.respond('/chat/completions', scriptedLLM(['不该被调用']))
memory.requests.length = 0

const tickBudget = await scheduleStub.fire('agentTick')
check('预算为 0 时一步都不推进', tickBudget.advanced, 0)
check('预算为 0 时不调 LLM', memory.requests.length, 0)
check('任务留在队列里等下一次唤醒', runtime.taskQueue.pendingCount(), 3)
runtime.heartbeat.budgetMs = 1500

// ---------- 跨唤醒续跑：模拟进程在两步之间被杀 ----------
await runtime.submitTask({ kind: 'conversation', instruction: '查一下心跳阈值', source: 'resume-test' })
const midTask = runtime.taskQueue.tasks.find(t => t.source === 'resume-test')

fetchStub.respond('/chat/completions', scriptedLLM([
  JSON.stringify({ tool: 'kb__lookup', params: { q: '心跳阈值' } }),
  '知识库说心跳阈值是 120'
]))

check('第一次单步有进展', await runtime.agentLoop.stepTask(midTask), true)
check('第一次单步消耗 1 步', midTask.stepsUsed, 1)
check('第一次单步仍在跑', midTask.status, 'running')
await runtime.taskQueue.save()

// 换一个 TaskQueue 实例重新 init，等价于进程重启后从 KV 恢复
const revived = new TaskQueue()
await revived.init()
const restored = revived.tasks.find(t => t.source === 'resume-test')
checkTrue('进程重启后任务还在', !!restored)
check('恢复后步数不丢', restored.stepsUsed, 1)
check('恢复后消息含工具返回', restored.messages.some(m => m.content.indexOf('工具 kb__lookup 返回') !== -1), true)
check('MCP 工具确实被调用过', memory.requests.some(r => String(r.url).indexOf('mcp.test') !== -1), true)
check('恢复后任务状态未串味', revived.tasks.filter(t => t.status === 'running').length, 1)

check('第二次单步有进展', await runtime.agentLoop.stepTask(restored), true)
check('第二次单步收敛', restored.status, 'done')
check('第二次单步拿到结论', restored.result, '知识库说心跳阈值是 120')

// ---------- BLE 入站指令：对端写一条，结果从 notify 回去 ----------
const inboundReply = '收到，已经帮你记下'
fetchStub.respond('/chat/completions', scriptedLLM([inboundReply]))
const reply = await server.writeFromClient('AA:BB:CC:DD:EE:FF', JSON.stringify({ task_id: 'ble-1', instruction: '记一下我现在的状态' }))
check('BLE 指令同步返回 completed', reply.status, 'completed')
check('BLE 指令回传 task_id', reply.task_id, 'ble-1')
check('BLE 指令产出结果', reply.result, inboundReply)
check('BLE 写请求已按协议回执', server.responses.length, 1)
check('BLE 回执 status=0', server.responses[0].status, 0)
check('BLE 结果通过 notify 回投', server.notifications.length, 1)
check('notify 载荷可解开',
  JSON.parse(bleCodec.utf8Decode(server.notifications[0].notifyCharacteristic.value)).result, inboundReply)

// 中文指令编解码（UTF-8 多字节路径）
const encoded = bleCodec.utf8Encode('心率偏高，先停一下')
check('中文编码字节数正确', encoded.length, '心率偏高，先停一下'.length * 3)
check('中文解码可逆', bleCodec.utf8Decode(encoded), '心率偏高，先停一下')

// ---------- 关掉配置后的行为（用新实例，绕开 runtime 单例） ----------
memory.reset()
const bleOff = new BleService(async () => ({ status: 'completed' }))
check('ble_config 缺失时不启用服务面', await bleOff.start(), false)
check('未启用时不创建 GATT Server', bluetoothStub.lastServer, null)

memory.reset()
const mcpOff = new MCPClient()
await mcpOff.init()
check('mcp_config 清空后不残留上一轮接入', mcpOff.connected.length, 0)
const regOff = new ToolRegistry(null, null, null)
check('清空配置后注册 0 个外部工具', mcpOff.registerTools(regOff), 0)
check('只剩内置工具', regOff.getTools().length, 7)

runtime.stop()
healthStub.emitHeartRate(70)

summary()
