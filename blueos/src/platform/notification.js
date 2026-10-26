/**
 * Notification - BlueOS 通知封装
 */

import notificationManager from '@blueos.app.notification.notificationManager'

export const Notification = {
  send(title, text, options = {}) {
    return new Promise((resolve, reject) => {
      notificationManager.publish({
        request: {
          icon: options.icon || '/assets/images/logo.png',
          contentType: 1,
          content: {
            title,
            text,
            additionalText: options.additionalText || ''
          },
          channel: options.channel || 2,
          deliveryTime: Date.now(),
          id: options.id,
          isUnremovable: options.isUnremovable || false
        },
        success: () => resolve(),
        fail: (data, code) => reject(new Error(`notification failed: ${data} (${code})`))
      })
    })
  }
}
