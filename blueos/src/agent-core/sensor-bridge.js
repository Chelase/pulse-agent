/**
 * SensorBridge - 传感器数据桥接
 * 订阅 BlueOS 传感器事件，维护最新状态，并把采样交给闸门求值。
 */

import sensor from '@blueos.hardware.sensor.sensor'

export class SensorBridge {
  constructor(onSample) {
    this.onSample = typeof onSample === 'function' ? onSample : null
    this.state = {
      onBody: false,
      steps: 0,
      wristLiftCount: 0,
      lastWristLift: null
    }
  }

  start() {
    console.log('[SensorBridge] start monitoring, sensor module=' + typeof sensor)

    if (!sensor || typeof sensor.subscribeOnBodyState !== 'function') {
      console.warn('[SensorBridge] subscribeOnBodyState not available')
    } else {
      sensor.subscribeOnBodyState({
        callback: (ret) => {
          this.state.onBody = ret && ret.value
          console.log('[SensorBridge] onBodyState:', ret && ret.value)
          this._emit('on_body', this.state.onBody)
        },
        fail: (data, code) => {
          console.warn('[SensorBridge] onBodyState failed:', data, code)
        }
      })
    }

    if (!sensor || typeof sensor.subscribeWristLift !== 'function') {
      console.warn('[SensorBridge] subscribeWristLift not available')
    } else {
      sensor.subscribeWristLift({
        callback: () => {
          this.state.wristLiftCount += 1
          this.state.lastWristLift = Date.now()
          console.log('[SensorBridge] wristLift')
          this._emit('wrist_lift', 1)
        },
        fail: (data, code) => {
          console.warn('[SensorBridge] wristLift failed:', data, code)
        }
      })
    }

    if (!sensor || typeof sensor.subscribeStepCounter !== 'function') {
      console.warn('[SensorBridge] subscribeStepCounter not available')
    } else {
      sensor.subscribeStepCounter({
        callback: (ret) => {
          this.state.steps = ret && ret.steps
          this._emit('step_count', this.state.steps)
        },
        fail: (data, code) => {
          console.warn('[SensorBridge] stepCounter failed:', data, code)
        }
      })
    }
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
      console.warn('[SensorBridge] onSample handler failed:', e && e.message)
    }
  }
}
