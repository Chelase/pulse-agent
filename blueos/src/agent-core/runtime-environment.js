/**
 * 提示组装用的运行环境快照。
 *
 * 只采集不影响隐私、且确实会帮助模型判断的字段；不把配置密钥、
 * 原始传感器历史或用户标识之外的明细写进系统提示。
 */

export function environmentSnapshot(values = {}) {
  const ready = values.ready === undefined ? 'unknown' : (values.ready ? '是' : '否')
  const parts = [
    '运行环境：Pulse Agent 运行于 BlueOS 智能手表',
    `就绪：${ready}`,
    `当前时间：${values.now || new Date().toISOString()}`,
    `已注册工具：${Number(values.tools) || 0} 个`,
    `已加载技能：${Number(values.skills) || 0} 个`
  ]
  if (values.pendingTasks !== undefined) {
    parts.push(`待处理任务：${Number(values.pendingTasks) || 0} 个`)
  }
  return parts.join('；')
}
