/**
 * AgentRuntime - 手表 Agent 运行时入口
 * 负责初始化并协调所有子系统。
 */

import { Identity } from './identity'
import { ContextManager } from './context-manager'
import { FileManager } from './file-manager'
import { SensorBridge } from './sensor-bridge'
import { HealthBridge } from './health-bridge'
import { GateEvaluator } from './gate-evaluator'
import { SkillRegistry } from './skill-registry'
import { ToolRegistry } from './tool-registry'
import { AgentLoop } from './agent-loop'
import { ConfigOnboarding } from './config-onboarding'
import { TaskQueue } from './task-queue'
import { JobRegistry } from './jobs'
import { MCPClient } from './mcp-client'
import { Heartbeat } from './heartbeat'

let _instance = null

export class AgentRuntime {
  constructor() {
    if (_instance) {
      return _instance
    }
    this.ready = false
    this.failedStep = ''
    this._lastEvent = ''
    this._eventBusy = false
    this.identity = new Identity()
    this.context = new ContextManager()
    this.fileManager = new FileManager()
    this.gateEvaluator = new GateEvaluator()
    this.skillRegistry = new SkillRegistry()
    // 传感器/健康采样先过闸门，只有跨门的事件才进 Agent
    this.sensorBridge = new SensorBridge((type, value) => this._onSample(type, value))
    this.healthBridge = new HealthBridge((type, value) => this._onSample(type, value))
    this.toolRegistry = new ToolRegistry(
      this.fileManager,
      this.sensorBridge,
      this.healthBridge
    )
    this.agentLoop = new AgentLoop(this.context, this.toolRegistry, this.skillRegistry)
    this.configOnboarding = null
    // 常驻三件套：落盘队列 + 定时任务表 + 心跳。心跳每次醒来只推进一点活。
    this.taskQueue = new TaskQueue()
    this.jobs = new JobRegistry()
    this.mcpClient = new MCPClient()
    this.heartbeat = new Heartbeat(this)
    _instance = this
  }

  static getInstance() {
    if (!_instance) {
      _instance = new AgentRuntime()
    }
    return _instance
  }

  async start() {
    const steps = [
      { name: 'identity.init', fn: () => this.identity.init() },
      { name: 'context.init', fn: () => this.context.init() },
      { name: 'agentLoop.init', fn: () => this.agentLoop.init() },
      { name: 'skillRegistry.init', fn: () => this.skillRegistry.init() },
      { name: 'gateEvaluator.init', fn: () => this.gateEvaluator.init() },
      { name: 'taskQueue.init', fn: () => this.taskQueue.init() },
      { name: 'jobs.init', fn: () => this.jobs.init() },
      // MCP 是可选增强：单个 server 连不上只 warn，不阻塞启动
      { name: 'mcpClient.init', fn: async () => { await this.mcpClient.init(); this.mcpClient.registerTools(this.toolRegistry) } },
      { name: 'sensorBridge.start', fn: () => this.sensorBridge.start() },
      { name: 'healthBridge.start', fn: () => this.healthBridge.start() },
      { name: 'heartbeat.start', fn: () => this.heartbeat.start() }
    ]
    console.log('[Runtime] start begin')
    let failedStep = 'unknown'
    this.failedStep = ''
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        failedStep = step.name
        console.log(`[Runtime] step${i + 1}: ${step.name}...`)
        await step.fn()
        console.log(`[Runtime] step${i + 1} done: ${step.name}`)
      }
      this.ready = true
      this.failedStep = ''
      console.log('[Runtime] started, rootId=' + this.identity.getRootId())
      try {
        const llm = this.agentLoop && this.agentLoop.llm
        this.configOnboarding = new ConfigOnboarding(llm, this.identity)
        await this.configOnboarding.start()
      } catch (onboardErr) {
        console.warn('[Runtime] config onboarding skipped:', onboardErr && onboardErr.message ? onboardErr.message : onboardErr)
      }
    } catch (e) {
      this.failedStep = failedStep
      console.error(`[Runtime] start failed at step: ${failedStep}, error: ${e && e.message ? e.message : String(e)}`)
      if (e && e.stack) {
        console.error('[Runtime] stack: ' + e.stack)
      }
      throw e
    }
  }

  stop() {
    console.log('[Runtime] stopping...')
    this.ready = false
    if (this.heartbeat) {
      this.heartbeat.stop()
    }
    if (this.configOnboarding) {
      this.configOnboarding.stop()
    }
  }

  /** 心跳入口：app.ux 的 agentTick 由系统后台拉起时调这里。 */
  tick() {
    return this.heartbeat.tick()
  }

  /**
   * 外部指令入队（BLE、外部生态下发、手动提交都走这里）。
   * 入队即返回，执行由心跳按预算推进。
   */
  async submitTask({ kind = 'conversation', instruction, source = '', event = null }) {
    const task = this.taskQueue.enqueue({ kind, instruction, source, event })
    await this.taskQueue.save()
    console.log(`[Runtime] task queued id=${task.id} kind=${kind} from=${source || '-'}`)
    return task
  }

  /**
   * 在给定预算内把单个任务跑到收敛，供需要同步拿结果的入口使用。
   * 超预算则任务留在队列里，由后续心跳接着跑。
   */
  async runTaskToCompletion(task, budgetMs = 20000) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < budgetMs) {
      const progressed = await this.agentLoop.stepTask(task)
      task.updatedAt = Date.now()
      await this.taskQueue.save()
      if (task.status === 'done' || task.status === 'failed') break
      if (!progressed) break
    }
    return task
  }

  /** 到期 job 转成队列任务；返回入队条数。错过的轮次不补跑。 */
  async dueJobsToQueue() {
    const due = this.jobs.due()
    if (!due.length) return 0
    due.forEach(job => {
      this.taskQueue.enqueue({ kind: 'conversation', instruction: job.instruction, source: 'job:' + job.name })
    })
    await this.taskQueue.save()
    console.log(`[Runtime] ${due.length} 个定时任务到期入队: ${due.map(d => d.name).join(', ')}`)
    return due.length
  }

  /**
   * BLE 入站指令：接受 JSON（{task_id, instruction}）或裸文本。
   * 腕上窗口时长有限，能跑完就回 completed，跑不完回 accepted 并继续留在队列。
   */
  async handleInboundCommand(text) {
    const taskId = 'ble-' + Date.now()
    let instruction = text
    let id = taskId
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        instruction = parsed.instruction || parsed.text || ''
        id = parsed.task_id || taskId
      }
    } catch (e) {
      // 裸文本指令，按原样使用
    }
    if (!instruction) {
      return { task_id: id, status: 'failed', error: '指令为空' }
    }

    const task = await this.submitTask({ kind: 'conversation', instruction, source: 'ble' })
    task.id = id
    await this.runTaskToCompletion(task, 20000)

    if (task.status === 'done') return { task_id: id, status: 'completed', result: task.result }
    if (task.status === 'failed') return { task_id: id, status: 'failed', error: task.result }
    return { task_id: id, status: 'accepted', note: '后台窗口预算用尽，任务留在队列由心跳继续' }
  }

  getState() {
    const healthState = this.healthBridge.getState()
    const llmStatus = this.agentLoop && this.agentLoop.llm
      ? this.agentLoop.llm.getStatus()
      : { configured: false, model: '', endpoint: '', hasApiKey: false }
    return {
      ready: this.ready,
      failedStep: this.failedStep || '',
      deviceId: this.identity.getDeviceId() || 'uninitialized',
      lastHeartRate: healthState.heartRate || 0,
      lastEvent: this._lastEvent || '',
      llm: llmStatus,
      onboarding: this.configOnboarding && this.configOnboarding.getStatus
        ? this.configOnboarding.getStatus()
        : { phase: llmStatus.configured ? 'configured' : 'idle', code: '', qrValue: '', setupUrl: '', error: '' },
      resident: {
        ticks: this.heartbeat ? this.heartbeat.ticks : 0,
        heartbeatJobId: this.heartbeat ? this.heartbeat.jobId : -1,
        heartbeatSource: this.heartbeat ? this.heartbeat.source : '',
        pendingTasks: this.taskQueue ? this.taskQueue.pendingCount() : 0,
        jobs: this.jobs ? this.jobs.list().length : 0,
        mcpTools: this.toolRegistry ? this.toolRegistry.getTools().length : 0
      }
    }
  }

  async handleUserInput(text) {
    if (!this.ready) {
      return 'Agent 尚未就绪'
    }
    this._lastEvent = '用户: ' + text
    const reply = await this.agentLoop.handleUserInput(text)
    this._lastEvent = reply
    return reply
  }

  /**
   * 对外统一任务入口（外部生态调用方使用）。
   * 包装 agent-loop，产出 { task_id, status, result }。
   */
  async handleExternalRequest(task) {
    const taskId = (task && task.task_id) || ''
    if (!this.ready) {
      return { task_id: taskId, status: 'failed', error: 'Agent 尚未就绪' }
    }
    const instruction = task && (task.instruction || task.text)
    if (!instruction) {
      return { task_id: taskId, status: 'failed', error: '任务缺少 instruction' }
    }

    try {
      const result = await this.handleUserInput(instruction)
      return { task_id: taskId, status: 'completed', result }
    } catch (e) {
      return {
        task_id: taskId,
        status: 'failed',
        error: e && e.message ? e.message : String(e)
      }
    }
  }

  /**
   * 采样入口：先过闸门（同步、廉价），跨门的事件才唤醒 Agent。
   * 上一事件还在处理时丢弃新事件——避免并发 LLM 调用打爆功耗预算。
   */
  async _onSample(dataType, value) {
    if (!this.ready) return

    const condition = this.gateEvaluator.evaluate(dataType, value)
    if (!condition) return

    if (this._eventBusy) {
      console.log('[Runtime] event dropped, previous event still processing:', condition.id)
      return
    }
    this._eventBusy = true

    const event = {
      conditionId: condition.id,
      description: condition.description,
      dataType,
      value,
      timestamp: Date.now()
    }
    this._lastEvent = '闸门: ' + condition.id
    console.log(`[Runtime] gate passed: ${condition.id} (${dataType}=${value})`)

    try {
      const notify = await this.agentLoop.handleEvent(event)
      this._lastEvent = notify || this._lastEvent
    } catch (e) {
      console.error('[Runtime] handleEvent failed:', e && e.message ? e.message : String(e))
    } finally {
      this._eventBusy = false
    }
  }
}
