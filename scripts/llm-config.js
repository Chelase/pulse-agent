'use strict'

const fs = require('fs')
const path = require('path')
const {
  readConfig,
  saveConfig,
  publicConfig,
  getConfigFile
} = require('./llm-config-store')

function usage() {
  console.log(`Pulse Agent LLM 配置 CLI

用法:
  node scripts/llm-config.js show [--file <path>]
  node scripts/llm-config.js set [选项]
  node scripts/llm-config.js clear [--file <path>]
  node scripts/llm-config.js sync-simulator [--root <sdcard/agent>] [--file <path>]

set 选项:
  --endpoint <url>        完整请求地址，末尾路径需与 --api-mode 匹配
  --api-mode <id>         openai-chat（默认）/ anthropic-messages / openai-responses
  --model <name>          模型名称
  --api-key <key>         API Key（也可用 --api-key-stdin）
  --api-key-stdin         从 stdin 读取 API Key，避免进入 shell 历史
  --file <path>           自定义本地配置文件路径

sync-simulator:
  将本地配置复制到 BlueOS 模拟器的 agent 目录；也可用 --root 指定目录。
  同时写入 setup-config.json（首启引导地址），默认 http://<本机局域网IP>:8790，可用 --setup-url 覆盖。
  默认目录：%APPDATA%/BlueOSStudio/simulator/sdcard/internal/com.pulse.agent/files/agent

安全边界:
  默认只监听 127.0.0.1，不暴露到局域网；配置文件含 API Key，不要提交到 Git。
`)
}

function parseArgs(argv) {
  const result = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value.startsWith('--')) {
      result._.push(value)
      continue
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (key === 'apiKeyStdin') result[key] = true
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) result[key] = argv[++i]
    else result[key] = true
  }
  return result
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
    process.stdin.on('error', reject)
  })
}

function printConfig(config) {
  console.log(JSON.stringify(publicConfig(config), null, 2))
}

async function setCommand(args) {
  const current = readConfig(args.file)
  const next = { ...current }
  if (typeof args.apiMode === 'string') next.apiMode = args.apiMode
  if (typeof args.endpoint === 'string') next.endpoint = args.endpoint
  if (typeof args.model === 'string') next.model = args.model
  if (typeof args.apiKey === 'string') next.apiKey = args.apiKey
  if (args.apiKeyStdin) next.apiKey = await readStdin()

  const saved = saveConfig(next, args.file)
  console.log('已保存模型配置（API Key 已脱敏）：')
  printConfig(saved)
}

function clearCommand(args) {
  const file = getConfigFile(args.file)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  console.log(`已删除本地配置：${file}`)
}

function defaultSimulatorRoot() {
  if (process.platform !== 'win32' || !process.env.APPDATA) return ''
  return path.join(
    process.env.APPDATA,
    'BlueOSStudio',
    'simulator',
    'sdcard',
    'internal',
    'com.pulse.agent',
    'files',
    'agent'
  )
}

/** 问正在跑的 setup-server 它对外是哪个地址；问不到返回 null，退到本机探测 */
function askSetupInfo(port) {
  return new Promise((resolve) => {
    const http = require('http')
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/setup/info', method: 'GET', headers: { Connection: 'close' }, timeout: 800 }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { resolve(null) }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
    req.end()
  })
}

async function syncSimulatorCommand(args) {
  const source = getConfigFile(args.file)
  if (!fs.existsSync(source)) throw new Error(`本地配置不存在，请先执行 set：${source}`)
  const fallbackRoot = defaultSimulatorRoot()
  if (!args.root && !fallbackRoot) {
    throw new Error('未找到默认模拟器目录（非 Windows 或未设 APPDATA），请用 --root 指定 agent 目录')
  }
  const targetRoot = path.resolve(args.root || fallbackRoot)
  fs.mkdirSync(targetRoot, { recursive: true })
  const target = path.join(targetRoot, 'llm-config.json')
  fs.copyFileSync(source, target)
  console.log(`已同步到 BlueOS 模拟器：${target}`)

  // 引导地址：手表未配置 LLM 时靠它申请设备码并轮询配置，缺了首启引导直接跳过
  const store = require('./llm-config-store')
  const setupPort = Number(process.env.PULSE_SETUP_PORT || 8790)
  const info = args.setupUrl ? null : await askSetupInfo(setupPort)
  const baseUrl = (args.setupUrl || (info && info.public_url) || store.defaultSetupBaseUrl() || '').replace(/\/$/, '')
  if (baseUrl) {
    const setupFile = path.join(targetRoot, 'setup-config.json')
    fs.writeFileSync(setupFile, JSON.stringify({ baseUrl }, null, 2) + '\n')
    console.log(`已写入引导地址：${setupFile} → ${baseUrl}${info && !args.setupUrl ? '（取自运行中的 setup-server）' : ''}`)
    console.log('手表未配置时会在屏幕上出二维码，手机扫码即可打开配置页。')
  } else {
    const candidates = store.lanCandidates()
    console.warn('警告：没探测到可用的局域网地址（默认路由也拿不到），未写 setup-config.json。')
    console.warn('候选网卡地址：' + (candidates.length ? candidates.map(c => c.name + '=' + c.address).join('、') : '（无可路由地址）'))
    console.warn('手动指定后重试：node scripts/llm-config.js sync-simulator --setup-url http://<手表可达的电脑IP>:8790')
  }
  console.log('重启/刷新模拟器应用后生效。')
}


async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || command === 'help' || command === '--help') {
    usage()
    return
  }
  if (command === 'show') printConfig(readConfig(args.file))
  else if (command === 'set') await setCommand(args)
  else if (command === 'clear') clearCommand(args)
  else if (command === 'sync-simulator') await syncSimulatorCommand(args)
  else {
    console.error(`未知命令: ${command}`)
    usage()
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error('[llm-config] 失败:', err.message)
  process.exitCode = 1
})
