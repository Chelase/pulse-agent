/**
 * llm-adapters - 请求协议适配层
 *
 * 表上内部统一用 [{role, content}] 这种消息形状；各家 HTTP 契约不同，
 * 由这里的适配器负责「发什么、怎么解析」，agent-loop 不感知模式差异。
 *
 * 不做 AWS Bedrock Converse：它要 SigV4 签名（AccessKey + Secret + region），
 * 不是填一个 API Key 能覆盖的鉴权模型。
 */

const ANTHROPIC_VERSION = '2023-06-01'
// Anthropic 的 max_tokens 是必填字段，不填会被拒；这是协议要求，不是输出截断
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

function splitSystem(messages) {
  const system = (messages || [])
    .filter(m => m && m.role === 'system')
    .map(m => m.content)
    .join('\n\n')
  const rest = (messages || []).filter(m => m && m.role !== 'system')
  return { system, rest }
}

function bearer(apiKey) {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }
}

export const API_MODES = {
  'openai-chat': {
    label: 'OpenAI Chat Completions',
    endpointSuffix: '/chat/completions',
    build(config, messages) {
      return {
        header: bearer(config.apiKey),
        data: { model: config.model, messages, temperature: 0.7 }
      }
    },
    parse(body) {
      const choice = body.choices && body.choices[0]
      return choice ? choice.message : null
    }
  },

  'anthropic-messages': {
    label: 'Anthropic Messages',
    endpointSuffix: '/messages',
    build(config, messages) {
      const { system, rest } = splitSystem(messages)
      const data = { model: config.model, messages: rest, max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS }
      if (system) data.system = system
      return {
        header: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        data
      }
    },
    parse(body) {
      const parts = Array.isArray(body.content) ? body.content : []
      const text = parts.filter(p => p && p.type === 'text').map(p => p.text).join('')
      return text ? { role: 'assistant', content: text } : null
    }
  },

  'openai-responses': {
    label: 'OpenAI Responses',
    endpointSuffix: '/responses',
    build(config, messages) {
      const { system, rest } = splitSystem(messages)
      const data = { model: config.model, input: rest }
      if (system) data.instructions = system
      return { header: bearer(config.apiKey), data }
    },
    parse(body) {
      const items = Array.isArray(body.output) ? body.output : []
      const texts = []
      for (const item of items) {
        const parts = item && Array.isArray(item.content) ? item.content : []
        for (const part of parts) {
          if (part && typeof part.text === 'string') texts.push(part.text)
        }
      }
      return texts.length ? { role: 'assistant', content: texts.join('') } : null
    }
  }
}

export const DEFAULT_API_MODE = 'openai-chat'

/**
 * 存的是用户填的原样地址，发请求时才补路径：
 * 只填基址（`.../v1`）补上当前模式要求的路径；末尾是别的模式的路径就换成本模式的。
 */
export function resolveEndpoint(endpoint, apiMode) {
  const mode = API_MODES[resolveMode(apiMode)]
  let url
  try {
    url = new URL(endpoint)
  } catch (err) {
    return endpoint
  }
  if (url.pathname.endsWith(mode.endpointSuffix)) return endpoint
  const foreign = Object.keys(API_MODES)
    .filter(id => id !== resolveMode(apiMode))
    .map(id => API_MODES[id])
    .find(m => url.pathname.endsWith(m.endpointSuffix))
  url.pathname = foreign
    ? url.pathname.slice(0, -foreign.endpointSuffix.length) + mode.endpointSuffix
    : url.pathname.replace(/\/+$/, '') + mode.endpointSuffix
  return url.toString()
}

export function resolveMode(mode) {
  return API_MODES[mode] ? mode : DEFAULT_API_MODE
}

/** 各家错误字段形状不一，统一抽成一句可读原因。 */
export function errorOf(body) {
  if (!body || typeof body !== 'object') return ''
  const direct = body.error
  if (typeof direct === 'string') return direct
  if (direct && (direct.message || direct.type)) return direct.message || direct.type
  if (body.message) return String(body.message)
  if (body.type === 'error' || body.status === 'failed') return JSON.stringify(body).slice(0, 200)
  return ''
}
