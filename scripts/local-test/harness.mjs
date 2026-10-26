/** 极简断言工具，供 local-test 下的测试文件共用。 */

let failures = 0
let total = 0

export function check(name, actual, expected) {
  total++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) {
    console.log(`     expected=${JSON.stringify(expected)}`)
    console.log(`     actual  =${JSON.stringify(actual)}`)
  }
}

export function checkTrue(name, actual) {
  check(name, !!actual, true)
}

export function summary() {
  if (failures === 0) {
    console.log(`\nALL PASS (${total} 项断言)`)
    process.exit(0)
  }
  console.log(`\n${failures}/${total} FAILED`)
  process.exit(1)
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 按顺序吐出台词，模拟 LLM 的多轮回复。 */
export function scriptedLLM(lines) {
  const queue = lines.slice()
  return () => ({ choices: [{ message: { role: 'assistant', content: queue.shift() } }] })
}
