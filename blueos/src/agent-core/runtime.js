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

/**
 * 单步超时。真机上任何一个平台回调不返回都能把整条启动链挂死，
 * 表现出来就是首页永远停在「启动中」——个例见 heartbeat 的定时任务注册。
 */
const STEP_TIMEOUT_MS = 5000

/** 只这几步失败才算「没起来」；其余是可选增强，降级也要继续跑。 */
const CRITICAL_STEPS = ['identity.init', 'context.init', 'agentLoop.init']

function withTimeout(task, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`step timeout after ${ms}ms`))
    }, ms)
    Promise.resolve()
      .then(task)
      .then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        }
      )
  })
}

export class AgentRuntime {
  constructor() {
    if (_instance) {
      return _instance
    }
    this.ready = false
    this.failedStep = ''
    this.stepResults = []
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
    // 系统提示里的「运行环境」必须是真实状态，不能是恒为 unknown 的占位
    this.agentLoop.setEnvironmentProvider(() => this._environmentSnapshot())
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
    this.stepTotal = steps.length
    console.log('[Runtime] start begin')
    this.failedStep = ''
    this.stepResults = []

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const startedAt = Date.now()
      console.log(`[Runtime] step${i + 1}: ${step.name}...`)
      try {
        await withTimeout(step.fn, STEP_TIMEOUT_MS)
        this.stepResults.push({ name: step.name, ok: true, error: '', ms: Date.now() - startedAt })
        console.log(`[Runtime] step${i + 1} done: ${step.name}`)
      } catch (e) {
        const error = e && e.message ? e.message : String(e)
        this.stepResults.push({ name: step.name, ok: false, error, ms: Date.now() - startedAt })
        if (!this.failedStep) this.failedStep = step.name
        console.warn(`[Runtime] step${i + 1} failed: ${step.name}, error: ${error}`)
        // 关键步骤失败就停下来继续装配没有意义；可选步骤降级继续，避免一个外围
        // 模块把首启引导一起吞掉（真机表现就是永远停在「启动中」）
        if (CRITICAL_STEPS.indexOf(step.name) !== -1) break
      }
    }

    const criticalFailure = this.stepResults.find(
      r => !r.ok && CRITICAL_STEPS.indexOf(r.name) !== -1
    )
    this.ready = !criticalFailure
    console.log(`[Runtime] startup: ${this.ready ? 'ready' : 'not ready'}, steps=${this.stepResults.length}/${steps.length}`
      + (this.failedStep ? `, failedStep=${this.failedStep}` : ''))
    if (this.ready) {
      let rootId = 'uninitialized'
      try {
        rootId = this.identity.getRootId()
      } catch (e) {
        rootId = 'uninitialized'
      }
      console.log('[Runtime] started, rootId=' + rootId)
    }

    // 引导与「执行层是否完全就绪」解耦：只要核心装配完成就出码，否则手表屏
    // 永远停在启动中，用户连配置入口都看不到。
    try {
      const llm = this.agentLoop && this.agentLoop.llm
      this.configOnboarding = new ConfigOnboarding(llm, this.identity)
      await this.configOnboarding.start()
    } catch (onboardErr) {
      console.warn('[Runtime] config onboarding skipped:', onboardErr && onboardErr.message ? onboardErr.message : onboardErr)
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

  /**
   * 给系统提示用的运行环境快照原料。只放不影响隐私、且能帮助模型判断的字段。
   */
  _environmentSnapshot() {
    return {
      ready: this.ready,
      tools: this.toolRegistry ? this.toolRegistry.getTools().length : 0,
      skills: this.skillRegistry ? this.skillRegistry.list().length : 0,
      pendingTasks: this.taskQueue ? this.taskQueue.pendingCount() : 0
    }
  }

  getState() {
    const healthState = this.healthBridge.getState()
    const llmStatus = this.agentLoop && this.agentLoop.llm
      ? this.agentLoop.llm.getStatus()
      : { configured: false, model: '', endpoint: '', hasApiKey: false }
    return {
      ready: this.ready,
      failedStep: this.failedStep || '',
      // 手表端没有控制台，首页是唯一能读到启动结果的地方
      steps: (this.stepResults || []).map(s => ({ name: s.name, ok: s.ok, error: s.error })),
      stepTotal: this.stepTotal || 0,
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
