/**
 * Harness P0/P1 验收：
 * - 工具拒绝与异常返回稳定结构，不再抛给调用方
 * - 事件任务不能执行写入类工具
 * - 系统提示按分节组装，并保留对话/事件的原有工具协议
 */

import { ContextManager } from './.build/agent-core/context-manager.mjs'
import { FileManager } from './.build/agent-core/file-manager.mjs'
import { SensorBridge } from './.build/agent-core/sensor-bridge.mjs'
import { HealthBridge } from './.build/agent-core/health-bridge.mjs'
import { ToolRegistry } from './.build/agent-core/tool-registry.mjs'
import { AgentLoop } from './.build/agent-core/agent-loop.mjs'
import { PromptAssembler } from './.build/agent-core/prompt-assembler.mjs'
import { formatToolResult, MAX_TOOL_RESULT_CHARS } from './.build/agent-core/tool-output.mjs'
import { environmentSnapshot } from './.build/agent-core/runtime-environment.mjs'
import { memory, setKV, fetchStub } from './stubs.mjs'
import { check, checkTrue, summary, scriptedLLM } from './harness.mjs'

const LLM_CONFIG = {
  endpoint: 'https://llm.test/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model'
}

function resetAll() {
  memory.reset()
  setKV('llm_config', LLM_CONFIG)
}

async function makeLoop(lines) {
  const context = new ContextManager()
  await context.init()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  const loop = new AgentLoop(context, tools, null)
  await loop.init()
  fetchStub.respond('/chat/completions', scriptedLLM(lines))
  return { loop, context, tools }
}

// P0-1：未知工具返回结构化拒绝，不抛异常
{
  resetAll()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  const result = await tools.execute('not_exist_tool', {})
  check('P0-1 未知工具成功标记', result.success, false)
  check('P0-1 未知工具状态', result.status, 'rejected')
  check('P0-1 未知工具原因', result.reason, 'unknown_tool')
}

// P0-2：工具内部异常被包装
{
  resetAll()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  tools.registerProxy({
    name: 'explode',
    description: '测试异常',
    permission: 'read',
    execute: async () => {
      throw new Error('boom')
    }
  })
  const result = await tools.execute('explode', {})
  check('P0-2 异常状态', result.status, 'error')
  check('P0-2 异常原因', result.reason, 'tool_error')
  check('P0-2 异常消息', result.message, 'boom')
}

// P0-3：事件任务不能执行写入类工具
{
  resetAll()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  const result = await tools.execute('vibrate', { mode: 'long' }, { kind: 'event' })
  check('P0-3 事件写入被拒', result.reason, 'event_policy')
  check('P0-3 事件未触发振动', memory.vibrations.length, 0)
}

// P0-4：拒绝结果仍然回填给模型，循环能继续
{
  resetAll()
  const { loop } = await makeLoop([
    '{"tool": "not_exist_tool", "params": {}}',
    '工具不可用。'
  ])
  const out = await loop.handleUserInput('调用不存在的工具')
  check('P0-4 拒绝后仍能收口', out, '工具不可用。')
  const secondCall = memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1)[1]
  const refilled = JSON.stringify(secondCall.data.messages)
  checkTrue('P0-4 拒绝原因回填', refilled.indexOf('unknown_tool') !== -1)
}

// P1-1：分节按 order 排序，空节跳过
{
  const assembler = new PromptAssembler([
    { name: 'b', order: 20, render: () => 'B' },
    { name: 'a', order: 10, render: () => 'A' },
    { name: 'skip', order: 15, render: () => '   ' }
  ])
  check('P1-1 分节排序与空节跳过', assembler.assemble(), 'A\n\nB')
}

// P1-2：分节重名直接抛错
{
  let threw = false
  try {
    new PromptAssembler([
      { name: 'same', order: 1, render: () => 'x' },
      { name: 'same', order: 2, render: () => 'y' }
    ])
  } catch (e) {
    threw = true
  }
  check('P1-2 重名节被拒绝', threw, true)
}

// P1-3：系统提示包含人设、环境、工具清单和原有工具协议
{
  resetAll()
  const { loop } = await makeLoop(['好的。'])
  await loop.handleUserInput('你好')
  const firstCall = memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1)[0]
  const system = firstCall.data.messages[0].content
  checkTrue('P1-3 包含人设', system.indexOf('Pulse Agent') !== -1)
  checkTrue('P1-3 包含运行环境', system.indexOf('运行环境') !== -1)
  checkTrue('P1-3 包含工具清单', system.indexOf('get_heart_rate') !== -1)
  checkTrue('P1-3 保留工具协议', system.indexOf('"tool"') !== -1)
}

// P1-4：事件提示使用事件协议，且不混入对话历史
{
  resetAll()
  const { loop, context } = await makeLoop(['{"notify": "", "vibrate": false}'])
  await loop.handleEvent({ conditionId: 'high_hr', description: '心率偏高', dataType: 'heartRate', value: 130 })
  const firstCall = memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1)[0]
  const system = firstCall.data.messages[0].content
  checkTrue('P1-4 事件协议存在', system.indexOf('"notify"') !== -1)
  checkTrue('P1-4 对话协议未混入', system.indexOf('只输出一个 JSON 对象，不要包裹其它文字：\n{"tool"') === -1)
  check('P1-4 事件不写对话历史', context.getMessages().length, 0)
}

// P1-5：工具输出短于上限时原样透传
{
  const raw = { status: 'ok', data: 'x'.repeat(100) }
  check('P1-5 短结果原样回填', formatToolResult(raw), JSON.stringify(raw))
}

// P1-6：超长结果被截断，带 truncated 标记与提示
{
  const raw = { status: 'ok', data: 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500) }
  const out = JSON.parse(formatToolResult(raw))
  check('P1-6 截断标记', out.truncated, true)
  check('P1-6 原始长度', out.original_chars, JSON.stringify(raw).length)
  check('P1-6 保留状态', out.status, 'ok')
  checkTrue('P1-6 带提示', out.note.indexOf('截断') !== -1)
  checkTrue('P1-6 结果不长于上限', formatToolResult(raw).length <= MAX_TOOL_RESULT_CHARS + 200)
}

// P1-7：自定义上限生效
{
  const raw = { status: 'ok', data: 'x'.repeat(500) }
  const out = JSON.parse(formatToolResult(raw, 200))
  check('P1-7 自定义上限触发截断', out.truncated, true)
}

// P1-8：不可序列化的结果被包装成稳定结构
{
  const bad = { get boom() { throw new Error('nope') } }
  const out = JSON.parse(formatToolResult(bad))
  check('P1-8 不可序列化状态', out.status, 'error')
  check('P1-8 不可序列化原因', out.reason, 'unserializable_result')
}

// P1-9：环境快照按传入值输出真实状态
{
  const text = environmentSnapshot({
    ready: true,
    now: '2026-10-29T00:00:00.000Z',
    tools: 7,
    skills: 2,
    pendingTasks: 3
  })
  checkTrue('P1-9 含就绪态', text.indexOf('就绪：是') !== -1)
  checkTrue('P1-9 含时间', text.indexOf('2026-10-29T00:00:00.000Z') !== -1)
  checkTrue('P1-9 含工具数', text.indexOf('已注册工具：7 个') !== -1)
  checkTrue('P1-9 含技能数', text.indexOf('已加载技能：2 个') !== -1)
  checkTrue('P1-9 含待办数', text.indexOf('待处理任务：3 个') !== -1)
}

// P1-10：未注入就绪态时显示 unknown，不谎报已就绪
{
  const text = environmentSnapshot({ tools: 1, skills: 0 })
  checkTrue('P1-10 就绪态缺省为 unknown', text.indexOf('就绪：unknown') !== -1)
  checkTrue('P1-10 无就绪态时不出现待办字段', text.indexOf('待处理任务') === -1)
}

// P1-11：注入 environmentProvider 后系统提示用的是注入值
{
  resetAll()
  const { loop } = await makeLoop(['好的。'])
  loop.setEnvironmentProvider(() => ({
    ready: true,
    now: '2026-10-29T00:00:00.000Z',
    tools: 42,
    skills: 5,
    pendingTasks: 9
  }))
  await loop.handleUserInput('你好')
  const firstCall = memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1)[0]
  const system = firstCall.data.messages[0].content
  checkTrue('P1-11 注入就绪态生效', system.indexOf('就绪：是') !== -1)
  checkTrue('P1-11 注入工具数生效', system.indexOf('已注册工具：42 个') !== -1)
  checkTrue('P1-11 注入待办数生效', system.indexOf('待处理任务：9 个') !== -1)
}

// P1-12：上下文超出字符上限时丢最旧的整条消息
{
  resetAll()
  const context = new ContextManager(100, 20)
  await context.init()
  await context.addMessage('user', 'a'.repeat(15))
  await context.addMessage('assistant', 'b'.repeat(15))
  await context.addMessage('user', 'c'.repeat(15))
  const messages = context.getMessages()
  check('P1-12 超限后剩余条数', messages.length, 1)
  check('P1-12 保留的是最新一条', messages[0].content, 'c'.repeat(15))
}

// P1-13：字符上限内不丢消息
{
  resetAll()
  const context = new ContextManager(100, 1000)
  await context.init()
  await context.addMessage('user', '你好')
  await context.addMessage('assistant', '在')
  check('P1-13 未超限不丢消息', context.getMessages().length, 2)
}

summary()
