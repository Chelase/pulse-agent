/**
 * 把 blueos/src 下的 ESM 源码镜像成 Node 可直接 import 的 .mjs 树。
 *
 * 为什么需要镜像：
 * 1. blueos/package.json 没有 "type": "module"，.js 会被 Node 当 CJS，而源码是 ESM。
 * 2. 源码里的相对 import 不带扩展名（`from './llm-client'`），ESM 要求带扩展名。
 * 3. `@blueos.*` 是 BlueOS 专有模块，Node 里不存在，要换成桩。
 *
 * 产出目录：scripts/local-test/.build/（已 gitignore，勿手改）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'blueos', 'src')
const OUT = path.join(HERE, '.build')
const STUB_DIR = path.join(OUT, '_stubs')
const STUBS = pathToFileURL(path.join(HERE, 'stubs.mjs')).href

/** `@blueos.*` 模块 → stubs.mjs 里的导出名 */
const BLUEOS_MODULES = {
  '@blueos.network.fetch': 'fetchModule',
  '@blueos.storage.storage': 'storageStub',
  '@blueos.storage.file': 'fileStub',
  '@blueos.hardware.sensor.sensor': 'sensorStub',
  '@blueos.health.health': 'healthStub',
  '@blueos.app.notification.notificationManager': 'notificationStub',
  '@blueos.hardware.vibrator.vibrator': 'vibratorStub',
  '@blueos.app.appmanager.schedule': 'scheduleStub',
  '@blueos.bluetooth.ble': 'bluetoothStub'
}

/** 不是代码的文件，镜像时跳过 */
const SKIP_EXT = new Set(['.ux', '.css', '.json', '.md', '.png', '.jpg'])

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 每个 `@blueos.*` 生成一个只做默认导出转发的小模块，避免不同模块互相串味。 */
function writeStubShims() {
  fs.mkdirSync(STUB_DIR, { recursive: true })
  const urls = {}
  for (const [spec, exportName] of Object.entries(BLUEOS_MODULES)) {
    const file = path.join(STUB_DIR, spec.replace(/[^\w.-]/g, '_') + '.mjs')
    fs.writeFileSync(file, `export { ${exportName} as default } from '${STUBS}'\n`, 'utf8')
    urls[spec] = pathToFileURL(file).href
  }
  return urls
}

function rewriteImports(source, fileLabel, stubUrls) {
  return source.replace(/(from\s+)(['"])([^'"]+)\2/g, (whole, prefix, quote, spec) => {
    if (spec.startsWith('@blueos.')) {
      const url = stubUrls[spec]
      if (!url) {
        throw new Error(`${fileLabel}: 未映射的 BlueOS 模块 ${spec}，请在 build.mjs 的 BLUEOS_MODULES 里补上`)
      }
      return `${prefix}'${url}'`
    }
    if (spec.startsWith('.')) {
      if (spec.endsWith('.js')) return `${prefix}'${spec.slice(0, -3)}.mjs'`
      if (!path.extname(spec)) return `${prefix}'${spec}.mjs'`
    }
    return whole
  })
}

function build() {
  rmrf(OUT)
  fs.mkdirSync(OUT, { recursive: true })
  const stubUrls = writeStubShims()

  let count = 0
  for (const file of walk(SRC)) {
    const ext = path.extname(file)
    if (ext !== '.js' || SKIP_EXT.has(ext)) continue

    const rel = path.relative(SRC, file)
    const target = path.join(OUT, rel.slice(0, -3) + '.mjs')
    fs.mkdirSync(path.dirname(target), { recursive: true })

    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    fs.writeFileSync(target, rewriteImports(raw, rel, stubUrls), 'utf8')
    count++
  }

  return count
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = build()
  console.log(`[local-test] 镜像完成：${count} 个文件 → ${path.relative(ROOT, OUT)}`)
}

export { build, OUT, ROOT, HERE }
