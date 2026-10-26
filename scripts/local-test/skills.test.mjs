/**
 * Step 3 验收：Skill 调用机制。
 * 覆盖：frontmatter 轻量解析、加载与首次落盘、internal://files 覆盖、
 *       frontmatter 常驻 + 正文按命中注入、无注册表时降级。
 */

import { SkillRegistry, parseFrontmatter } from './.build/agent-core/skill-registry.mjs'
import { Storage } from './.build/platform/storage.mjs'
import { ContextManager } from './.build/agent-core/context-manager.mjs'
import { FileManager } from './.build/agent-core/file-manager.mjs'
import { SensorBridge } from './.build/agent-core/sensor-bridge.mjs'
import { HealthBridge } from './.build/agent-core/health-bridge.mjs'
import { ToolRegistry } from './.build/agent-core/tool-registry.mjs'
import { AgentLoop } from './.build/agent-core/agent-loop.mjs'
import { memory, setKV, fetchStub } from './stubs.mjs'
import { check, summary, scriptedLLM } from './harness.mjs'

const LLM_CONFIG = {
  endpoint: 'https://llm.test/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model'
}

/** 清空桩状态但保留 LLM 配置。 */
function resetAll() {
  memory.reset()
  setKV('llm_config', LLM_CONFIG)
}

resetAll()

const SKILL_PATH = 'internal://files/agent/skills/health-alert-handling/SKILL.md'

// ============ frontmatter 解析 ============
const SAMPLE = `---
name: demo-skill
description: 演示用技能
triggers:
  - taken_off
  - battery_critical
tools_allowed: [vibrate, notification_send]
---

# 正文标题

正文内容。`

{
  const { meta, body } = parseFrontmatter(SAMPLE)
  check('解析 name', meta.name, 'demo-skill')
  check('解析 description', meta.description, '演示用技能')
  check('解析块状列表 triggers', meta.triggers, ['taken_off', 'battery_critical'])
  check('解析行内列表 tools_allowed', meta.tools_allowed, ['vibrate', 'notification_send'])
  check('解析正文首行', body.split('\n')[0], '# 正文标题')
}
{
  const { meta, body } = parseFrontmatter('没有 frontmatter 的纯文本')
  check('无 frontmatter 时 meta 为空', Object.keys(meta).length, 0)
  check('无 frontmatter 时正文保留', body, '没有 frontmatter 的纯文本')
}
{
  const { meta } = parseFrontmatter('---\nname: "带引号"\ndescription: \'单引号\'\n---\n正文')
  check('解析双引号值', meta.name, '带引号')
  check('解析单引号值', meta.description, '单引号')
}

// ============ 加载与首次落盘 ============
{
  resetAll()
  const reg = new SkillRegistry()
  await reg.init()

  check('加载 skill 数量', reg.list().length, 1)
  check('skill id', reg.list()[0].id, 'health-alert-handling')
  check('triggers 解析正确', reg.list()[0].triggers, ['sustained_high_heart_rate', 'low_heart_rate', 'low_blood_oxygen'])
  check('首次启动已落盘', memory.files.has(SKILL_PATH), true)
  check('落盘内容含 frontmatter', String(memory.files.get(SKILL_PATH)).startsWith('---'), true)

  check('按事件条件命中', (reg.match('sustained_high_heart_rate') || {}).id, 'health-alert-handling')
  check('未命中条件返回 null', reg.match('taken_off'), null)
  check('对话文本未命中返回 null', reg.matchText('今天天气怎么样'), null)
  check('对话文本命中 skill 名', (reg.matchText('请按 health-alert-handling 处理') || {}).id, 'health-alert-handling')
  check('frontmatter 常驻块非空', reg.getFrontmatterBlock().indexOf('health-alert-handling') !== -1, true)
  check('正文可取', reg.getBody('health-alert-handling').indexOf('健康异常事件处置') !== -1, true)
}

// ============ 目录幂等创建（真机暴露的缺陷） ============
{
  resetAll()
  const first = new SkillRegistry()
  await first.init()
  check('首次 init 建好 skill 目录', memory.dirs.has('internal://files/agent/skills/health-alert-handling'), true)

  // 第二次 init 时目录已存在，平台 mkdir 会走 fail —— 不应因此报错
  const second = new SkillRegistry()
  await second.init()
  check('二次 init 不因目录已存在失败', second.list().length, 1)
  check('二次 init 不覆盖已有文件', String(memory.files.get(SKILL_PATH)).indexOf('health-alert-handling') !== -1, true)
}

{
  resetAll()
  await Storage.writeFile('note.txt', 'hi')
  await Storage.writeFile('note.txt', 'hi')
  check('同目录重复写不报错', memory.files.get('internal://files/agent/note.txt'), 'hi')

  await Storage.ensureDir('skills/x')
  await Storage.ensureDir('skills/x')
  check('重复 ensureDir 不报错', memory.dirs.has('internal://files/agent/skills/x'), true)

  await Storage.writeFile('skills/x/a.md', 'body')
  check('ensureDir 后可写入子目录', memory.files.get('internal://files/agent/skills/x/a.md'), 'body')
}

// ============ internal://files 覆盖 ============
{
  memory.files.set(
    SKILL_PATH,
    '---\nname: health-alert-handling\ndescription: 被覆盖的描述\ntriggers:\n  - taken_off\n---\n\n覆盖后的正文'
  )
  const reg = new SkillRegistry()
  await reg.init()
  check('覆盖后 description 生效', reg.list()[0].description, '被覆盖的描述')
  check('覆盖后 triggers 生效', reg.list()[0].triggers, ['taken_off'])
  check('覆盖后正文生效', reg.getBody('health-alert-handling'), '覆盖后的正文')
  memory.files.delete(SKILL_PATH)
}

// ============ 注入行为 ============
async function makeLoop(lines, skillRegistry) {
  const context = new ContextManager()
  await context.init()
  const tools = new ToolRegistry(new FileManager(), new SensorBridge(), new HealthBridge())
  const loop = new AgentLoop(context, tools, skillRegistry)
  await loop.init()
  fetchStub.respond('/chat/completions', scriptedLLM(lines))
  return { loop }
}

function systemPromptOf(callIndex = 0) {
  const calls = memory.requests.filter(r => String(r.url).indexOf('/chat/completions') !== -1)
  return calls[callIndex].data.messages[0].content
}

{
  resetAll()
  const reg = new SkillRegistry()
  await reg.init()

  // 事件命中 → frontmatter + 正文都在
  const hit = await makeLoop(['{"notify": "", "vibrate": false}'], reg)
  await hit.loop.handleEvent({
    conditionId: 'sustained_high_heart_rate',
    description: '心率持续偏高',
    dataType: 'heart_rate',
    value: 128,
    timestamp: 1700000000000
  })
  const hitSystem = systemPromptOf(0)
  check('命中时 system 含 frontmatter', hitSystem.indexOf('health-alert-handling') !== -1, true)
  check('命中时 system 含 skill 正文', hitSystem.indexOf('健康异常事件处置') !== -1, true)
  check('命中时 system 含工具清单', hitSystem.indexOf('notification_send') !== -1, true)

  // 事件未命中 → 只常驻 frontmatter
  memory.requests.length = 0
  const miss = await makeLoop(['{"notify": "", "vibrate": false}'], reg)
  await miss.loop.handleEvent({
    conditionId: 'taken_off',
    description: '手表被取下',
    dataType: 'on_body',
    value: false,
    timestamp: 1700000000000
  })
  const missSystem = systemPromptOf(0)
  check('未命中时仍常驻 frontmatter', missSystem.indexOf('health-alert-handling') !== -1, true)
  check('未命中时不注入正文', missSystem.indexOf('健康异常事件处置'), -1)

  // 无注册表 → 降级，主链路不受影响
  memory.requests.length = 0
  const none = await makeLoop(['{"notify": "", "vibrate": false}'], null)
  await none.loop.handleEvent({
    conditionId: 'sustained_high_heart_rate',
    description: '心率持续偏高',
    dataType: 'heart_rate',
    value: 128,
    timestamp: 1700000000000
  })
  const noneSystem = systemPromptOf(0)
  check('无注册表时不含技能块', noneSystem.indexOf('可用技能'), -1)
  check('无注册表时仍有工具清单', noneSystem.indexOf('notification_send') !== -1, true)
}

summary()
