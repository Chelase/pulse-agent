/**
 * Step 2 验收：闸门求值器 + 事件驱动链路。
 * 覆盖：持续时长、静默期、越限重置、布尔型比较、单次即触发，
 *       以及 handleEvent 的提醒/不打扰/兜底/不写对话历史。
 */

import { GateEvaluator, DEFAULT_CONDITIONS } from './.build/agent-core/gate-evaluator.mjs'
import { ContextManager } from './.build/agent-core/context-manager.mjs'
import { FileManager } from './.build/agent-core/file-manager.mjs'
import { SensorBridge } from './.build/agent-core/sensor-bridge.mjs'
import { HealthBridge } from './.build/agent-core/health-bridge.mjs'
import { ToolRegistry } from './.build/agent-core/tool-registry.mjs'
import { AgentLoop } from './.build/agent-core/agent-loop.mjs'
import { memory, setKV, fetchStub } from './stubs.mjs'
import { check, summary, scriptedLLM } from './harness.mjs'

const LLM_CONFIG = {
  endpoint: 'https://llm.test/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model'
}

/** 清空桩状态但保留 LLM 配置。 */
function resetAll() {
  memory.reset()
  setKV('llm_config', LLM_CONFIG)
}

resetAll()

// ============ 闸门求值器 ============
{
  check('闸门 内置条件数 5', DEFAULT_CONDITIONS.length, 5)

  let clock = 0
  const gate = new GateEvaluator(DEFAULT_CONDITIONS, () => clock)

  clock = 0
  check('闸门 首次越限不触发', gate.evaluate('heart_rate', 110), null)
  clock = 599 * 1000
  check('闸门 未满持续时长不触发', gate.evaluate('heart_rate', 110), null)
  clock = 600 * 1000
  check('闸门 满持续时长触发', (gate.evaluate('heart_rate', 110) || {}).id, 'sustained_high_heart_rate')
  clock = 600 * 1000 + 3599 * 1000
  check('闸门 静默期内不重复触发', gate.evaluate('heart_rate', 110), null)
  clock = 600 * 1000 + 3600 * 1000
  gate.evaluate('heart_rate', 110)
  clock = 600 * 1000 + 3600 * 1000 + 600 * 1000
  check('闸门 静默期后可再触发', (gate.evaluate('heart_rate', 110) || {}).id, 'sustained_high_heart_rate')

  clock = 0
  const fresh = new GateEvaluator(DEFAULT_CONDITIONS, () => clock)
  fresh.evaluate('heart_rate', 110)
  clock = 300 * 1000
  fresh.evaluate('heart_rate', 80)
  clock = 900 * 1000
  check('闸门 回到阈值内重置计时', fresh.evaluate('heart_rate', 110), null)

  clock = 0
  const body = new GateEvaluator(DEFAULT_CONDITIONS, () => clock)
  body.evaluate('on_body', false)
  clock = 300 * 1000
  check('闸门 on_body=false 触发取下', (body.evaluate('on_body', false) || {}).id, 'taken_off')

  clock = 0
  const other = new GateEvaluator(DEFAULT_CONDITIONS, () => clock)
  check('闸门 无关数据类型返回 null', other.evaluate('wrist_lift', 1), null)
  check('闸门 undefined 值返回 null', other.evaluate('heart_rate', undefined), null)

  clock = 0
  const batt = new GateEvaluator(DEFAULT_CONDITIONS, () => clock)
  check('闸门 单次采样即触发（sustainedSeconds=0）', (batt.evaluate('battery_level', 5) || {}).id, 'battery_critical')
}

// ============ 事件路径 ============
const event = {
  conditionId: 'sustained_high_heart_rate',
  description: '心率持续偏高',
  dataType: 'heart_rate',
  value: 128,
  timestamp: 1700000000000
}

async function makeLoop(lines) {
  const context = new ContextManager()
  await context.init()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  const loop = new AgentLoop(context, tools, null)
  await loop.init()
  fetchStub.respond('/chat/completions', scriptedLLM(lines))
  return { loop, context }
}

// 事件 1：需要提醒 → notification_send + vibrate
{
  resetAll()
  const { loop, context } = await makeLoop(['{"notify": "心率持续偏高，建议先休息一下", "vibrate": true}'])
  const out = await loop.handleEvent(event)
  check('事件 返回提醒文本', out, '心率持续偏高，建议先休息一下')
  check('事件 通知标题取事件说明', memory.notifications[0] && memory.notifications[0].content.title, '心率持续偏高')
  check('事件 通知正文', memory.notifications[0] && memory.notifications[0].content.text, '心率持续偏高，建议先休息一下')
  check('事件 振动已执行', memory.vibrations, ['long'])
  check('事件 不写对话历史', context.getMessages().length, 0)
}

// 事件 2：不需要打扰 → 无输出
{
  resetAll()
  const { loop } = await makeLoop(['{"notify": "", "vibrate": false}'])
  const out = await loop.handleEvent(event)
  check('事件 不打扰返回空', out, '')
  check('事件 不打扰不发通知', memory.notifications.length, 0)
  check('事件 不打扰不振动', memory.vibrations.length, 0)
}

// 事件 3：先查数据再判断
{
  resetAll()
  const { loop } = await makeLoop([
    '{"tool": "get_heart_rate", "params": {}}',
    '{"notify": "当前心率 128 bpm，已提醒", "vibrate": true}'
  ])
  const out = await loop.handleEvent(event)
  check('事件 查询后仍能出结论', out, '当前心率 128 bpm，已提醒')
  check('事件 仍发了通知', memory.notifications.length, 1)
}

// 事件 4：模型没按 JSON 输出 → 按默认提醒兜底
{
  resetAll()
  const { loop } = await makeLoop(['心率 128 已持续 10 分钟，建议休息'])
  const out = await loop.handleEvent(event)
  check('事件 兜底按提醒处理', out, '心率 128 已持续 10 分钟，建议休息')
  check('事件 兜底仍发通知', memory.notifications.length, 1)
  check('事件 兜底不振动', memory.vibrations.length, 0)
}

// 事件 5：模型明说无需提醒 → 不打扰
{
  resetAll()
  const { loop } = await makeLoop(['无需提醒，这是运动后的正常心率波动'])
  const out = await loop.handleEvent(event)
  check('事件 明说无需提醒则不打扰', out, '')
  check('事件 无需提醒不发通知', memory.notifications.length, 0)
}

// 事件 6：LLM 未配置 → 静默跳过（这里刻意不恢复 llm_config）
{
  memory.reset()
  const context = new ContextManager()
  await context.init()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  const loop = new AgentLoop(context, tools, null)
  await loop.init()
  const out = await loop.handleEvent(event)
  check('事件 未配置 LLM 时返回 null', out, null)
  check('事件 未配置 LLM 时不发通知', memory.notifications.length, 0)
}

summary()
