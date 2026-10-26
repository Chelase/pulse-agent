/**
 * API 模式验收：契约清单 ↔ 表上适配器 ↔ 控制面校验 ↔ 三种协议的请求与解析。
 */

import { createRequire } from 'node:module'
import { API_MODES as ADAPTER_MODES, resolveMode, resolveEndpoint, errorOf } from './.build/agent-core/llm-adapters.mjs'
import { LLMClient } from './.build/agent-core/llm-client.mjs'
import { memory, fetchStub } from './stubs.mjs'
import { check, checkTrue, summary } from './harness.mjs'

const require = createRequire(import.meta.url)
const CONTRACT = require('../../common/models/api-modes.json')
const store = require('../llm-config-store.js')

const MESSAGES = [
  { role: 'system', content: '你是手表 Agent' },
  { role: 'user', content: '现在心率多少' }
]
const CONFIG = { endpoint: 'https://x.test/v1/chat/completions', apiKey: 'k-123', model: 'm-1' }

// ---------- 契约与适配器不能漂移 ----------
check('适配器模式集合与契约一致',
  Object.keys(ADAPTER_MODES).slice().sort().join(','),
  CONTRACT.modes.map(m => m.id).slice().sort().join(','))
check('默认模式与契约一致', resolveMode('不存在的模式'), CONTRACT.default)
checkTrue('每个模式都有 endpointSuffix', CONTRACT.modes.every(m => typeof m.endpointSuffix === 'string'))

// ---------- OpenAI Chat Completions ----------
{
  const req = ADAPTER_MODES['openai-chat'].build(CONFIG, MESSAGES)
  check('chat 用 Bearer 头', req.header.Authorization, 'Bearer k-123')
  check('chat 原样带 messages（含 system）', req.data.messages.length, 2)
  check('chat 不发 max_tokens', 'max_tokens' in req.data, false)
  const parsed = ADAPTER_MODES['openai-chat'].parse({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
  check('chat 解析出文本', parsed.content, 'OK')
}

// ---------- Anthropic Messages ----------
{
  const cfg = { ...CONFIG, endpoint: 'https://api.anthropic.com/v1/messages', apiMode: 'anthropic-messages' }
  const req = ADAPTER_MODES['anthropic-messages'].build(cfg, MESSAGES)
  check('anthropic 用 x-api-key 头', req.header['x-api-key'], 'k-123')
  check('anthropic 带版本头', req.header['anthropic-version'], '2023-06-01')
  check('anthropic 把 system 提到顶层', req.data.system, '你是手表 Agent')
  check('anthropic messages 里不再含 system', req.data.messages.length, 1)
  check('anthropic 必须发 max_tokens', req.data.max_tokens > 0, true)
  const parsed = ADAPTER_MODES['anthropic-messages'].parse({ content: [{ type: 'text', text: 'OK' }, { type: 'text', text: ' second' }] })
  check('anthropic 拼接多段文本', parsed.content, 'OK second')
}

// ---------- OpenAI Responses ----------
{
  const cfg = { ...CONFIG, endpoint: 'https://api.openai.com/v1/responses', apiMode: 'openai-responses' }
  const req = ADAPTER_MODES['openai-responses'].build(cfg, MESSAGES)
  check('responses 用 instructions 承载 system', req.data.instructions, '你是手表 Agent')
  check('responses 的 input 不含 system', req.data.input.length, 1)
  const parsed = ADAPTER_MODES['openai-responses'].parse({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }]
  })
  check('responses 解析出文本', parsed.content, 'OK')
}

// ---------- 错误提取覆盖各家形状 ----------
check('chat 错误', errorOf({ error: { message: 'bad key' } }), 'bad key')
check('anthropic 错误', errorOf({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), 'invalid x-api-key')
check('无错误时返回空串', errorOf({ choices: [] }), '')

// ---------- 表上客户端按模式发请求 ----------
{
  memory.reset()
  fetchStub.respond('https://api.anthropic.com/v1/messages', { content: [{ type: 'text', text: '来自 Claude' }] })
  const client = new LLMClient()
  await client.init()
  await client.setConfig({
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-4-5',
    apiMode: 'anthropic-messages'
  })
  const reply = await client.chat(MESSAGES)
  check('客户端走 anthropic 适配器', reply.content, '来自 Claude')
  const sent = memory.requests[memory.requests.length - 1]
  check('实际发出的体带 system', sent.data.system, '你是手表 Agent')
  check('实际发出的体不带 messages.system', sent.data.messages.some(m => m.role === 'system'), false)
  check('状态回显 apiMode', client.getStatus().apiMode, 'anthropic-messages')
  check('存的地址保持原样', client.getConfig().endpoint, 'https://api.anthropic.com/v1')
  check('实际请求打到补全后的地址', memory.requests[memory.requests.length - 1].url, 'https://api.anthropic.com/v1/messages')
}

// ---------- 控制面：存原样，补全只发生在发请求时 ----------
check('未知模式归一到默认', store.normalize({ apiMode: 'bedrock-converse' }).apiMode, CONTRACT.default)
check('合法模式保留', store.normalize({ apiMode: 'anthropic-messages' }).apiMode, 'anthropic-messages')
check('保存的 endpoint 保持原样',
  store.normalize({ endpoint: 'https://api.example-relay.com/v1', model: 'm' }).endpoint,
  'https://api.example-relay.com/v1')
check('服务端探测用的地址被补全',
  store.completeEndpoint('https://api.example-relay.com/v1', 'openai-chat'),
  'https://api.example-relay.com/v1/chat/completions')

// ---------- 表上适配器：路径补全规则与服务端一致 ----------
check('适配器补全基址',
  resolveEndpoint('https://api.example-relay.com/v1', 'openai-chat'),
  'https://api.example-relay.com/v1/chat/completions')
check('尾斜杠不产生双斜杠',
  resolveEndpoint('https://x.test/v1/', 'openai-chat'),
  'https://x.test/v1/chat/completions')
check('跨模式替换旧路径',
  resolveEndpoint('https://api.openai.com/v1/chat/completions', 'anthropic-messages'),
  'https://api.openai.com/v1/messages')
check('已正确的地址保持原样',
  resolveEndpoint('https://api.anthropic.com/v1/messages', 'anthropic-messages'),
  'https://api.anthropic.com/v1/messages')
check('非法 URL 原样返回不崩', resolveEndpoint('not-a-url', 'openai-chat'), 'not-a-url')
check('适配器与契约的 endpointSuffix 一致',
  CONTRACT.modes.map(m => m.id + ':' + m.endpointSuffix).sort().join(','),
  CONTRACT.modes.map(m => m.id + ':' + ADAPTER_MODES[m.id].endpointSuffix).sort().join(','))

summary()
