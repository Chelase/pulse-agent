/**
 * 工具结果进入模型上下文前的统一治理。
 *
 * 工具本身仍返回完整结构；这里只限制回填给 LLM 的文本体积，
 * 避免一次文件读取或传感器快照把上下文窗口挤爆。
 */

const MAX_TOOL_RESULT_CHARS = 4000

export function formatToolResult(result, maxChars = MAX_TOOL_RESULT_CHARS) {
  let raw
  try {
    raw = JSON.stringify(result)
  } catch (e) {
    return JSON.stringify({ status: 'error', reason: 'unserializable_result' })
  }
  if (!raw) return 'null'
  if (raw.length <= maxChars) return raw

  const status = result && result.status
    ? result.status
    : (result && result.success === false ? 'error' : 'ok')
  return JSON.stringify({
    status,
    truncated: true,
    original_chars: raw.length,
    preview: raw.slice(0, Math.max(0, maxChars - 120)),
    note: '工具输出已截断，只能依据 preview 回答；需要更多数据请缩小参数范围后重试。'
  })
}

export { MAX_TOOL_RESULT_CHARS }
