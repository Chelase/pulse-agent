#!/usr/bin/env node
/**
 * local-test 运行器：镜像 blueos/src → .build，然后逐个测试文件独立进程执行。
 *
 * 为什么独立进程：AgentRuntime 是模块级单例，多个 runtime 测试在同一进程里会互相污染。
 *
 * 用法：node scripts/local-test/run.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from './build.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const mirrored = build()
console.log(`[local-test] 镜像完成：${mirrored} 个文件 → scripts/local-test/.build`)

const tests = fs.readdirSync(HERE)
  .filter(f => f.endsWith('.test.mjs'))
  .sort()

if (!tests.length) {
  console.error('[local-test] 没找到任何 *.test.mjs')
  process.exit(1)
}

let failed = 0
for (const test of tests) {
  console.log(`\n########## ${test} ##########`)
  const result = spawnSync(process.execPath, [path.join(HERE, test)], { stdio: 'inherit' })
  if (result.status !== 0) failed++
}

console.log('')
if (failed === 0) {
  console.log(`===== 全部 ${tests.length} 个测试文件通过 =====`)
  process.exit(0)
}
console.log(`===== ${failed}/${tests.length} 个测试文件失败 =====`)
process.exit(1)
