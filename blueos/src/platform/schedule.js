/**
 * Scheduler - 蓝河定时任务封装（常驻心跳的载体）
 *
 * 蓝河没有常驻进程，但 `scheduleJob` 注册的方法会由系统在后台拉起 app.ux 调用，
 * type=2 按真实时间流逝计时（休眠也累计），interval 周期重复。
 * 这就是「常驻式 Agent」在本平台上唯一可用的等价物。
 */

import schedule from '@blueos.app.appmanager.schedule'

/** type=1 走硬件时间（可被改系统时间触发），type=2 走真实时间流逝。 */
const TYPE_REALTIME_ELAPSED = 2

/** 单个 tick 的软预算：超过就把剩下的活留给下一次唤醒。 */
export const DEFAULT_TICK_BUDGET_MS = 1500

export const Scheduler = {
  /**
   * 注册周期心跳。
   * @param {Object} opts
   * @param {number} opts.intervalMs 周期间隔
   * @param {string} opts.method app.ux 上定义的方法名（系统后台拉起时调用）
   * @param {Object} [opts.params] 透传参数
   * @returns {Promise<number>} 任务 id，-1 表示未注册成功
   */
  register({ intervalMs, method, params = {} }) {
    return new Promise((resolve) => {
      schedule.scheduleJob({
        type: TYPE_REALTIME_ELAPSED,
        // type=2 下 timeout 是「距首次执行的间隔（毫秒）」，不是时间戳。
        // 之前传 Date.now() 会把首次触发排到几十年后，心跳等于永不启动。
        timeout: intervalMs,
        interval: intervalMs,
        triggerMethod: method,
        params,
        success: (res) => resolve(res && res.id !== undefined ? res.id : -1),
        fail: (data, code) => {
          // -27 定时任务已满 / -28 已注册：都属于「已有心跳在跑」，不是致命错误
          console.warn(`[Scheduler] register failed: ${data} (${code})`)
          resolve(-1)
        }
      })
    })
  },

  cancel(id) {
    if (id === undefined || id === null || id < 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      schedule.cancel({
        id,
        success: () => resolve(true),
        fail: () => resolve(false)
      })
    })
  }
}
