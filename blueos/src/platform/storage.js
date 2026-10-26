/**
 * Storage - BlueOS 存储封装
 * 统一封装 KV 存储和文件存储，为 Agent 执行层提供平台无关接口。
 */

import storage from '@blueos.storage.storage'
import file from '@blueos.storage.file'

const AGENT_DIR = 'internal://files/agent'

/**
 * 幂等创建目录。
 *
 * 平台在目录已存在时也会走 fail（消息形如「目录/文件 xxx 已经存在。」），
 * 所以失败后必须用 access 复核，不能把 fail 一律当错误——否则第二次启动、
 * 或每次 writeFile 都会炸。
 */
function ensureDirExists(uri) {
  return new Promise((resolve, reject) => {
    file.mkdir({
      uri,
      recursive: true,
      success: () => resolve(),
      fail: (data, code) => {
        file.access({
          uri,
          success: () => resolve(),
          fail: () => reject(new Error(`mkdir failed: ${data} (${code})`))
        })
      }
    })
  })
}

function ensureAgentDir() {
  return ensureDirExists(AGENT_DIR)
}

function parseValue(raw, defaultValue) {
  if (raw === undefined || raw === null || raw === '') return defaultValue
  // BlueOS storage.get success 可能直接返回值，也可能包在 { data } / { value } 中
  const value = raw && (raw.value !== undefined) ? raw.value
    : (raw && raw.data !== undefined) ? raw.data
    : raw
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (e) {
    return value
  }
}

export const Storage = {
  /**
   * KV 存储 - 设置
   */
  set(key, value) {
    return new Promise((resolve, reject) => {
      storage.set({
        key,
        value: JSON.stringify(value),
        success: () => resolve(),
        fail: (data, code) => reject(new Error(`storage.set failed: ${data} (${code})`))
      })
    })
  },

  /**
   * KV 存储 - 读取
   */
  get(key, defaultValue = null) {
    return new Promise((resolve) => {
      storage.get({
        key,
        success: (res) => resolve(parseValue(res, defaultValue)),
        fail: () => resolve(defaultValue)
      })
    })
  },

  /**
   * KV 存储 - 删除
   */
  remove(key) {
    return new Promise((resolve, reject) => {
      storage.delete({
        key,
        success: () => resolve(),
        fail: (data, code) => reject(new Error(`storage.delete failed: ${data} (${code})`))
      })
    })
  },

  /**
   * 文件 - 写入文本
   */
  async writeFile(filename, text, append = false) {
    await ensureAgentDir()
    return new Promise((resolve, reject) => {
      file.writeText({
        uri: `${AGENT_DIR}/${filename}`,
        text,
        append,
        success: () => resolve(),
        fail: (data, code) => reject(new Error(`writeFile failed: ${data} (${code})`))
      })
    })
  },

  /**
   * 文件 - 读取文本
   */
  async readFile(filename, defaultValue = '') {
    return new Promise((resolve) => {
      file.readText({
        uri: `${AGENT_DIR}/${filename}`,
        success: (res) => resolve(res && res.text !== undefined ? res.text : defaultValue),
        fail: () => resolve(defaultValue)
      })
    })
  },

  /**
   * 文件 - 追加文本
   */
  async appendFile(filename, text) {
    return this.writeFile(filename, text, true)
  },

  /**
   * 文件 - 删除
   */
  async deleteFile(filename) {
    return new Promise((resolve, reject) => {
      file.delete({
        uri: `${AGENT_DIR}/${filename}`,
        success: () => resolve(),
        fail: (data, code) => reject(new Error(`deleteFile failed: ${data} (${code})`))
      })
    })
  },

  /**
   * 文件 - 判断存在
   */
  async fileExists(filename) {
    return new Promise((resolve) => {
      file.access({
        uri: `${AGENT_DIR}/${filename}`,
        success: () => resolve(true),
        fail: () => resolve(false)
      })
    })
  },

  /**
   * 文件 - 确保子目录存在（相对 AGENT_DIR），幂等
   */
  async ensureDir(relativePath) {
    await ensureAgentDir()
    if (!relativePath) return
    return ensureDirExists(`${AGENT_DIR}/${relativePath}`)
  }
}
