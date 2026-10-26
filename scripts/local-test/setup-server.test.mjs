import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const require = createRequire(import.meta.url)
const { normalize } = require('../llm-config-store.js')

const PORT = 18790
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

async function json(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  })
  const text = await res.text()
  let body = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status: res.status, body }
}

async function main() {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/setup-server/server.js'), '--host', HOST, '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let boot = ''
  child.stdout.on('data', d => { boot += d.toString() })
  child.stderr.on('data', d => { boot += d.toString() })

  for (let i = 0; i < 50; i++) {
    if (boot.includes('[setup-server]')) break
    await wait(50)
  }

  try {
    const created = await json(BASE + '/api/setup/sessions', {
      method: 'POST',
      body: JSON.stringify({ device_id: 'test-device-1', root_id: 'root-x' })
    })
    assert.equal(created.status, 200)
    assert.match(created.body.code, /^[A-Z0-9]{6}$/)
    const code = created.body.code

    const pending = await json(BASE + `/api/setup/session/${code}/config`)
    assert.equal(pending.status, 204)

    const cfg = normalize({
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: 'sk-test-key-12345678',
      model: 'deepseek-chat',
    })

    const posted = await json(BASE + `/api/setup/session/${code}/config`, {
      method: 'POST',
      body: JSON.stringify(cfg)
    })
    assert.equal(posted.status, 200)
    assert.equal(posted.body.ok, true)

    const pulled = await json(BASE + `/api/setup/session/${code}/config`)
    assert.equal(pulled.status, 200)
    assert.equal(pulled.body.apiKey, cfg.apiKey)
    assert.equal(pulled.body.endpoint, cfg.endpoint)

    const again = await json(BASE + `/api/setup/session/${code}/config`)
    assert.ok(again.status === 404 || again.status === 410)

    const bad = await json(BASE + '/api/setup/sessions', { method: 'POST', body: '{}' })
    assert.equal(bad.status, 400)

    // 同一只表重申码：旧会话必须立刻作废，等待列表只剩新码一条
    const first = await json(BASE + '/api/setup/sessions', {
      method: 'POST',
      body: JSON.stringify({ device_id: 'test-device-dedupe' })
    })
    assert.equal(first.status, 200)
    const second = await json(BASE + '/api/setup/sessions', {
      method: 'POST',
      body: JSON.stringify({ device_id: 'test-device-dedupe' })
    })
    assert.equal(second.status, 200)
    assert.notEqual(second.body.code, first.body.code)

    const stale = await json(BASE + `/api/setup/session/${first.body.code}/config`)
    assert.equal(stale.status, 404)

    const waiting = await json(BASE + '/api/setup/sessions')
    const mine = waiting.body.waiting.filter(w => w.device_id === 'test-device-dedupe')
    assert.equal(mine.length, 1)
    assert.equal(mine[0].code, second.body.code)

    console.log('[setup-server.test] ok')
  } finally {
    child.kill('SIGTERM')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
