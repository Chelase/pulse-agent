/**
 * CLI 模型配置验收：set/show 脱敏、sync-simulator 落盘配置与引导地址。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { check, checkTrue, summary } from './harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const CLI = path.join(ROOT, 'scripts', 'llm-config.js')
const CONFIG = path.join(HERE, '.llm-config-cli-test.json')
const SIM_ROOT = path.join(HERE, '.simulator-agent')

try { fs.unlinkSync(CONFIG) } catch (err) { /* 测试文件不存在 */ }
fs.rmSync(SIM_ROOT, { recursive: true, force: true })

const cliSet = spawnSync(process.execPath, [
  CLI, 'set', '--file', CONFIG,
  '--endpoint', 'https://api.deepseek.com/v1/chat/completions',
  '--model', 'deepseek-chat',
  '--api-key', 'sk-cli-secret'
], { encoding: 'utf8' })
check('CLI set 成功', cliSet.status, 0)
check('CLI set 不回显完整 Key', cliSet.stdout.indexOf('sk-cli-secret') === -1, true)
check('CLI set 写入文件', fs.existsSync(CONFIG), true)
check('落盘内容没有 provider 字段', 'provider' in JSON.parse(fs.readFileSync(CONFIG, 'utf8')), false)

const cliShow = spawnSync(process.execPath, [CLI, 'show', '--file', CONFIG], { encoding: 'utf8' })
check('CLI show 成功', cliShow.status, 0)
check('CLI show 包含 model', cliShow.stdout.indexOf('deepseek-chat') !== -1, true)
check('CLI show 不输出完整 Key', cliShow.stdout.indexOf('sk-cli-secret') === -1, true)
check('CLI show 有 Key 脱敏标记', cliShow.stdout.indexOf('hasApiKey') !== -1, true)

const cliSync = spawnSync(process.execPath, [
  CLI, 'sync-simulator', '--file', CONFIG, '--root', SIM_ROOT,
  '--setup-url', 'http://10.0.0.9:8790'
], { encoding: 'utf8' })
check('CLI sync-simulator 成功', cliSync.status, 0)
check('同步写入 llm-config.json', fs.existsSync(path.join(SIM_ROOT, 'llm-config.json')), true)
check('同步文件保留 model', JSON.parse(fs.readFileSync(path.join(SIM_ROOT, 'llm-config.json'), 'utf8')).model, 'deepseek-chat')
check('同步写入 setup-config.json 引导地址', JSON.parse(fs.readFileSync(path.join(SIM_ROOT, 'setup-config.json'), 'utf8')).baseUrl, 'http://10.0.0.9:8790')
checkTrue('同步输出提示二维码', cliSync.stdout.indexOf('二维码') !== -1)

fs.unlinkSync(CONFIG)
fs.rmSync(SIM_ROOT, { recursive: true, force: true })
summary()
