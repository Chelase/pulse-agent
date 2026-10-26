/**
 * MCPClient - 通过 HTTP 接入 MCP server 的工具，并注册进 ToolRegistry
 *
 * 蓝河没有子进程，stdio 型 MCP server 起不来，所以只支持 HTTP 传输：
 * POST JSON-RPC 到 server 的 url，先 initialize + tools/list，再把每个工具
 * 代理成 Agent 可直接调用的工具。
 *
 * 配置来源 KV `mcp_config`：{ servers: [{ name, url }] }，由仓库控制面写入。
 */

import fetch from '@blueos.network.fetch'
import { Storage } from '../platform/storage'

const MCP_CONFIG_KEY = 'mcp_config'
const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_NAME = 'pulse-agent-blueos'

function rpc(url, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const header = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
    if (sessionId) header['Mcp-Session-Id'] = sessionId

    fetch.fetch({
      url,
      method: 'POST',
      responseType: 'json',
      header,
      data: { jsonrpc: '2.0', id: Date.now() + Math.floor(Math.random() * 1000), method, params },
      success: (resp) => {
        const body = resp && resp.data !== undefined ? resp.data : resp
        if (body && body.error) {
          reject(new Error(`${method} failed: ${(body.error && body.error.message) || JSON.stringify(body.error)}`))
          return
        }
        resolve({ result: body && body.result, sessionId: resp && resp.headers && (resp.headers['Mcp-Session-Id'] || resp.headers['mcp-session-id']) })
      },
      fail: (msg, code) => reject(new Error(`mcp request failed: ${msg} (${code})`))
    })
  })
}

export class MCPClient {
  constructor() {
    this.servers = []
    this.connected = []
  }

  async init() {
    const cfg = await Storage.get(MCP_CONFIG_KEY, null)
    this.servers = (cfg && Array.isArray(cfg.servers)) ? cfg.servers : []
    // 配置清空时也必须清掉上一轮的连接结果，否则 registerTools 会把已下线的
    // server 的工具再注册一遍。
    this.connected = []
    if (!this.servers.length) {
      console.log('[MCP] 未配置 mcp_config，跳过')
      return []
    }
    await this.discover()
    return this.connected
  }

  /** 逐个 server 握手并列出工具；单个 server 失败不影响其它（降级而非中断启动）。 */
  async discover() {
    this.connected = []
    for (const server of this.servers) {
      try {
        const hello = await rpc(server.url, 'initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: CLIENT_NAME, version: '0.1.0' },
          capabilities: {}
        })
        const listed = await rpc(server.url, 'tools/list', {}, hello.sessionId)
        const tools = (listed.result && listed.result.tools) || []
        this.connected.push({
          name: server.name || server.url,
          url: server.url,
          sessionId: hello.sessionId || '',
          tools
        })
        console.log(`[MCP] ${server.name} 接入 ${tools.length} 个工具`)
      } catch (e) {
        console.warn(`[MCP] ${server.name || server.url} 接入失败: ${e && e.message ? e.message : e}`)
      }
    }
    return this.connected
  }

  /**
   * 把 MCP 工具注册到 ToolRegistry。
   * 工具名加 `<server>__` 前缀，避免与内置工具撞名。
   */
  registerTools(toolRegistry) {
    let count = 0
    for (const server of this.connected) {
      for (const tool of server.tools) {
        const prefixed = `${server.name}__${tool.name}`
        toolRegistry.registerProxy({
          name: prefixed,
          description: tool.description || `MCP tool ${tool.name} on ${server.name}`,
          parameters: tool.inputSchema || {},
          execute: async (params) => {
            const res = await rpc(server.url, 'tools/call', { name: tool.name, arguments: params || {} }, server.sessionId)
            return res.result
          }
        })
        count += 1
      }
    }
    if (count) console.log(`[MCP] 注册外部工具 ${count} 个`)
    return count
  }
}
