/**
 * LLM 配置验收：自定义供应商、请求地址、API Key、模型的持久化与请求参数。
 */

import { LLMClient } from './.build/agent-core/llm-client.mjs'
import { memory, fetchStub, setKV } from './stubs.mjs'
import { check, summary } from './harness.mjs'

memory.reset()

// 未配置：有默认 endpoint/model，但没有 apiKey，不允许请求
{
  const client = new LLMClient()
  await client.init()
  const status = client.getStatus()
  check('未配置保留默认 endpoint', status.endpoint, 'https://api.openai.com/v1/chat/completions')
  check('未配置使用默认模型', status.model, 'gpt-4o-mini')
  check('未配置状态为 false', status.configured, false)
  check('未配置没有 apiKey', status.hasApiKey, false)
}

// 自定义供应商配置：写入 KV，且 apiKey 不出现在状态对象中
{
  const client = new LLMClient()
  await client.init()
  await client.setConfig({
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-test-secret',
    model: 'deepseek-chat',
  })

  const status = client.getStatus()
  check('自定义 endpoint 持久化', status.endpoint, 'https://api.deepseek.com/v1/chat/completions')
  check('自定义 model 持久化', status.model, 'deepseek-chat')
  check('已配置状态为 true', status.configured, true)
  check('状态只暴露 hasApiKey 不暴露 key', Object.prototype.hasOwnProperty.call(status, 'apiKey'), false)
  check('KV 中保存完整配置', JSON.parse(memory.kv.get('llm_config')).apiKey, 'sk-test-secret')
}

// 请求：地址、模型、Bearer Key、请求体字段按配置发送
{
  fetchStub.respond('https://api.deepseek.com/v1/chat/completions', {
    choices: [{ message: { role: 'assistant', content: 'OK' } }]
  })
  const client = new LLMClient()
  await client.init()
  const reply = await client.chat([{ role: 'user', content: '连接测试' }])
  const request = memory.requests[memory.requests.length - 1]
  check('请求返回模型内容', reply.content, 'OK')
  check('请求地址正确', request.url, 'https://api.deepseek.com/v1/chat/completions')
  check('请求模型正确', request.data.model, 'deepseek-chat')
  check('请求消息正确', request.data.messages[0].content, '连接测试')
}

// testConnection：使用同一套 chat 路径
{
  const client = new LLMClient()
  await client.init()
  check('testConnection 返回 true', await client.testConnection(), true)
}

// 兼容旧配置：老配置缺字段也能归一化，不影响旧用户
{
  setKV('llm_config', {
    endpoint: 'https://legacy.example/v1/chat/completions',
    apiKey: 'legacy-key',
    model: 'legacy-model'
  })
  const client = new LLMClient()
  await client.init()
  check('旧配置 endpoint 保留', client.getStatus().endpoint, 'https://legacy.example/v1/chat/completions')
  check('旧配置 model 保留', client.getStatus().model, 'legacy-model')
  check('旧配置仍可用', client.getStatus().configured, true)
}

// 模拟器同步文件优先于旧 KV：CLI sync-simulator 写入此文件
{
  memory.reset()
  memory.files.set('internal://files/agent/llm-config.json', JSON.stringify({
    endpoint: 'http://localhost:9999/v1/chat/completions',
    apiKey: 'file-key',
    model: 'file-model',
  }))
  setKV('llm_config', {
    endpoint: 'https://old.example/v1/chat/completions',
    apiKey: 'old-key',
    model: 'old-model'
  })
  const client = new LLMClient()
  await client.init()
  check('internal 配置文件 endpoint 生效', client.getStatus().endpoint, 'http://localhost:9999/v1/chat/completions')
  check('internal 配置文件 model 生效', client.getStatus().model, 'file-model')
  check('internal 配置文件可用', client.getStatus().configured, true)
}

summary()
