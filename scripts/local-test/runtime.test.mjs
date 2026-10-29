/**
 * 端到端集成：AgentRuntime 九步启动 → 传感器采样 → 闸门 → LLM → 通知 + 振动。
 *
 * 这是最接近真机的一条链路验证（除了真机本身的平台 API 行为）。
 * 注意 AgentRuntime 是模块级单例，本文件必须独占一个进程。
 */

import { AgentRuntime } from './.build/agent-core/runtime.mjs'
import { memory, setKV, fetchStub, healthStub, sensorStub } from './stubs.mjs'
import { check, summary, sleep, scriptedLLM } from './harness.mjs'

memory.reset()
setKV('llm_config', {
  endpoint: 'https://llm.test/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model'
})

fetchStub.respond('/chat/completions', scriptedLLM([
  '{"notify": "心率偏高已经持续一段时间了，先停一下手上的事", "vibrate": true}'
]))

const runtime = new AgentRuntime()
await runtime.start()

check('runtime ready', runtime.ready, true)
check('rootId 形如 blueos_watch:<id>', /^blueos_watch:.+/.test(runtime.identity.getRootId()), true)
check('skillRegistry 已加载 1 个 skill', runtime.skillRegistry.list().length, 1)
check('gateEvaluator 使用内置条件集', runtime.gateEvaluator.getConditions().length, 5)

// 真机上 sustainedSeconds=600，测试里换成单次即触发，其余语义不变
// 条件 id 沿用内置集的名字，这样能顺带验证 skill 按 trigger 命中
runtime.gateEvaluator.conditions = [{
  id: 'sustained_high_heart_rate',
  description: '心率持续偏高',
  dataType: 'heart_rate',
  operator: 'gt',
  threshold: 100,
  sustainedSeconds: 0,
  cooldownSeconds: 3600
}]

// ---------- 未跨门的采样不应唤醒 Agent ----------
memory.requests.length = 0
healthStub.emitHeartRate(72)
await sleep(30)
check('未越限采样不调 LLM', memory.requests.length, 0)
check('未越限采样不发通知', memory.notifications.length, 0)

// ---------- 跨门 → LLM → 通知 + 振动 ----------
healthStub.emitHeartRate(130)
await sleep(80)

check('跨门事件调用了 LLM', memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1).length, 1)
check('发出了通知', memory.notifications.length, 1)
check('通知标题取事件说明', memory.notifications[0].content.title, '心率持续偏高')
check('通知正文是模型给的提醒', memory.notifications[0].content.text, '心率偏高已经持续一段时间了，先停一下手上的事')
check('触发了长振动', memory.vibrations, ['long'])
check('事件路径不写对话历史', runtime.context.getMessages().length, 0)
check('lastEvent 记录事件结论', runtime.getState().lastEvent, '心率偏高已经持续一段时间了，先停一下手上的事')

const eventCall = memory.requests.find(r => String(r.url).indexOf('/chat/completions') !== -1)
check('事件 system prompt 常驻 skill frontmatter', eventCall.data.messages[0].content.indexOf('health-alert-handling') !== -1, true)
check('事件 system prompt 按 trigger 注入 skill 正文', eventCall.data.messages[0].content.indexOf('健康异常事件处置') !== -1, true)
check('事件 system prompt 含工具清单', eventCall.data.messages[0].content.indexOf('notification_send') !== -1, true)
check('事件 user 消息是事件载荷', eventCall.data.messages[1].content.indexOf('sustained_high_heart_rate') !== -1, true)
// 运行环境段必须来自 runtime 注入的真实状态，而不是 agent-loop 的兜底值
check('系统提示含真实就绪态', eventCall.data.messages[0].content.indexOf('就绪：是') !== -1, true)
check('系统提示含真实工具数', eventCall.data.messages[0].content.indexOf('已注册工具：' + runtime.toolRegistry.getTools().length + ' 个') !== -1, true)

// ---------- 静默期内不重复触发 ----------
memory.notifications.length = 0
memory.vibrations.length = 0
memory.requests.length = 0
healthStub.emitHeartRate(135)
await sleep(60)
check('静默期内不重复调 LLM', memory.requests.length, 0)
check('静默期内不重复发通知', memory.notifications.length, 0)

// ---------- 外部任务入口 ----------
const taskResult = await runtime.handleExternalRequest({ task_id: 'task-x', instruction: '总结今天的心率情况' })
check('外部任务返回 completed', taskResult.status, 'completed')
check('外部任务回传 task_id', taskResult.task_id, 'task-x')
check('外部任务产出结论文本', typeof taskResult.result, 'string')

const badTask = await runtime.handleExternalRequest({ task_id: 'task-y' })
check('缺 instruction 时返回 failed', badTask.status, 'failed')
check('缺 instruction 时给出原因', badTask.error, '任务缺少 instruction')

// ---------- stop 后不再处理事件 ----------
runtime.stop()
memory.notifications.length = 0
memory.requests.length = 0
healthStub.emitHeartRate(140)
await sleep(40)
check('stop 后不再处理采样', memory.requests.length, 0)
check('stop 后不发通知', memory.notifications.length, 0)

summary()
