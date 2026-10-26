/**
 * Vibrator - BlueOS 振动反馈封装
 */

import vibrator from '@blueos.hardware.vibrator.vibrator'

export const Vibrator = {
  vibrate(mode = 'short') {
    return new Promise((resolve, reject) => {
      vibrator.vibrate({
        mode,
        success: () => resolve(),
        fail: (data, code) => reject(new Error(`vibrate failed: ${data} (${code})`))
      })
    })
  }
}
