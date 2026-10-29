/**
 * ContextManager - 管理 Agent 最近上下文
 * 使用 KV 存储保存最近 N 条消息。
 */

import { Storage } from '../platform/storage'

const CONTEXT_KEY = 'agent_context'
// 两条上限一起兜底长期使用后的 KV 体积：
// - maxMessages 按条数丢最旧的
// - maxChars 按总体积丢最旧的（只丢整条，不截断单条内容）
const DEFAULT_MAX_MESSAGES = 200
const DEFAULT_MAX_CHARS = 12000

export class ContextManager {
  constructor(maxMessages = DEFAULT_MAX_MESSAGES, maxChars = DEFAULT_MAX_CHARS) {
    this.maxMessages = maxMessages
    this.maxChars = maxChars
  }

  async init() {
    console.log('[ContextManager] init begin')
    this.messages = await Storage.get(CONTEXT_KEY, [])
    console.log('[ContextManager] init done, messages=' + this.messages.length)
  }

  async addMessage(role, content, extra = {}) {
    this.messages.push({
      role,
      content,
      timestamp: Date.now(),
      ...extra
    })
    await this._trim()
    await this._save()
  }

  async addToolResult(toolName, result) {
    await this.addMessage('tool', JSON.stringify(result), { toolName })
  }

  getMessages() {
    return this.messages.slice()
  }

  getRecentMessages(count = this.maxMessages) {
    return this.messages.slice(-count)
  }

  async clear() {
    this.messages = []
    await Storage.remove(CONTEXT_KEY)
  }

  async _trim() {
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages)
    }
    // 体积上限：只丢最旧的整条消息，最后一条永远保留
    while (this.messages.length > 1 && this._totalChars() > this.maxChars) {
      this.messages.shift()
    }
  }

  _totalChars() {
    return this.messages.reduce((sum, m) => sum + String(m.content || '').length, 0)
  }

  async _save() {
    await Storage.set(CONTEXT_KEY, this.messages)
  }
}
