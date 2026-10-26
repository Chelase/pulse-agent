/**
 * ConfigOnboarding - 设备码首启：向 Setup 申请码、轮询配置、落盘并热加载。
 * 不依赖手机 App，独立运行。
 */

import fetch from '@blueos.network.fetch'
import { Storage } from '../platform/storage'
import { Notification } from '../platform/notification'

const SETUP_CONFIG_KEY = 'setup_config'
const DEFAULT_POLL_MS = 2000
// Setup 重启/码过期都会让轮询拿到「码无效」错误体；重新申请有上限，防止服务端异常时无限循环
const MAX_REAPPLIES = 3
const DEAD_CODE_RE = /无效|已过期|已使用|已领取/

function httpJson(url, options = {}) {
  const method = options.method || 'GET'
  const data = options.data
  return new Promise((resolve, reject) => {
    fetch.fetch({
      url,
      method,
      // 平台对 responseType:'json' 遇空响应体（204 未就绪）在原生 JSON.parse 就抛
      // JSError: unexpected end of input，success/fail 都走不到；拿 text 自己解析才能等空响应
      responseType: 'text',
      header: {
        'Content-Type': 'application/json',
      },
      data,
      success: (resp) => {
        const status = (resp && resp.code !== undefined) ? resp.code : 200
        const raw = resp && resp.data !== undefined ? resp.data : resp
        let body = raw
        if (typeof raw === 'string' && raw.trim()) {
          try { body = JSON.parse(raw) } catch (_) { /* 非 JSON 保留原文，调用方按未就绪处理 */ }
        }
        resolve({ status, body, raw: resp })
      },
      fail: (msg, code) => reject(new Error(`fetch failed: ${msg} (${code})`))
    })
  })
}

export class ConfigOnboarding {
  constructor(llmClient, identity) {
    this.llm = llmClient
    this.identity = identity
    this._timer = null
    this._running = false
    this._code = ''
    this._setupBaseUrl = ''
    this._pollMs = DEFAULT_POLL_MS
    this._reapplies = 0
    // 页面轮询读这里：idle/no-url/requesting/waiting/applying/done/failed
    this.status = { phase: 'idle', code: '', qrValue: '', setupUrl: '', error: '' }
  }

  getStatus() {
    return this.status
  }

  _setStatus(patch) {
    this.status = Object.assign({}, this.status, patch)
    if (patch.qrValue !== undefined || patch.phase === 'failed' || patch.phase === 'no-url') {
      console.log('[ConfigOnboarding] ' + this.status.phase + ' ' + (this.status.error || this.status.qrValue || ''))
    }
  }

  async start() {
    if (this._running) return
    if (this.llm && this.llm.isConfigured && this.llm.isConfigured()) {
      this._setStatus({ phase: 'configured' })
      return
    }

    const setup = await this._loadSetupBase()
    if (!setup) {
      this._setStatus({
        phase: 'no-url',
        error: '未配置 setupBaseUrl（KV setup_config 或文件 setup-config.json）'
      })
      return
    }
    this._setupBaseUrl = setup.replace(/\/$/, '')
    this._running = true
    this._setStatus({ phase: 'requesting', setupUrl: this._setupBaseUrl + '/', qrValue: this._setupBaseUrl + '/' })

    try {
      const deviceId = (this.identity && this.identity.getDeviceId && this.identity.getDeviceId()) || 'unknown-device'
      const rootId = (this.identity && this.identity.getRootId && this.identity.getRootId()) || ''
      const created = await httpJson(this._setupBaseUrl + '/api/setup/sessions', {
        method: 'POST',
        data: { device_id: deviceId, root_id: rootId }
      })
      if (!created.body || !created.body.code) {
        throw new Error('签发设备码失败')
      }
      this._code = String(created.body.code).toUpperCase()
      this._pollMs = Number(created.body.poll_interval_ms) || DEFAULT_POLL_MS
      const setupUrl = created.body.setup_url || (this._setupBaseUrl + '/')
      // 二维码带上码，手机扫完直接进填 Key 页，省掉手输 6 位码
      const qrValue = setupUrl + (setupUrl.indexOf('?') === -1 ? '?' : '&') + 'code=' + this._code
      this._setStatus({ phase: 'waiting', code: this._code, setupUrl, qrValue, error: '' })
      const tip = `请用手机浏览器打开 ${setupUrl} 并输入设备码 ${this._code}`
      console.log('[ConfigOnboarding] ' + tip)
      await this._notify(tip)
      this._schedulePoll()
    } catch (e) {
      this._running = false
      this._setStatus({ phase: 'failed', error: e && e.message ? e.message : String(e) })
      console.warn('[ConfigOnboarding] start failed:', e && e.message ? e.message : e)
    }
  }

  stop() {
    this._running = false
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  _schedulePoll() {
    if (!this._running) return
    this._timer = setTimeout(() => this._pollOnce(), this._pollMs)
  }

  async _pollOnce() {
    if (!this._running || !this._code) return
    try {
      const url = `${this._setupBaseUrl}/api/setup/session/${this._code}/config`
      const res = await httpJson(url, { method: 'GET' })
      // 先判错误：错误体里同样没有 endpoint/apiKey，放在「未就绪」之后会被当成没配好一直轮询
      if (res.body && res.body.error) {
        const msg = String(res.body.error)
        // 码被服务端作废（重启/过期/已领取）就换新码继续等，别把用户卡死在失败页
        if (DEAD_CODE_RE.test(msg) && this._reapplies < MAX_REAPPLIES) {
          this._reapplies += 1
          console.log('[ConfigOnboarding] 设备码失效，重新申请（' + this._reapplies + '/' + MAX_REAPPLIES + '）：' + msg)
          this.stop()
          await this.start()
          return
        }
        this._setStatus({ phase: 'failed', error: msg })
        this._running = false
        return
      }
      // BlueOS fetch 对 204 的表现因平台而异：无 body / 空对象都当未就绪
      if (res.status === 204 || res.body == null || res.body === '' ||
          (typeof res.body === 'object' && !res.body.endpoint && !res.body.apiKey)) {
        // 会话还活着：重置重申预算，让每次「服务端重启」都各自有完整额度
        this._reapplies = 0
        this._schedulePoll()
        return
      }
      await this._applyConfig(res.body)
      this.stop()
    } catch (e) {
      console.warn('[ConfigOnboarding] poll failed, retry:', e && e.message ? e.message : e)
      this._schedulePoll()
    }
  }

  async _applyConfig(config) {
    if (!config || !config.endpoint || !config.apiKey) {
      throw new Error('配置不完整')
    }
    this._setStatus({ phase: 'applying' })
    const text = JSON.stringify({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model || 'gpt-4o-mini',
      apiMode: config.apiMode || 'openai-chat'
    })
    await Storage.writeFile('llm-config.json', text)
    if (this.llm && typeof this.llm.reload === 'function') {
      await this.llm.reload()
    } else if (this.llm && typeof this.llm.init === 'function') {
      await this.llm.init()
    }
    const configured = !!(this.llm && this.llm.isConfigured && this.llm.isConfigured())
    this._setStatus({ phase: configured ? 'done' : 'failed', error: configured ? '' : '写入后仍未配置' })
    console.log('[ConfigOnboarding] config applied, configured=' + configured)
    await this._notify('AI 配置已完成')
  }

  async _loadSetupBase() {
    try {
      const fromKv = await Storage.get(SETUP_CONFIG_KEY, null)
      if (fromKv && fromKv.baseUrl) return String(fromKv.baseUrl).trim()
    } catch (_) {}
    try {
      const raw = await Storage.readFile('setup-config.json', '')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.baseUrl) return String(parsed.baseUrl).trim()
      }
    } catch (_) {}
    return ''
  }

  async _notify(text) {
    try {
      if (Notification && typeof Notification.send === 'function') {
        await Notification.send('Pulse Agent', text)
      }
    } catch (e) {
      console.log('[ConfigOnboarding] notify skipped:', e && e.message ? e.message : e)
    }
  }
}
