'use strict'

/**
 * 设备码首启 Setup 服务（一期）：签发码、收 H5 配置、供手表拉取（一次性）。
 * 用法：node scripts/setup-server/server.js [--host 127.0.0.1] [--port 8790]
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { normalize, validate, publicConfig, defaults, API_MODES, completeEndpoint, lanIPv4, lanCandidates } = require('../llm-config-store')

const HOST = argValue('--host') || process.env.PULSE_SETUP_HOST || '127.0.0.1'
const PORT = Number(argValue('--port') || process.env.PULSE_SETUP_PORT || 8790)
const CODE_TTL_MS = Number(process.env.PULSE_SETUP_CODE_TTL_MS || 15 * 60 * 1000)
const POLL_INTERVAL_MS = Number(process.env.PULSE_SETUP_POLL_MS || 2000)
const PROBE_TIMEOUT_MS = Number(process.env.PULSE_SETUP_PROBE_TIMEOUT_MS || 30 * 1000)
const PUBLIC_DIR = path.join(__dirname, 'public')

/** @type {Map<string, object>} */
const sessions = new Map()

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  const bytes = crypto.randomBytes(6)
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

function now() { return Date.now() }

function purgeExpired() {
  const t = now()
  for (const [code, s] of sessions) {
    if (s.expiresAt <= t || s.consumed) sessions.delete(code)
  }
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(raw)
}

function sendNoContent(res) {
  res.writeHead(204, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end()
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('JSON 无效')) }
    })
    req.on('error', reject)
  })
}

function serveStatic(req, res) {
  let urlPath = (req.url || '/').split('?')[0]
  if (urlPath === '/') urlPath = '/index.html'
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath.replace(/^\/+/, '')))
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden')
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('not found')
  }
  const ext = path.extname(file)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}

/**
 * 连通性探测：按 API 模式构造请求。
 * 表上真正发请求的是 blueos/src/agent-core/llm-adapters.js，这里只复刻探测所需的最小形状，
 * 两者的模式 id 一致性由 scripts/local-test/api-modes.test.mjs 卡住。
 */
function buildProbe(config) {
  const mode = config.apiMode || API_MODES.default
  if (mode === 'anthropic-messages') {
    return {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: { model: config.model, system: '连接测试。只回复 OK。', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }
    }
  }
  if (mode === 'openai-responses') {
    return {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: { model: config.model, instructions: '连接测试。只回复 OK。', input: [{ role: 'user', content: 'ping' }] }
    }
  }
  return {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: {
      model: config.model,
      messages: [{ role: 'system', content: '连接测试。只回复 OK。' }, { role: 'user', content: 'ping' }],
      max_tokens: 16,
      temperature: 0
    }
  }
}

function probeErrorReason(body) {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.error === 'string') return body.error
  if (body.error && (body.error.message || body.error.type)) return body.error.message || body.error.type
  return body.message || ''
}

function probeTookText(mode, body) {
  if (mode === 'anthropic-messages') {
    return Array.isArray(body.content) && body.content.some(p => p && p.type === 'text' && p.text)
  }
  if (mode === 'openai-responses') {
    return Array.isArray(body.output) && JSON.stringify(body.output).indexOf('text') !== -1
  }
  return !!(body.choices && body.choices[0])
}

async function testConnection(config) {
  // 存的是原样地址，探测时按模式补全路径（与表上适配器同一套规则）
  const mode = config.apiMode || API_MODES.default
  const probe = buildProbe(config)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const resp = await fetch(completeEndpoint(config.endpoint, mode), {
      method: 'POST',
      headers: probe.headers,
      body: JSON.stringify(probe.body),
      signal: ctrl.signal
    })
    const text = await resp.text()
    let body
    try { body = JSON.parse(text) } catch (_) { body = null }
    const reason = probeErrorReason(body)
    if (!resp.ok || reason) {
      throw new Error(reason || text.slice(0, 200) || ('HTTP ' + resp.status))
    }
    if (!body || !probeTookText(mode, body)) throw new Error('响应里没有可读文本，检查模型名与地址是否属于同一模式')
    return { ok: true }
  } catch (e) {
    // 超时是这里唯一的 abort 来源：掐断后 undici 只会报英文的 "This operation was aborted"
    if (e && e.name === 'AbortError') {
      throw new Error('连接测试超过 ' + Math.round(PROBE_TIMEOUT_MS / 1000) + ' 秒无响应，已中止：远端太慢或网络不通')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function handleApi(req, res, pathname) {
  purgeExpired()

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    return res.end()
  }

  if (req.method === 'POST' && pathname === '/api/setup/sessions') {
    const body = await readBody(req)
    const deviceId = String(body.device_id || '').trim()
    if (!deviceId) return sendJson(res, 400, { error: '缺少 device_id' })
    // 一只表同时只留一个活码：重申（过期自愈/重启）时旧会话立刻作废，
    // 否则等待列表里同一只表出两个按钮，点旧的会把配置写进表已不再轮询的死会话
    for (const [oldCode, s] of sessions) {
      if (s.deviceId === deviceId) sessions.delete(oldCode)
    }
    let code = genCode()
    while (sessions.has(code)) code = genCode()
    const session = {
      code,
      deviceId,
      rootId: String(body.root_id || '').trim(),
      createdAt: now(),
      expiresAt: now() + CODE_TTL_MS,
      ready: false,
      consumed: false,
      config: null
    }
    sessions.set(code, session)
    maybeOpenWithCode(code)
    return sendJson(res, 200, {
      code,
      expires_at: new Date(session.expiresAt).toISOString(),
      poll_interval_ms: POLL_INTERVAL_MS,
      setup_url: `http://${publicHost}:${PORT}/`
    })
  }

  const sessionMatch = pathname.match(/^\/api\/setup\/session\/([A-Z0-9]{6})$/i)
  const configMatch = pathname.match(/^\/api\/setup\/session\/([A-Z0-9]{6})\/config$/i)

  if (req.method === 'GET' && sessionMatch) {
    const code = sessionMatch[1].toUpperCase()
    const s = sessions.get(code)
    if (!s || s.expiresAt <= now()) return sendJson(res, 404, { error: '设备码无效或已过期：手表在等配置时才会有码，请扫手表屏幕上的二维码' })
    return sendJson(res, 200, {
      code: s.code,
      status: s.consumed ? 'consumed' : (s.ready ? 'ready' : 'pending'),
      expires_at: new Date(s.expiresAt).toISOString(),
      device_id: s.deviceId
    })
  }

  if (req.method === 'POST' && configMatch) {
    const code = configMatch[1].toUpperCase()
    const s = sessions.get(code)
    if (!s || s.expiresAt <= now()) return sendJson(res, 404, { error: '设备码无效或已过期：手表在等配置时才会有码，请扫手表屏幕上的二维码' })
    if (s.consumed) return sendJson(res, 410, { error: '码已使用' })
    const body = await readBody(req)
    let config
    try {
      config = normalize(body)
      validate(config)
      if (!config.apiKey) throw new Error('缺少 apiKey')
    } catch (e) {
      return sendJson(res, 400, { error: e.message || String(e) })
    }
    s.config = config
    s.ready = true
    return sendJson(res, 200, { ok: true, preview: publicConfig({ ...config, _exists: true }) })
  }

  if (req.method === 'GET' && configMatch) {
    const code = configMatch[1].toUpperCase()
    const s = sessions.get(code)
    if (!s || s.expiresAt <= now()) return sendJson(res, 404, { error: '设备码无效或已过期：手表在等配置时才会有码，请扫手表屏幕上的二维码' })
    if (!s.ready || !s.config) return sendNoContent(res)
    if (s.consumed) return sendJson(res, 410, { error: '配置已领取' })
    s.consumed = true
    const cfg = s.config
    sessions.delete(code)
    return sendJson(res, 200, cfg)
  }

  if (req.method === 'POST' && pathname === '/api/setup/test-connection') {
    const body = await readBody(req)
    let config
    try {
      config = normalize(body)
      validate(config)
      if (!config.apiKey) throw new Error('缺少 apiKey')
    } catch (e) {
      return sendJson(res, 400, { error: e.message || String(e) })
    }
    try {
      await testConnection(config)
      return sendJson(res, 200, { ok: true })
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message || String(e) })
    }
  }

  // 供 sync-simulator 询问：手表要访问的地址以服务端实际对外地址为准，避免两边各猜一个网卡
  if (req.method === 'GET' && pathname === '/api/setup/info') {
    return sendJson(res, 200, {
      public_url: `http://${publicHost}:${PORT}/`,
      candidates: lanCandidates()
    })
  }

  // 正在等待配置的手表：H5 用它做「点一下就填码」，不用人肉抄 6 位码
  if (req.method === 'GET' && pathname === '/api/setup/sessions') {
    return sendJson(res, 200, {
      waiting: [...sessions.values()].map(s => ({
        code: s.code,
        device_id: s.deviceId,
        expires_at: new Date(s.expiresAt).toISOString()
      }))
    })
  }

  if (req.method === 'GET' && pathname === '/api/setup/presets') {
    return sendJson(res, 200, {
      presets: [
        { id: 'openai', label: 'OpenAI', apiMode: 'openai-chat', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
        { id: 'deepseek', label: 'DeepSeek', apiMode: 'openai-chat', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
        { id: 'anthropic', label: 'Anthropic', apiMode: 'anthropic-messages', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-5' },
        { id: 'custom', label: '自定义（OpenAI 兼容）', apiMode: API_MODES.default, endpoint: defaults().endpoint, model: defaults().model }
      ],
      modes: API_MODES.modes,
      defaultMode: API_MODES.default
    })
  }

  return sendJson(res, 404, { error: 'not found' })
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    if (u.pathname.startsWith('/api/')) {
      await handleApi(req, res, u.pathname)
    } else {
      serveStatic(req, res)
    }
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) })
  }
})

/** 打开本机默认浏览器；--no-open 关掉（桩测必须关，否则每跑一次弹一次）。 */
function openBrowser(url) {
  const { spawn } = require('child_process')
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => console.log('[setup-server] 浏览器没自动打开，请手动访问 ' + url))
    child.unref()
  } catch (e) {
    console.log('[setup-server] 浏览器没自动打开，请手动访问 ' + url)
  }
}

let openedWithCode = false

/**
 * 手表申请到码的那一刻才弹浏览器，并带上码——启动就弹只能弹出一个未绑定页，
 * 因为那时码还不存在。只弹一次，后续的码打进日志。
 */
function maybeOpenWithCode(code) {
  const url = `http://${listenHost}:${PORT}/?code=${code}`
  if (process.argv.indexOf('--no-open') === -1 && !openedWithCode) {
    openedWithCode = true
    console.log('[setup-server] 手表已申请设备码，打开带码页面：' + url)
    openBrowser(url)
  } else {
    console.log('[setup-server] 新设备码：' + url)
  }
}

const listenHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST
// 二维码/引导地址要给手表看：绑 0.0.0.0 时不能回 127.0.0.1，得是局域网可达地址
const publicHost = argValue('--public-ip') || (HOST === '0.0.0.0' ? (lanIPv4() || '127.0.0.1') : HOST)

server.listen(PORT, HOST, () => {
  console.log(`[setup-server] http://${listenHost}:${PORT}/`)
  console.log('[setup-server] 等手表申请设备码后再弹浏览器；手表轮询 GET /api/setup/session/:code/config')
})
