/**
 * JobRegistry - 定时任务表（hermes cron 在本平台的最小对应）
 *
 * 任务本身不在这里执行：到期只往 TaskQueue 里塞一条任务，由心跳按预算推进。
 * 这样「每天几点做什么」和「一次 LLM 往返」解耦，改配置不用重新打包。
 */

import { Storage } from '../platform/storage'

const JOBS_KEY = 'agent_jobs'
const MAX_JOBS = 20

export class JobRegistry {
  constructor() {
    this.jobs = []
  }

  async init() {
    const stored = await Storage.get(JOBS_KEY, null)
    this.jobs = Array.isArray(stored) ? stored : []
    console.log(`[JobRegistry] init done, jobs=${this.jobs.length}`)
  }

  async save() {
    if (this.jobs.length > MAX_JOBS) this.jobs = this.jobs.slice(-MAX_JOBS)
    await Storage.set(JOBS_KEY, this.jobs)
  }

  /**
   * @param {Object} opts
   * @param {string} opts.name 唯一名，重复注册视为更新
   * @param {string} opts.instruction 到期时交给 Agent 的自然语言指令
   * @param {number} opts.intervalMs 周期，毫秒
   */
  async add({ name, instruction, intervalMs }) {
    if (!name || !instruction || !(intervalMs > 0)) {
      throw new Error('job 需要 name / instruction / intervalMs')
    }
    const now = Date.now()
    const existing = this.jobs.find(j => j.name === name)
    const job = existing || { name, createdAt: now }
    job.instruction = instruction
    job.intervalMs = intervalMs
    job.nextRunAt = now + intervalMs
    job.lastRunAt = 0
    if (!existing) this.jobs.push(job)
    await this.save()
    return job
  }

  async remove(name) {
    const before = this.jobs.length
    this.jobs = this.jobs.filter(j => j.name !== name)
    if (this.jobs.length !== before) await this.save()
    return this.jobs.length !== before
  }

  list() {
    return this.jobs.map(j => ({
      name: j.name,
      instruction: j.instruction,
      intervalMs: j.intervalMs,
      nextRunAt: j.nextRunAt,
      due: j.nextRunAt <= Date.now()
    }))
  }

  /**
   * 到期的 job 各产出一条指令；同时把 nextRunAt 推到下一轮。
   * 错过的轮次直接跳过（不补跑），避免手表休眠一天后一次性灌进几十个任务。
   */
  due(now = Date.now()) {
    const dueJobs = this.jobs.filter(j => j.nextRunAt <= now)
    dueJobs.forEach((j) => {
      j.lastRunAt = now
      j.nextRunAt = now + j.intervalMs
    })
    return dueJobs.map(j => ({ name: j.name, instruction: j.instruction }))
  }
}
