/**
 * ToolRegistry - 工具注册与调度
 * 内置工具：文件读写、通知、振动、健康/传感器查询。
 */

import { FileManager } from './file-manager'
import { Notification } from '../platform/notification'
import { Vibrator } from '../platform/vibrator'

export class ToolRegistry {
  constructor(fileManager, sensorBridge, healthBridge) {
    this.fileManager = fileManager
    this.sensorBridge = sensorBridge
    this.healthBridge = healthBridge
    this.tools = []
    this._registerBuiltins()
  }

  getTools() {
    return this.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }

  /** 运行期注册（MCP 等外部来源）；同名直接覆盖并告警。 */
  registerProxy(tool) {
    if (!tool || !tool.name || typeof tool.execute !== 'function') {
      throw new Error('registerProxy 需要 name 与 execute')
    }
    const dup = this.tools.findIndex(t => t.name === tool.name)
    if (dup !== -1) {
      console.warn('[ToolRegistry] 覆盖同名工具:', tool.name)
      this.tools.splice(dup, 1)
    }
    this.tools.push({
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || {},
      execute: tool.execute
    })
    return tool.name
  }

  has(name) {
    return !!this.tools.find(t => t.name === name)
  }

  async execute(name, params = {}) {
    const tool = this.tools.find(t => t.name === name)
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }
    return tool.execute(params)
  }

  _registerBuiltins() {
    this.tools.push({
      name: 'file_read',
      description: '读取本地文件内容',
      parameters: { path: 'string' },
      execute: async ({ path }) => {
        const content = await this.fileManager.read(path)
        return { success: true, path, content }
      }
    })

    this.tools.push({
      name: 'file_write',
      description: '写入内容到本地文件',
      parameters: { path: 'string', content: 'string' },
      execute: async ({ path, content }) => {
        await this.fileManager.write(path, content)
        return { success: true, path }
      }
    })

    this.tools.push({
      name: 'notification_send',
      description: '发送通知',
      parameters: { title: 'string', text: 'string' },
      execute: async ({ title, text }) => {
        await Notification.send(title, text)
        return { success: true }
      }
    })

    this.tools.push({
      name: 'vibrate',
      description: "触发振动反馈，mode 取 'short' 或 'long'",
      parameters: { mode: 'string' },
      execute: async ({ mode = 'short' }) => {
        await Vibrator.vibrate(mode)
        return { success: true, mode }
      }
    })

    this.tools.push({
      name: 'get_heart_rate',
      description: '获取最新心率数据',
      parameters: {},
      execute: async () => {
        return { success: true, heartRate: this.healthBridge.getState().heartRate }
      }
    })

    this.tools.push({
      name: 'get_step_count',
      description: '获取今日步数',
      parameters: {},
      execute: async () => {
        return { success: true, stepCount: this.healthBridge.getState().stepCount }
      }
    })

    this.tools.push({
      name: 'get_sensor_data',
      description: '获取传感器状态',
      parameters: {},
      execute: async () => {
        return { success: true, data: this.sensorBridge.getState() }
      }
    })
  }
}
