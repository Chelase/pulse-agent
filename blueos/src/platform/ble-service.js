/**
 * BleService - 手表侧 BLE GATT Server（本平台唯一可用的「入站服务面」）
 *
 * 蓝河没有端口监听 API：通信能力只有蓝牙/上传下载/数据请求/websocket/网络状态，
 * 后四类全是客户端。BLE 文档明确支持本机作外围设备（GATT 服务端）：
 * createGattServer + addService + startAdvertising + 订阅写请求 + notify。
 * 所以「外部 Agent 调用手表」在这里的形态是：对端连上来写一个特征值，手表回读/通知。
 *
 * 默认不启用（ble_config 里没有 enabled=true 就不注册），因为特征值 properties 的
 * 字段形态与 ArrayBuffer 行为仍需真机核对。
 */

import bluetooth from '@blueos.bluetooth.ble'
import { Storage } from '../platform/storage'

const BLE_CONFIG_KEY = 'ble_config'

/** 协议：文本帧 UTF-8，写在 cmd 特征上；结果从 resp 特征 read/notify 回去。 */
export const BLE_SERVICE_UUID = '0000f380-0000-1000-8000-00805f9b34fb'
export const BLE_CMD_CHAR_UUID = '0000f381-0000-1000-8000-00805f9b34fb'
export const BLE_RESP_CHAR_UUID = '0000f382-0000-1000-8000-00805f9b34fb'

function utf8Encode(text) {
  const out = []
  const str = String(text == null ? '' : text)
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(++i)
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return new Uint8Array(out)
}

function utf8Decode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0)
  let str = ''
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]
    if (b < 0x80) { str += String.fromCharCode(b); i += 1 }
    else if (b < 0xe0) { str += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2 }
    else if (b < 0xf0) { str += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3 }
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      const v = cp - 0x10000
      str += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
      i += 4
    }
  }
  return str
}

export class BleService {
  constructor(onCommand) {
    this.onCommand = onCommand
    this.server = null
    this.enabled = false
    this._lastDeviceId = ''
    this._pendingRead = ''
  }

  /**
   * @returns {Promise<boolean>} 是否已启用
   */
  async start() {
    const cfg = await Storage.get(BLE_CONFIG_KEY, null)
    if (!cfg || cfg.enabled !== true) {
      console.log('[BleService] ble_config 未启用，跳过入站服务面')
      return false
    }

    try {
      this.server = bluetooth.BLE.createGattServer()
      const added = this.server.addService({
        serviceUuid: cfg.serviceUuid || BLE_SERVICE_UUID,
        isPrimary: true,
        characteristics: [
          { serviceUuid: cfg.serviceUuid || BLE_SERVICE_UUID, characteristicUuid: BLE_CMD_CHAR_UUID, properties: { read: false, write: true, notify: false } },
          { serviceUuid: cfg.serviceUuid || BLE_SERVICE_UUID, characteristicUuid: BLE_RESP_CHAR_UUID, properties: { read: true, write: false, notify: true } }
        ]
      })
      if (!added) throw new Error('addService 返回 false')

      this.server.subscribeCharacteristicWrite({
        callback: (req) => this._onWrite(req),
        fail: (data, code) => console.warn(`[BleService] 写订阅失败: ${data} (${code})`)
      })

      this.server.startAdvertising(
        { interval: 1600, txPower: -7, connectable: true },
        { serviceUuids: [cfg.serviceUuid || BLE_SERVICE_UUID] },
        { serviceUuids: [cfg.serviceUuid || BLE_SERVICE_UUID] }
      )
      this.enabled = true
      console.log('[BleService] GATT 服务已广播，等待对端连接')
      return true
    } catch (e) {
      console.warn('[BleService] 启动失败，降级为仅外连模式:', e && e.message ? e.message : e)
      this.enabled = false
      return false
    }
  }

  async _onWrite(req) {
    const text = utf8Decode(req && req.value)
    console.log('[BleService] 收到指令:', text)
    this._lastDeviceId = (req && req.deviceId) || this._lastDeviceId

    // 先按协议回执，避免 client 侧写请求超时；真正的执行结果走 notify
    if (req && req.needRsp && this.server) {
      this.server.sendResponse({
        deviceId: req.deviceId,
        transId: req.transId,
        status: 0,
        offset: req.offset || 0,
        value: new Uint8Array([0]).buffer
      })
    }

    let result
    try {
      result = await this.onCommand(text)
    } catch (e) {
      result = { task_id: '', status: 'failed', error: e && e.message ? e.message : String(e) }
    }
    this.notify(JSON.stringify(result))
    return result
  }

  /** 结果既给 read 用（下次读拿到最后一帧），也给 notify 用。 */
  notify(payload) {
    this._pendingRead = String(payload)
    if (!this.enabled || !this.server || !this._lastDeviceId) return false
    const bytes = utf8Encode(payload)
    try {
      return this.server.notifyCharacteristicChanged(this._lastDeviceId, {
        serviceUuid: BLE_SERVICE_UUID,
        characteristicUuid: BLE_RESP_CHAR_UUID,
        value: bytes.buffer
      })
    } catch (e) {
      console.warn('[BleService] notify 失败:', e && e.message ? e.message : e)
      return false
    }
  }
}

export const bleCodec = { utf8Encode, utf8Decode }
