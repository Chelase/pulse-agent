/**
 * AgentLoop - Agent 主循环
 *
 * 有界 ReAct 循环：LLM 回复含工具调用 → 执行 → 结果作为消息回填 → 再调 LLM，
 * 直到不再输出工具调用，或达到步数上限。达到上限时强制收口，要一句自然语言结论。
 *
 * 两条入口：
 * - handleUserInput(text)：程序化对话入口（手表无输入界面，由外部调用驱动），走对话上下文。
 * - handleEvent(event)：闸门放行的事件入口，走独立轻量上下文，不写对话历史。
 *
 * 工具调用沿用「提示词 + JSON 解析」，不依赖各家 OpenAI 兼容端点的
 * function-calling 差异（原生 tools 参数作为后续增强选项）。
 */

import { LLMClient } from './llm-client'

// 不封顶：任务可跨心跳窗口续跑，步数不再是「跑不完」的原因。
// 只留一个防失控硬顶：模型连续吐工具调用停不下来时兜底，避免无限烧电烧钱。
const TOOL_STEP_HARD_LIMIT = 50

const SYSTEM_PROMPT = `你是 Pulse Agent，一个运行在智能手表上的 AI 助手。

调用工具时，只输出一个 JSON 对象，不要包裹其它文字：
{"tool": "工具名", "params": {...}}

工具执行结果会以「工具 xxx 返回：...」的形式回填给你。拿到足够信息后，必须用自然语言给出最终结论，不要再输出 JSON。`

const EVENT_SYSTEM_PROMPT = `你是 Pulse Agent，一个运行在智能手表上的 AI 助手。
现在有一条传感器事件跨过了本地闸门，需要你判断是否值得打扰用户。

判断依据：
- 结合事件数据与当前状态，区分「真实异常」与「运动、佩戴状态变化等正常波动」；
- 需要更多数据时可以调用工具查询（事件载荷已包含触发数据，通常无需重复查询）。

输出格式（必须严格遵守，只输出一个 JSON 对象，不要包裹其它文字）：
- 需要提醒用户：{"notify": "<一句话提醒，面向用户，不含专业术语>", "vibrate": true}
- 不需要打扰用户：{"notify": "", "vibrate": false}

约束：
- notify 只给描述性提示，绝不给医疗建议或疾病判断；
- 依据不足时倾向不打扰，不要凭猜测制造提醒。

中途查询数据时按工具协议输出：{"tool": "工具名", "params": {...}}`

export class AgentLoop {
  constructor(contextManager, toolRegistry, skillRegistry) {
    this.context = contextManager
    this.tools = toolRegistry
    this.skills = skillRegistry || null
    this.llm = new LLMClient()
    // 防失控硬顶，可在测试或调优时下调；默认不封顶到 50 步
    this.stepHardLimit = TOOL_STEP_HARD_LIMIT
  }

  async init() {
    await this.llm.init()
  }

  /**
   * 单步推进一个落盘任务：一次调用只做一次 LLM 往返（外加本地工具执行），
   * 进度留在 task.messages / task.stepsUsed 上，由调用方落盘。
   *
   * 后台窗口时长不确定，所以「跑完一个任务」跨多次唤醒完成，而不是在一个窗口里硬撑。
   * @returns {Promise<boolean>} 本次调用是否有进展（false = 已结束或无法继续）
   */
  async stepTask(task) {
    if (!task || task.status === 'done' || task.status === 'failed') return false

    if (!this.llm.isConfigured()) {
      task.status = 'failed'
      task.result = 'LLM 未配置，请在控制面配置 endpoint 和 apiKey'
      return false
    }

    if (task.status === 'pending') {
      task.messages = await this._prepareMessages(task)
      task.status = 'running'
    }

    const budget = this.stepHardLimit
    if (task.stepsUsed >= budget && !this._hasConclusionNudge(task.messages)) {
      task.messages.push({
        role: 'user',
        content: '已达工具调用步数上限。请基于已有信息直接用自然语言给出最终结论，不要再调用工具。'
      })
    }

    let reply
    try {
      reply = await this.llm.chat(task.messages)
    } catch (err) {
      task.error = err && err.message ? err.message : String(err)
      console.error('[AgentLoop] stepTask llm failed:', task.error)
      // 网络失败不判死：下个心跳窗口重试同一步
      return false
    }

    const content = reply && reply.content
    if (!content) return false

    const toolCall = this._parseToolCall(content)
    if (toolCall && task.stepsUsed < budget) {
      task.stepsUsed += 1
      task.messages.push({ role: 'assistant', content })
      const result = await this._executeTool(toolCall)
      task.messages.push({
        role: 'user',
        content: `工具 ${toolCall.tool} 返回：${JSON.stringify(result)}`
      })
      return true
    }

    await this._finalizeTask(task, content)
    return true
  }

  async _prepareMessages(task) {
    if (task.kind === 'event') {
      const skillHit = this.skills ? this.skills.match(task.event && task.event.conditionId) : null
      return [
        { role: 'system', content: EVENT_SYSTEM_PROMPT + this._toolListBlock() + this._skillBlock(skillHit) },
        { role: 'user', content: this._formatEvent(task.event) }
      ]
    }

    const skillHit = this.skills ? this.skills.matchText(task.instruction) : null
    return [
      { role: 'system', content: SYSTEM_PROMPT + this._toolListBlock() + this._skillBlock(skillHit) },
      ...this.context.getRecentMessages().map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: task.instruction }
    ]
  }

  async _finalizeTask(task, content) {
    if (task.kind === 'event') {
      const verdict = this._parseEventVerdict(content)
      await this._emitVerdict(task.event, verdict)
      task.result = verdict.notify || ''
    } else {
      task.result = content
      await this.context.addMessage('user', task.instruction)
      await this.context.addMessage('assistant', content)
    }
    task.status = 'done'
    task.messages = []
    console.log(`[AgentLoop] task done id=${task.id} steps=${task.stepsUsed}`)
  }

  _hasConclusionNudge(messages) {
    const last = messages && messages[messages.length - 1]
    return !!(last && typeof last.content === 'string' && last.content.indexOf('已达工具调用步数上限') === 0)
  }

  async handleUserInput(text) {
    await this.context.addMessage('user', text)

    if (!this.llm.isConfigured()) {
      const msg = 'LLM 未配置，请在设置中配置 endpoint 和 apiKey'
      await this.context.addMessage('assistant', msg)
      return msg
    }

    try {
      const messages = this._buildMessages(text)
      const finalText = await this._runLoop(messages, this.stepHardLimit)
      const out = finalText || 'LLM 未返回有效结论'
      await this.context.addMessage('assistant', out)
      return out
    } catch (err) {
      console.error('[AgentLoop] handleUserInput failed', err)
      const msg = '处理失败: ' + (err && err.message ? err.message : String(err))
      await this.context.addMessage('assistant', msg)
      return msg
    }
  }

  /**
   * 事件入口：闸门放行的事件走独立轻量上下文（system + 事件载荷），不写对话历史。
   * 产出为「面向用户的简短提醒 + 是否振动」，默认落 notification_send + vibrate。
   */
  async handleEvent(event) {
    if (!this.llm.isConfigured()) {
      console.warn('[AgentLoop] handleEvent skipped: LLM 未配置')
      return null
    }

    const messages = [
      {
        role: 'system',
        content: EVENT_SYSTEM_PROMPT + this._toolListBlock()
          + this._skillBlock(this.skills ? this.skills.match(event && event.conditionId) : null)
      },
      { role: 'user', content: this._formatEvent(event) }
    ]

    try {
      const raw = await this._runLoop(messages, this.stepHardLimit)
      if (!raw) return null
      const verdict = this._parseEventVerdict(raw)
      await this._emitVerdict(event, verdict)
      return verdict.notify
    } catch (err) {
      console.error('[AgentLoop] handleEvent failed', err)
      return null
    }
  }

  /**
   * 有界 ReAct 循环。messages 由调用方提供，循环内的中间消息只存在于本地数组，
   * 不会写进对话历史。
   */
  async _runLoop(messages, maxSteps) {
    for (let step = 0; step < maxSteps; step++) {
      const reply = await this.llm.chat(messages)
      const content = reply && reply.content
      if (!content) return null

      const toolCall = this._parseToolCall(content)
      if (!toolCall) return content

      console.log(`[AgentLoop] step${step + 1} tool=${toolCall.tool} params=${JSON.stringify(toolCall.params)}`)
      messages.push({ role: 'assistant', content })
      const result = await this._executeTool(toolCall)
      messages.push({
        role: 'user',
        content: `工具 ${toolCall.tool} 返回：${JSON.stringify(result)}`
      })
    }

    // 达到步数上限仍未收敛：强制要一句自然语言结论，避免把裸工具结果当回复
    console.log('[AgentLoop] tool step limit reached, forcing conclusion')
    messages.push({
      role: 'user',
      content: '已达工具调用步数上限。请基于已有信息直接用自然语言给出最终结论，不要再调用工具。'
    })
    const finalReply = await this.llm.chat(messages)
    return finalReply && finalReply.content ? finalReply.content : null
  }

  async _executeTool(toolCall) {
    try {
      return await this.tools.execute(toolCall.tool, toolCall.params)
    } catch (err) {
      console.error('[AgentLoop] tool failed:', toolCall.tool, err)
      return { success: false, error: err && err.message ? err.message : String(err) }
    }
  }

  _buildMessages(text) {
    const hit = this.skills ? this.skills.matchText(text) : null
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + this._toolListBlock() + this._skillBlock(hit) },
      ...this.context.getRecentMessages().map(m => ({
        role: m.role,
        content: m.content
      }))
    ]
    return messages
  }

  _toolListBlock() {
    const toolDesc = this.tools.getTools()
      .map(t => `- ${t.name}: ${t.description}`)
      .join('\n')
    return '\n\n可用工具列表：\n' + toolDesc
  }

  /**
   * 渐进式披露：frontmatter 常驻 system prompt，Markdown 正文只在 trigger 命中时注入。
   */
  _skillBlock(hit) {
    if (!this.skills) return ''
    const frontmatter = this.skills.getFrontmatterBlock()
    if (!hit) return frontmatter
    console.log('[AgentLoop] skill hit:', hit.id)
    return frontmatter + `\n\n当前适用技能：${hit.name}\n${hit.body}`
  }

  _formatEvent(event) {
    return [
      `事件类型：${event.conditionId}`,
      `事件说明：${event.description}`,
      `触发数据：${event.dataType} = ${event.value}`,
      `触发时间：${new Date(event.timestamp || Date.now()).toISOString()}`
    ].join('\n')
  }

  /**
   * 容错解析事件结论。不是约定 JSON 时按「默认提醒」处理，
   * 除非模型明确表示无需提醒。
   */
  _parseEventVerdict(raw) {
    const parsed = this._jsonObject(raw)
    if (parsed && typeof parsed.notify === 'string') {
      return { notify: parsed.notify.trim(), vibrate: !!parsed.vibrate }
    }

    const text = String(raw || '').trim()
    if (!text || /无需提醒|不需要提醒|不必提醒|无需打扰/.test(text)) {
      return { notify: '', vibrate: false }
    }
    return { notify: text, vibrate: false }
  }

  async _emitVerdict(event, verdict) {
    if (verdict.notify) {
      await this._executeTool({
        tool: 'notification_send',
        params: { title: event.description || 'Pulse Agent', text: verdict.notify }
      })
    }
    if (verdict.vibrate) {
      await this._executeTool({ tool: 'vibrate', params: { mode: 'long' } })
    }
  }

  _parseToolCall(content) {
    if (!content) return null
    const anchor = content.indexOf('"tool"')
    if (anchor === -1) return null

    for (const candidate of this._jsonCandidates(content, anchor)) {
      let parsed
      try {
        parsed = JSON.parse(candidate)
      } catch (e) {
        continue
      }
      if (parsed && typeof parsed.tool === 'string' && parsed.tool) {
        return { tool: parsed.tool, params: parsed.params || {} }
      }
    }
    return null
  }

  /** 从模型输出里捞出第一个可解析的 JSON 对象。 */
  _jsonObject(content) {
    if (!content) return null
    for (const candidate of this._jsonCandidates(content, -1)) {
      try {
        return JSON.parse(candidate)
      } catch (e) {
        // 试下一个候选
      }
    }
    return null
  }

  /**
   * 收集候选 JSON 片段：优先 fenced 代码块；给了 anchor 就取包含它的平衡括号片段，
   * 否则取第一个 '{' 起的平衡括号片段；最后整体兜底。
   */
  _jsonCandidates(content, anchor) {
    const candidates = []

    const fenced = content.match(/```[a-zA-Z]*\s*([\s\S]*?)```/)
    if (fenced && fenced[1]) candidates.push(fenced[1].trim())

    const start = anchor >= 0 ? content.lastIndexOf('{', anchor) : content.indexOf('{')
    if (start !== -1) {
      const end = this._matchBrace(content, start)
      if (end > start) candidates.push(content.slice(start, end + 1))
    }

    candidates.push(content.trim())
    return candidates
  }

  /**
   * 返回从 text[start] 的 '{' 开始、与之匹配的 '}' 的下标；找不到返回 -1。
   * 跳过字符串字面量内的括号。
   */
  _matchBrace(text, start) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) return i
      }
    }
    return -1
  }
}
