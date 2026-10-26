/**
 * TaskQueue - 落盘的 Agent 任务队列
 *
 * 为什么需要它：后台窗口能活多久没有公开保证，一次 LLM 往返 + 多步工具可能跨不过去。
 * 所以任务不是一次跑完，而是「每个心跳窗口推进一步，进度落盘，下次唤醒接着跑」。
 * 进程被杀、被系统回收都不影响正确性——状态在 KV 里。
 */

import { Storage } from '../platform/storage'

const QUEUE_KEY = 'agent_task_queue'
const MAX_TASKS = 20

export const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed'
}

export class TaskQueue {
  constructor() {
    this.tasks = []
  }

  async init() {
    const stored = await Storage.get(QUEUE_KEY, null)
    this.tasks = Array.isArray(stored) ? stored : []
    console.log(`[TaskQueue] init done, tasks=${this.tasks.length}`)
  }

  async save() {
    // 只保留最近 MAX_TASKS 条；已完成任务很快被裁掉，避免 KV 无限增长
    if (this.tasks.length > MAX_TASKS) {
      this.tasks = this.tasks.slice(-MAX_TASKS)
    }
    await Storage.set(QUEUE_KEY, this.tasks)
  }

  enqueue({ kind, instruction, source, event }) {
    const task = {
      id: 't' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      kind,
      instruction: instruction || '',
      source: source || '',
      event: event || null,
      status: TASK_STATUS.PENDING,
      stepsUsed: 0,
      messages: [],
      result: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.tasks.push(task)
    return task
  }

  /** 下一个还没跑完的任务；没有则 null。 */
  next() {
    return this.tasks.find(t => t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.RUNNING) || null
  }

  get(id) {
    return this.tasks.find(t => t.id === id) || null
  }

  pendingCount() {
    return this.tasks.filter(t => t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.RUNNING).length
  }
}
