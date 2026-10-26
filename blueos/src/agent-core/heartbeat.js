/**
 * Heartbeat - 常驻心跳
 *
 * hermes 靠一个常驻 gateway 进程做调度；蓝河没有常驻进程，等价物是
 * `scheduleJob` 注册的 triggerMethod 被系统周期性后台拉起。
 * 于是这里的结构是：心跳只负责「每次醒来推进一点活」，进度全在落盘的队列里。
 */

import { Scheduler } from '../platform/schedule'

/** app.ux 上必须暴露这个名字的方法，系统后台拉起时调用。 */
export const TICK_METHOD = 'agentTick'

export class Heartbeat {
  constructor(runtime, { intervalMs = 60000, budgetMs = 1500 } = {}) {
    this.runtime = runtime
    this.intervalMs = intervalMs
    this.budgetMs = budgetMs
    this.jobId = -1
    this.source = ''
    this._timer = null
    this.ticking = false
    this.ticks = 0
  }

  async start() {
    this.jobId = await Scheduler.register({ intervalMs: this.intervalMs, method: TICK_METHOD })
    if (this.jobId >= 0) {
      this.source = 'schedule'
      console.log(`[Heartbeat] 注册心跳 ${this.intervalMs}ms, jobId=${this.jobId}`)
      return this.jobId
    }
    // 平台定时任务不可用（模拟器/未授权机型会返回 generic error）时，
    // 退化成进程内定时器：只在应用存活期间心跳，被系统回收后靠落盘队列续跑。
    this.source = 'local-timer'
    this._timer = setInterval(() => {
      this.tick().catch(e => console.error('[Heartbeat] 本地心跳异常:', e && e.message ? e.message : e))
    }, this.intervalMs)
    console.warn(`[Heartbeat] 平台定时任务注册失败，退化为进程内 ${this.intervalMs}ms 定时器心跳`)
    return -1
  }

  stop() {
    if (this.jobId >= 0) {
      Scheduler.cancel(this.jobId)
      this.jobId = -1
    }
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this.source = ''
  }

  /**
   * 一次唤醒的全部工作：推进到期任务 + 在预算内把队列往前推。
   * 超预算就带着已落盘的进度退出，等下一次唤醒接着跑。
   */
  async tick() {
    if (this.ticking) {
      console.log('[Heartbeat] 上一次心跳还没结束，跳过本轮')
      return { skipped: true }
    }
    this.ticking = true
    this.ticks += 1
    const startedAt = Date.now()
    const summaryLog = { enqueued: 0, advanced: 0, budgetMs: this.budgetMs }

    try {
      summaryLog.enqueued = await this.runtime.dueJobsToQueue()

      while (Date.now() - startedAt < this.budgetMs) {
        const task = this.runtime.taskQueue.next()
        if (!task) break
        const progressed = await this.runtime.agentLoop.stepTask(task)
        task.updatedAt = Date.now()
        await this.runtime.taskQueue.save()
        if (progressed) summaryLog.advanced += 1
        else break
      }

      console.log(`[Heartbeat] tick#${this.ticks} ${JSON.stringify(summaryLog)} elapsed=${Date.now() - startedAt}ms`)
    } catch (e) {
      console.error('[Heartbeat] tick failed:', e && e.message ? e.message : e)
    } finally {
      this.ticking = false
    }
    return summaryLog
  }
}
