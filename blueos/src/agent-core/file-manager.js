/**
 * FileManager - 文件操作封装
 * 基于 platform/storage.js 提供 Agent 友好的文件接口。
 */

import { Storage } from '../platform/storage'

export class FileManager {
  async read(path, defaultValue = '') {
    return Storage.readFile(path, defaultValue)
  }

  async write(path, content) {
    return Storage.writeFile(path, content)
  }

  async append(path, content) {
    return Storage.appendFile(path, content)
  }

  async delete(path) {
    return Storage.deleteFile(path)
  }

  async exists(path) {
    return Storage.fileExists(path)
  }
}
