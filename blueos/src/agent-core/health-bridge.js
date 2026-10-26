/**
 * HealthBridge - 健康数据桥接
 * 订阅心率采样，查询今日步数，并把采样交给闸门求值。
 */

import health from '@blueos.health.health'

export class HealthBridge {
  constructor(onSample) {
    this.onSample = typeof onSample === 'function' ? onSample : null
    this.state = {
      heartRate: 0,
      stepCount: 0,
      spo2: 0
    }
  }

  start() {
    console.log('[HealthBridge] start monitoring, health module=' + typeof health)

    if (!health || typeof health.subscribeSample !== 'function') {
      console.warn('[HealthBridge] subscribeSample not available')
    } else {
      const hrType = health && health.DATA_TYPES && health.DATA_TYPES.HEART_RATE
      if (!hrType) {
        console.warn('[HealthBridge] HEART_RATE data type not available')
      } else {
        health.subscribeSample({
          dataType: hrType,
          callback: (sample) => {
            const value = Array.isArray(sample) ? sample[0] : (sample && sample.value)
            this.state.heartRate = value
            console.log('[HealthBridge] heartRate:', value)
            this._emit('heart_rate', value)
          },
          fail: (data, code) => {
            console.warn('[HealthBridge] heartRate failed:', data, code)
          }
        })
      }
    }

    this._refreshSteps()
  }

  async _refreshSteps() {
    if (!health || typeof health.getTodayStatistic !== 'function') {
      console.warn('[HealthBridge] getTodayStatistic not available')
      return
    }
    const stepType = health && health.DATA_TYPES && health.DATA_TYPES.STEP_COUNT
    const sumType = health && health.STATISTIC_TYPES && health.STATISTIC_TYPES.SUM
    if (!stepType || !sumType) {
      console.warn('[HealthBridge] step statistic types not available')
      return
    }
    return new Promise((resolve) => {
      health.getTodayStatistic({
        dataType: stepType,
        statisticType: sumType,
        success: (stat) => {
          this.state.stepCount = stat && stat.value || 0
          resolve()
        },
        fail: () => {
          this.state.stepCount = 0
          resolve()
        }
      })
    })
  }

  getState() {
    return { ...this.state }
  }

  /** 把采样交给闸门。回调由 Runtime 注入；未注入时静默跳过。 */
  _emit(dataType, value) {
    if (!this.onSample) return
    try {
      this.onSample(dataType, value)
    } catch (e) {
      console.warn('[HealthBridge] onSample handler failed:', e && e.message)
    }
  }
}
