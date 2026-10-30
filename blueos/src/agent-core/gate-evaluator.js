/**
 * GateEvaluator - 闸门求值器
 *
 * 闸门是感知与 LLM 之间的廉价前置过滤器：只做单信号比较，判断某个采样是否值得
 * 交给 LLM。不做上下文融合、不支持 AND/OR 组合条件——那是 LLM 的活
 * （设计说明见 common/models/README.md）。
 *
 * 条件集默认内嵌 common/models/gate-conditions.json 的内容（BlueOS 运行时读不到
 * 仓库里的 common/ 目录），可通过 internal://files/agent/gate-conditions.json
 * 覆盖，改阈值不必重新打包。
 *
 * 状态只在内存里：
 * - overSince  条件 id → 本次「越限起始时间戳」，回到阈值内即清零
 * - lastFired  条件 id → 最近一次触发时间戳，用于 cooldownSeconds 静默期
 * 进程重启归零，MVP 可接受（见 dev-plans/mvp-core-capabilities-plan.md Step 2）。
 */

import { Storage } from '../platform/storage'

const CONDITIONS_FILE = 'gate-conditions.json'

// 与 common/models/gate-conditions.json 的默认集保持一致
export const DEFAULT_CONDITIONS = [
  {
    id: 'sustained_high_heart_rate',
    description: '心率持续偏高',
    dataType: 'heart_rate',
    operator: 'gt',
    threshold: 100,
    sustainedSeconds: 600,
    cooldownSeconds: 3600
  },
  {
    id: 'low_heart_rate',
    description: '心率异常偏低',
    dataType: 'heart_rate',
    operator: 'lt',
    threshold: 45,
    sustainedSeconds: 300,
    cooldownSeconds: 3600
  },
  {
    id: 'taken_off',
    description: '手表被取下',
    dataType: 'on_body',
    operator: 'eq',
    threshold: 0,
    sustainedSeconds: 300,
    cooldownSeconds: 1800
  }
]

export class GateEvaluator {
  constructor(conditions, now) {
    this.conditions = conditions && conditions.length ? conditions : DEFAULT_CONDITIONS
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._overSince = {}
    this._lastFired = {}
  }

  /** 尝试用 internal://files 覆盖文件替换内置条件集；失败则保持内置。 */
  async init() {
    let raw = ''
    try {
      raw = await Storage.readFile(CONDITIONS_FILE, '')
    } catch (e) {
      console.warn('[GateEvaluator] read override failed:', e && e.message)
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.conditions) && parsed.conditions.length) {
          this.conditions = parsed.conditions
          console.log(`[GateEvaluator] loaded ${parsed.conditions.length} conditions from ${CONDITIONS_FILE}`)
          return
        }
      } catch (e) {
        console.warn('[GateEvaluator] override parse failed, fallback to builtin:', e && e.message)
      }
    }
    console.log(`[GateEvaluator] using builtin conditions, count=${this.conditions.length}`)
  }

  /**
   * 求值一次采样。返回被触发的条件对象，未触发返回 null。
   * 同步、无 IO、无网络——这是它便宜的原因。
   */
  evaluate(dataType, value) {
    if (dataType === undefined || dataType === null) return null
    if (value === undefined || value === null) return null

    const now = this._now()
    let hit = null

    for (let i = 0; i < this.conditions.length; i++) {
      const condition = this.conditions[i]
      if (condition.dataType !== dataType) continue

      if (!this._compare(value, condition.operator, condition.threshold)) {
        this._overSince[condition.id] = null
        continue
      }

      if (this._overSince[condition.id] === undefined || this._overSince[condition.id] === null) {
        this._overSince[condition.id] = now
      }
      const sustained = (now - this._overSince[condition.id]) / 1000
      if (sustained < (condition.sustainedSeconds || 0)) continue

      const last = this._lastFired[condition.id]
      const cooled = last === undefined || last === null
        || (now - last) / 1000 >= (condition.cooldownSeconds || 0)
      if (!cooled) continue

      this._lastFired[condition.id] = now
      this._overSince[condition.id] = null
      hit = condition
      break
    }

    return hit
  }

  getConditions() {
    return this.conditions.slice()
  }

  getState() {
    return {
      overSince: { ...this._overSince },
      lastFired: { ...this._lastFired }
    }
  }

  _compare(value, operator, threshold) {
    // 布尔型 dataType（on_body / wrist_lift）按契约用 0 / 1 表示
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : value

    switch (operator) {
      case 'gt': return v > threshold
      case 'gte': return v >= threshold
      case 'lt': return v < threshold
      case 'lte': return v <= threshold
      case 'eq': return v === threshold
      default:
        console.warn('[GateEvaluator] unknown operator:', operator)
        return false
    }
  }
}
