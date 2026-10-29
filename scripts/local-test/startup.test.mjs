/**
 * 启动链韧性：真机上「平台回调不返回」或「关键步骤失败」都不能让首页永远停在启动中。
 *
 * 背景：`runtime.start()` 原本是串行短路 + 无超时，`heartbeat.start()` 等平台定时任务
 * 回调，回调不来 Promise 就永远 pending，首页（唯一的状态面板）永远显示「启动中」。
 * AgentRuntime 是模块级单例，本文件必须独占一个进程。
 */

import { AgentRuntime } from './.build/agent-core/runtime.mjs'
import { memory, setKV, scheduleStub, storageStub } from './stubs.mjs'
import { check, checkTrue, summary } from './harness.mjs'

memory.reset()
setKV('llm_config', { endpoint: 'https://llm.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model' })

// ---------- 平台定时任务既不 success 也不 fail ----------
scheduleStub.hangNext = true

const runtime = new AgentRuntime()
const startedAt = Date.now()
await runtime.start()
const elapsed = Date.now() - startedAt

checkTrue('定时任务不回调时启动仍然跑完', elapsed < 10000)
check('定时任务不回调时 runtime 仍就绪', runtime.ready, true)
check('心跳降级为进程内定时器', runtime.getState().resident.heartbeatSource, 'local-timer')
check('启动步骤全部执行完', runtime.getState().steps.length, runtime.getState().stepTotal)
checkTrue('引导不受执行层就绪状态影响', !!runtime.getState().onboarding.phase)
runtime.stop()

// ---------- 关键步骤失败：停下但可读，引导照样起来 ----------
setKV('agent_device_id', null)
storageStub.failSet = true
await runtime.start()
storageStub.failSet = false

check('关键步骤失败时未就绪', runtime.ready, false)
check('失败步骤被记录', runtime.getState().failedStep, 'identity.init')
check('停在第一个关键步骤', runtime.getState().steps.length, 1)
check('失败步骤带错误信息', runtime.getState().steps[0].ok, false)
checkTrue('关键步骤失败也创建了引导', !!runtime.configOnboarding)

summary()
