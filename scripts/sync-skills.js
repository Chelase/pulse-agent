#!/usr/bin/env node
/**
 * 从 blueos/src/assets/skills/<name>/SKILL.md 生成 blueos/src/assets/skills/index.js。
 *
 * 为什么需要这一步：BlueOS 运行时无法直接读取打包进 assets 的文本文件，
 * 把 SKILL.md 原文内嵌成可 import 的模块是唯一稳定可用的加载方式。
 *
 * 用法：node scripts/sync-skills.js
 */

const fs = require('fs')
const path = require('path')

const SKILLS_DIR = path.join(__dirname, '..', 'blueos', 'src', 'assets', 'skills')
const OUTPUT = path.join(SKILLS_DIR, 'index.js')

function walk(dir) {
  const found = []
  if (!fs.existsSync(dir)) return found
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walk(full))
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      found.push(full)
    }
  }
  return found
}

function toTemplateLiteral(text) {
  return '`' + text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${') + '`'
}

function main() {
  const files = walk(SKILLS_DIR).sort()

  const entries = files.map(file => {
    const rel = path.relative(SKILLS_DIR, file).split(path.sep).join('/')
    const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    return `  {\n    path: ${JSON.stringify(rel)},\n    content: ${toTemplateLiteral(content)}\n  }`
  })

  const output = `/**
 * 本文件由 scripts/sync-skills.js 从同目录下的 SKILL.md 生成，请勿手工修改。
 * 重新生成：node scripts/sync-skills.js
 *
 * 为什么内嵌而不是运行时读文件：BlueOS 运行时无法直接读取打包进 assets 的文本文件。
 * SKILL.md 原文保留在磁盘上，供人阅读、供生态复制，也供 internal://files 覆盖时作模板。
 */

export const SKILLS = [
${entries.join(',\n')}
]
`

  fs.writeFileSync(OUTPUT, output, 'utf8')

  console.log(`[sync-skills] 已从 ${files.length} 个 SKILL.md 生成 ${path.relative(process.cwd(), OUTPUT)}`)
  for (const file of files) {
    console.log('  - ' + path.relative(SKILLS_DIR, file).split(path.sep).join('/'))
  }
}

main()
