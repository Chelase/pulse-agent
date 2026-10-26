/**
 * Step 1 验收：多步工具循环。
 * 覆盖：两个工具串联后收敛、fenced 工具调用、无工具调用直返、
 *       达步数上限强制收口、工具抛错不中断。
 */

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

/** 清空桩状态但保留 LLM 配置——每个场景都要重配一遍太啰嗦。 */
function resetAll() {
  memory.reset()
  setKV('llm_config', LLM_CONFIG)
}

resetAll()

async function makeLoop(lines) {
  const context = new ContextManager()
  await context.init()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  const loop = new AgentLoop(context, tools, null)
  await loop.init()
  fetchStub.respond('/chat/completions', scriptedLLM(lines))
  return { loop, context }
}

// 场景 1：两个工具串联后收敛
{
  resetAll()
  const { loop, context } = await makeLoop([
    '{"tool": "get_heart_rate", "params": {}}',
    '{"tool": "vibrate", "params": {"mode": "long"}}',
    '当前心率 128 bpm，高于阈值，已振动提醒。'
  ])
  const out = await loop.handleUserInput('查心率，若高于 100 就振动')
  check('场景1 最终回复是结论文本', out, '当前心率 128 bpm，高于阈值，已振动提醒。')
  check('场景1 振动已执行', memory.vibrations, ['long'])
  check('场景1 LLM 调用 3 次', memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1).length, 3)
  check('场景1 上下文落库 2 条', context.getMessages().length, 2)
  check('场景1 上下文最后一条是 assistant', context.getMessages()[1].role, 'assistant')
}

// 场景 2：工具结果确实回填给了下一轮
{
  resetAll()
  const { loop } = await makeLoop([
    '{"tool": "file_write", "params": {"path": "note.txt", "content": "心率偏高"}}',
    '已写入 note.txt。'
  ])
  await loop.handleUserInput('把结论写进文件')
  const secondCall = memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1)[1]
  const refilled = JSON.stringify(secondCall.data.messages)
  check('场景2 文件已落盘', memory.files.get('internal://files/agent/note.txt'), '心率偏高')
  check('场景2 工具结果已回填', refilled.indexOf('工具 file_write 返回') !== -1, true)
}

// 场景 3：fenced 代码块里的工具调用
{
  resetAll()
  const { loop } = await makeLoop([
    '好的，我先查一下。\n```json\n{"tool": "get_step_count", "params": {}}\n```',
    '今日步数已获取。'
  ])
  const out = await loop.handleUserInput('看看步数')
  check('场景3 fenced 解析成功', out, '今日步数已获取。')
  check('场景3 上下文 2 条', loop.context.getMessages().length, 2)
}

// 场景 4：无工具调用直接返回
{
  resetAll()
  const { loop } = await makeLoop(['今天天气不错。'])
  const out = await loop.handleUserInput('你好')
  check('场景4 直接返回', out, '今天天气不错。')
  check('场景4 只调 LLM 一次', memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1).length, 1)
}

// 场景 5：一直调用工具 → 触到防失控硬顶后强制收口
{
  resetAll()
  const { loop } = await makeLoop([
    '{"tool": "get_heart_rate", "params": {}}',
    '{"tool": "get_heart_rate", "params": {}}',
    '{"tool": "get_heart_rate", "params": {}}',
    '{"tool": "get_heart_rate", "params": {}}',
    '已按已有信息收口：心率数据已获取。'
  ])
  // 默认硬顶 50 步（不封顶语义），这里下调到 4 以便验证收口路径
  loop.stepHardLimit = 4
  const out = await loop.handleUserInput('反复查心率')
  check('场景5 强制收口回复', out, '已按已有信息收口：心率数据已获取。')
  check('场景5 LLM 调用 5 次（4 步工具 + 1 次收口）', memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1).length, 5)
  const lastCall = memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1).pop()
  const lastMsg = lastCall.data.messages[lastCall.data.messages.length - 1].content
  check('场景5 收口提示已注入', lastMsg.indexOf('步数上限') !== -1, true)
}

// 场景 6：工具抛错不中断循环
{
  resetAll()
  const { loop } = await makeLoop([
    '{"tool": "not_exist_tool", "params": {}}',
    '工具不可用，改用已有信息回答。'
  ])
  const out = await loop.handleUserInput('调用不存在的工具')
  check('场景6 抛错后仍返回结论', out, '工具不可用，改用已有信息回答。')
}

// 场景 7：LLM 未配置时不请求网络（这里刻意不恢复 llm_config）
{
  memory.reset()
  const context = new ContextManager()
  await context.init()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  const loop = new AgentLoop(context, tools, null)
  await loop.init()
  const out = await loop.handleUserInput('你好')
  check('场景7 未配置提示', out.indexOf('LLM 未配置') !== -1, true)
  check('场景7 未发网络请求', memory.requests.length, 0)
}

summary()
