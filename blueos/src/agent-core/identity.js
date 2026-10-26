/**
 * Identity - Agent 身份管理
 * 使用 root_id 作为统一身份标识，持久化到 KV storage。
 */

import { Storage } from '../platform/storage'

const DEVICE_ID_KEY = 'agent_device_id'
const DEVICE_TYPE = 'blueos_watch'

export class Identity {
  constructor() {
    this._deviceId = null
  }

  async init() {
    console.log('[Identity] init begin')
    let id = await Storage.get(DEVICE_ID_KEY, null)
    console.log('[Identity] loaded id=' + id)
    if (!id) {
      id = this._generateId()
      await Storage.set(DEVICE_ID_KEY, id)
      console.log('[Identity] generated new id=' + id)
    }
    this._deviceId = id
    console.log('[Identity] deviceId=' + this._deviceId)
    return this._deviceId
  }

  getDeviceId() {
    return this._deviceId
  }

  getRootId() {
    if (!this._deviceId) {
      throw new Error('Identity not initialized')
    }
    return `${DEVICE_TYPE}:${this._deviceId}`
  }

  _generateId() {
    const ts = Date.now().toString(36)
    const rand = Math.random().toString(36).substring(2, 10)
    return `${ts}${rand}`
  }
}
