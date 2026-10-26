/**
 * ContextManager - 管理 Agent 最近上下文
 * 使用 KV 存储保存最近 N 条消息。
 */

import { Storage } from '../platform/storage'

const CONTEXT_KEY = 'agent_context'
// 不截断对话内容的语义上限；只防「每次 addMessage 全量写 KV」在长期使用后失控
const DEFAULT_MAX_MESSAGES = 200

export class ContextManager {
  constructor(maxMessages = DEFAULT_MAX_MESSAGES) {
    this.maxMessages = maxMessages
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
  }

  async _save() {
    await Storage.set(CONTEXT_KEY, this.messages)
  }
}
