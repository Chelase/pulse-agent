/**
 * 首启引导验收：未配置 LLM 时申请设备码 → 二维码带码 → 拉到配置后热加载。
 *
 * 直接测 ConfigOnboarding：AgentRuntime 是模块级单例，一个进程塞不下三个场景。
 * 页面只读 getState().onboarding，字段与这里断言的一致。
 */

import { ConfigOnboarding } from './.build/agent-core/config-onboarding.mjs'
import { LLMClient } from './.build/agent-core/llm-client.mjs'
import { Identity } from './.build/agent-core/identity.mjs'
import { memory, setKV, fetchStub } from './stubs.mjs'
import { check, checkTrue, summary, sleep } from './harness.mjs'

const SETUP_DIR = 'internal://files/agent'

async function makeOnboarding() {
  const llm = new LLMClient()
  await llm.init()
  const identity = new Identity()
  await identity.init()
  return new ConfigOnboarding(llm, identity)
}

function seedSetupUrl(baseUrl) {
  memory.dirs.add(SETUP_DIR)
  memory.files.set(`${SETUP_DIR}/setup-config.json`, JSON.stringify({ baseUrl }))
}

// ---------- 场景 1：没有引导地址 ----------
memory.reset()
let ob = await makeOnboarding()
await ob.start()
check('场景1 phase=no-url', ob.getStatus().phase, 'no-url')
checkTrue('场景1 错误文案指向 setupBaseUrl', ob.getStatus().error.indexOf('setupBaseUrl') !== -1)
check('场景1 不发任何网络请求', memory.requests.length, 0)

// ---------- 场景 2：申请到码 → 二维码带码 → 拉到配置热加载 ----------
memory.reset()
seedSetupUrl('http://setup.test')
let polls = 0
fetchStub.respond('setup.test/api/setup/sessions', { code: 'ab12cd', poll_interval_ms: 5, setup_url: 'http://setup.test/' })
fetchStub.respond('setup.test/api/setup/session/AB12CD/config', () => {
  polls += 1
  // 第一次轮询模拟「还没人提交」：204 在桩里表现为空 body，只有 responseType:'text'
  // 能安全拿到（平台 json 模式遇空体原生解析就崩，桩会 fail），见 stubs.mjs deliver
  if (polls === 1) return ''
  return { endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'sk-from-phone-123', model: 'deepseek-chat' }
})

ob = await makeOnboarding()
await ob.start()
await sleep(60)

const status = ob.getStatus()
check('场景2 设备码转大写', status.code, 'AB12CD')
check('场景2 二维码带上码', status.qrValue, 'http://setup.test/?code=AB12CD')
check('场景2 拉到配置后 phase=done', status.phase, 'done')
check('场景2 轮询过两次才拿到配置', polls, 2)
check('场景2 LLM 热加载后可用', ob.llm.isConfigured(), true)
check('场景2 配置已落盘', JSON.parse(memory.files.get(`${SETUP_DIR}/llm-config.json`)).apiKey, 'sk-from-phone-123')
check('场景2 落盘内容不含 maxTokens', 'maxTokens' in JSON.parse(memory.files.get(`${SETUP_DIR}/llm-config.json`)), false)
check('场景2 已发通知引导用户', memory.notifications.length > 0, true)
check('场景2 空响应轮询未触发平台解析失败', memory.fetchFails, 0)
ob.stop()

// ---------- 场景 3：已配置时不再申请设备码 ----------
memory.reset()
seedSetupUrl('http://setup.test')
setKV('llm_config', { endpoint: 'https://llm.test/v1/chat/completions', apiKey: 'has-key', model: 'm' })
ob = await makeOnboarding()
await ob.start()
check('场景3 phase=configured', ob.getStatus().phase, 'configured')
check('场景3 不申请设备码', memory.requests.length, 0)

// ---------- 场景 4：码被服务端判失效 → 自动重新申请新码继续等 ----------
memory.reset()
seedSetupUrl('http://setup.test')
let issued = 0
fetchStub.respond('setup.test/api/setup/sessions', () => {
  issued += 1
  return { code: issued === 1 ? 'zz99xx' : 'nn88mm', poll_interval_ms: 5, setup_url: 'http://setup.test/' }
})
fetchStub.respond('setup.test/api/setup/session/ZZ99XX/config', { error: '设备码无效或已过期：服务端重启过' })
fetchStub.respond('setup.test/api/setup/session/NN88MM/config', { endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'sk-reapply-123', model: 'deepseek-chat' })
ob = await makeOnboarding()
await ob.start()
await sleep(80)
check('场景4 失效后自动换新码', ob.getStatus().code, 'NN88MM')
check('场景4 新码拉到配置 phase=done', ob.getStatus().phase, 'done')
check('场景4 热加载后可用', ob.llm.isConfigured(), true)
check('场景4 共签发两个码', issued, 2)
ob.stop()

// ---------- 场景 5：反复失效超过重申上限 → 明确失败 ----------
memory.reset()
seedSetupUrl('http://setup.test')
fetchStub.respond('setup.test/api/setup/sessions', { code: 'dd11dd', poll_interval_ms: 5, setup_url: 'http://setup.test/' })
fetchStub.respond('setup.test/api/setup/session/DD11DD/config', { error: '设备码无效或已过期' })
ob = await makeOnboarding()
await ob.start()
await sleep(120)
check('场景5 超过重申上限后明确失败', ob.getStatus().phase, 'failed')
checkTrue('场景5 保留服务端原因', ob.getStatus().error.indexOf('设备码无效') !== -1)
ob.stop()

summary()
