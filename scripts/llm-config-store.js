'use strict'

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_CONFIG_FILE = path.join(REPO_ROOT, 'config', 'llm-config.local.json')

/** 模式清单的唯一来源是契约层，表上适配器（llm-adapters.js）的 id 必须与它一致 */
const API_MODES = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'common', 'models', 'api-modes.json'), 'utf8'))
const MODE_IDS = API_MODES.modes.map(m => m.id)

function apiModeOf(id) {
  return API_MODES.modes.find(m => m.id === id) || API_MODES.modes[0]
}

function getConfigFile(explicitPath) {
  return path.resolve(explicitPath || process.env.PULSE_LLM_CONFIG_FILE || DEFAULT_CONFIG_FILE)
}

/**
 * 候选局域网 IPv4（按默认网段优先级排序）。
 * 不按网卡名排除：这台机器真正对外的就是 vEthernet (WSL-Bridge)（桥在物理网卡上），
 * 按名字过滤会把它误杀。只排掉回环和 APIPA 自动私有地址。
 */
const SKIP_ADAPTER = /loopback|isatap|teredo/i
const APIPA = /^169\.254\./

function lanCandidates() {
  const os = require('os')
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (SKIP_ADAPTER.test(name)) continue
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal && !APIPA.test(net.address)) out.push({ name, address: net.address })
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3)
  return out.sort((a, b) => rank(a.address) - rank(b.address))
}

/**
 * 默认路由实际走的那个本机地址：开一个 UDP socket 连公网地址（不会真的发包），
 * 读它绑定的本地地址。这是唯一能跨「物理网卡 / 桥接虚拟网卡 / VPN」都选对的判法。
 */
function routeAddress() {
  try {
    const dgram = require('dgram')
    const sock = dgram.createSocket('udp4')
    sock.connect('223.5.5.5', 53)
    const local = sock.address().address
    sock.disconnect()
    sock.close()
    return APIPA.test(local) || local.startsWith('127.') ? '' : local
  } catch (err) {
    return ''
  }
}

function lanIPv4() {
  const byRoute = routeAddress()
  if (byRoute) return byRoute
  const first = lanCandidates()[0]
  return first ? first.address : ''
}

function defaultSetupBaseUrl() {
  const port = process.env.PULSE_SETUP_PORT || 8790
  const ip = lanIPv4()
  return ip ? `http://${ip}:${port}` : ''
}

function defaults() {
  return {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini',
    apiMode: API_MODES.default
  }
}

/**
 * 端点路径补全：只填基址（`.../v1`）时补上当前模式要求的路径；
 * 末尾是别的模式的路径（切了 API 模式没改地址）就替换成当前模式的。
 * 只在真正发请求时调用——存下来和显示的都必须是你填的原样。
 */
function completeEndpoint(endpoint, apiMode) {
  const mode = apiModeOf(apiMode)
  let url
  try {
    url = new URL(endpoint)
  } catch (err) {
    return endpoint
  }
  if (url.pathname.endsWith(mode.endpointSuffix)) return endpoint
  const foreign = API_MODES.modes.find(m => m.id !== mode.id && url.pathname.endsWith(m.endpointSuffix))
  url.pathname = foreign
    ? url.pathname.slice(0, -foreign.endpointSuffix.length) + mode.endpointSuffix
    : url.pathname.replace(/\/+$/, '') + mode.endpointSuffix
  return url.toString()
}

function normalize(input) {
  const value = input && typeof input === 'object' ? input : {}
  return {
    endpoint: String(value.endpoint || defaults().endpoint).trim(),
    apiKey: String(value.apiKey || '').trim(),
    model: String(value.model || defaults().model).trim(),
    apiMode: MODE_IDS.includes(value.apiMode) ? value.apiMode : API_MODES.default
  }
}

function validate(config) {
  if (!config.endpoint) throw new Error('缺少 endpoint')
  let url
  try {
    url = new URL(config.endpoint)
  } catch (err) {
    throw new Error('endpoint 不是有效 URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('endpoint 只支持 http/https')
  if (!config.model) throw new Error('缺少 model')
}

function readConfig(filePath) {
  const target = getConfigFile(filePath)
  if (!fs.existsSync(target)) return { ...defaults(), _file: target, _exists: false }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch (err) {
    throw new Error(`配置文件不是有效 JSON: ${target}`)
  }
  const config = normalize(parsed)
  validate(config)
  return { ...config, _file: target, _exists: true }
}

function saveConfig(input, filePath) {
  const target = getConfigFile(filePath)
  const config = normalize(input)
  validate(config)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return { ...config, _file: target, _exists: true }
}

function maskApiKey(apiKey) {
  if (!apiKey) return ''
  if (apiKey.length <= 8) return '********'
  return apiKey.slice(0, 4) + '...' + apiKey.slice(-4)
}

function publicConfig(config) {
  return {
    endpoint: config.endpoint,
    model: config.model,
    apiMode: normalize(config).apiMode,
    hasApiKey: !!config.apiKey,
    apiKeyPreview: maskApiKey(config.apiKey),
    file: config._file,
    exists: !!config._exists
  }
}

module.exports = {
  DEFAULT_CONFIG_FILE,
  API_MODES,
  apiModeOf,
  completeEndpoint,
  defaults,
  getConfigFile,
  lanIPv4,
  lanCandidates,
  defaultSetupBaseUrl,
  normalize,
  validate,
  readConfig,
  saveConfig,
  maskApiKey,
  publicConfig
}
