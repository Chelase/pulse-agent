/**
 * SkillRegistry - skill 注册与加载
 *
 * skill 是给 LLM 的程序性知识（何时做、按什么步骤做），tool 是原子动作。
 * 格式对齐 SKILL.md 生态（YAML frontmatter + Markdown 正文），约定见 common/skills/README.md。
 *
 * 渐进式披露：frontmatter（name / description / triggers）常驻 system prompt 用于触发匹配，
 * Markdown 正文只在 trigger 命中时注入——控制上下文成本，手表功耗预算下尤其重要。
 *
 * 加载顺序：SKILL.md 原文内嵌在 assets/skills/index.js（BlueOS 运行时读不到打包文本文件）；
 * 首次启动把内置 skill 落盘到 internal://files/agent/skills/<name>/SKILL.md，
 * 之后同名文件存在即以文件为准——改 skill 不必重新打包。
 */

import { SKILLS } from '../assets/skills/index'
import { Storage } from '../platform/storage'

const SKILL_ROOT = 'skills'
const SKILL_FILENAME = 'SKILL.md'

export class SkillRegistry {
  constructor() {
    this.skills = []
  }

  async init() {
    await this._seedBuiltins()

    this.skills = []
    for (const entry of SKILLS) {
      const id = this._skillId(entry.path)
      const override = await this._loadOverride(id)
      const parsed = parseFrontmatter(override || entry.content)
      const name = parsed.meta.name || id
      this.skills.push({
        id: name,
        name,
        description: parsed.meta.description || '',
        triggers: toArray(parsed.meta.triggers),
        toolsAllowed: toArray(parsed.meta.tools_allowed),
        body: parsed.body,
        source: override ? 'override' : 'builtin'
      })
    }

    const ids = this.skills.map(s => s.id).join(', ')
    console.log(`[SkillRegistry] loaded ${this.skills.length} skills: ${ids}`)
  }

  list() {
    return this.skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      triggers: s.triggers.slice(),
      toolsAllowed: s.toolsAllowed.slice()
    }))
  }

  /** 常驻 system prompt 的 frontmatter 清单。 */
  getFrontmatterBlock() {
    if (!this.skills.length) return ''
    const lines = this.skills.map(s => {
      const triggerText = s.triggers.length ? `（触发：${s.triggers.join('、')}）` : ''
      return `- ${s.name}: ${s.description}${triggerText}`
    })
    return '\n\n可用技能（命中触发条件时会给出完整步骤）：\n' + lines.join('\n')
  }

  /** 事件路径：按闸门条件 id 命中 triggers。 */
  match(trigger) {
    if (!trigger) return null
    return this.skills.find(s => s.triggers.indexOf(trigger) !== -1) || null
  }

  /** 对话路径：按自由文本命中 skill 名或任一 trigger。 */
  matchText(text) {
    if (!text) return null
    const lower = String(text).toLowerCase()
    return this.skills.find(s =>
      lower.indexOf(s.id.toLowerCase()) !== -1 ||
      s.triggers.some(t => lower.indexOf(String(t).toLowerCase()) !== -1)
    ) || null
  }

  getBody(id) {
    const skill = this.skills.find(s => s.id === id)
    return skill ? skill.body : ''
  }

  _skillId(relPath) {
    const parts = String(relPath).split('/')
    return parts.length > 1 ? parts[0] : parts[0].replace(/\.md$/i, '')
  }

  async _loadOverride(id) {
    try {
      return await Storage.readFile(`${SKILL_ROOT}/${id}/${SKILL_FILENAME}`, '')
    } catch (e) {
      console.warn(`[SkillRegistry] read override failed for ${id}:`, e && e.message)
      return ''
    }
  }

  /** 首次运行把内置 skill 原文落盘，让「改配置不重新打包」有可覆盖的真实文件。 */
  async _seedBuiltins() {
    for (const entry of SKILLS) {
      const id = this._skillId(entry.path)
      const rel = `${SKILL_ROOT}/${id}/${SKILL_FILENAME}`
      try {
        if (await Storage.fileExists(rel)) continue
        await Storage.ensureDir(`${SKILL_ROOT}/${id}`)
        await Storage.writeFile(rel, entry.content)
        console.log(`[SkillRegistry] seeded skill file: ${rel}`)
      } catch (e) {
        console.warn(`[SkillRegistry] seed failed for ${id}:`, e && e.message)
      }
    }
  }
}

function stripQuotes(value) {
  const v = String(value === undefined || value === null ? '' : value).trim()
  if (v.length > 1) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1)
    }
  }
  return v
}

function toArray(value) {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value.filter(Boolean)
  return [String(value)]
}

/**
 * 轻量 frontmatter 解析：支持 `key: value`、`key: [a, b]`、以及块状列表
 * （`key:` 换行后跟 `- item`）。不引入 YAML 依赖。
 */
export function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  if (text.slice(0, 3) !== '---') return { meta: {}, body: text.trim() }

  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text.trim() }

  const head = text.slice(3, end)
  const body = text.slice(end + 4).trim()
  const meta = {}
  let listKey = null

  for (const line of head.split('\n')) {
    if (!line.trim()) continue

    const item = line.match(/^\s*-\s+(.+)$/)
    if (item && listKey) {
      meta[listKey].push(stripQuotes(item[1]))
      continue
    }

    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (!kv) continue

    const key = kv[1]
    const value = kv[2].trim()
    listKey = null

    if (!value) {
      meta[key] = []
      listKey = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map(stripQuotes).filter(Boolean)
    } else {
      meta[key] = stripQuotes(value)
    }
  }

  return { meta, body }
}
