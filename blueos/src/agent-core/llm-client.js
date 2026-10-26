/**
 * LLMClient - 调用远程 LLM API
 * 配置从 KV storage 读取，默认使用兼容 OpenAI 的接口。
 */

import fetch from '@blueos.network.fetch'
import { Storage } from '../platform/storage'
import { API_MODES, resolveMode, resolveEndpoint, errorOf } from './llm-adapters'

const LLM_CONFIG_KEY = 'llm_config'
const DEFAULT_MODEL = 'gpt-4o-mini'

export class LLMClient {
  async init() {
    console.log('[LLMClient] init begin')
    const storedConfig = await Storage.get(LLM_CONFIG_KEY, null)
    const fileConfig = await this._readFileConfig()
    this.config = this._normalizeConfig(fileConfig || storedConfig)
    console.log('[LLMClient] init done, configured=' + this.isConfigured())
  }

  /** reload internal file / KV without restarting runtime */
  async reload() {
    console.log('[LLMClient] reload begin')
    await this.init()
    console.log('[LLMClient] reload done, configured=' + this.isConfigured())
    return this.isConfigured()
  }

  async _readFileConfig() {
    try {
      const raw = await Storage.readFile('llm-config.json', '')
      if (!raw) return null
      const parsed = JSON.parse(raw)
      console.log('[LLMClient] loaded config from internal file')
      return parsed
    } catch (err) {
      console.warn('[LLMClient] ignored invalid internal config file:', err && err.message)
      return null
    }
  }

  _normalizeConfig(config) {
    return {
      endpoint: (config && config.endpoint) || 'https://api.openai.com/v1/chat/completions',
      apiKey: (config && config.apiKey) || '',
      model: (config && config.model) || DEFAULT_MODEL,
      apiMode: resolveMode(config && config.apiMode)
    }
  }

  async setConfig(config) {
    this.config = this._normalizeConfig({ ...this.config, ...config })
    await Storage.set(LLM_CONFIG_KEY, this.config)
  }

  getConfig() {
    return this._normalizeConfig(this.config)
  }

  isConfigured() {
    return !!(this.config && this.config.endpoint && this.config.apiKey)
  }

  getStatus() {
    const config = this.getConfig()
    return {
      model: config.model,
      endpoint: config.endpoint,
      apiMode: config.apiMode,
      configured: this.isConfigured(),
      hasApiKey: !!config.apiKey
    }
  }

  async testConnection() {
    const reply = await this.chat([
      { role: 'system', content: '你正在进行连接测试。只回复 OK，不要调用工具。' },
      { role: 'user', content: '连接测试' }
    ])
    return !!(reply && reply.content)
  }

  async chat(messages) {
    if (!this.isConfigured()) {
      throw new Error('LLM 未配置，请在设置中配置 endpoint 和 apiKey')
    }

    const adapter = API_MODES[this.config.apiMode]
    const request = adapter.build(this.config, messages)

    const resp = await new Promise((resolve, reject) => {
      fetch.fetch({
        url: resolveEndpoint(this.config.endpoint, this.config.apiMode),
        method: 'POST',
        responseType: 'json',
        header: request.header,
        data: request.data,
        success: (data) => resolve(data),
        fail: (data, code) => reject(new Error(`LLM fetch failed: ${data} (${code})`))
      })
    })

    // BlueOS fetch success 返回 { code, data, headers }
    const body = resp && resp.data ? resp.data : resp
    const reason = errorOf(body)
    if (reason) {
      throw new Error(`LLM error (${this.config.apiMode}): ${reason}`)
    }
    return adapter.parse(body || {})
  }
}
