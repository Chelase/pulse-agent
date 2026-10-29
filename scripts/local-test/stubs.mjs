/**
 * BlueOS 平台 API 桩。
 *
 * 本项目的代码跑在 BlueOS 上（`@blueos.*` 模块 + `.ux` 页面），Node 里无法直接加载。
 * 这里用最小实现替换平台 API，让 agent-core 的逻辑能在本地跑起来——真机验证是唯一
 * 硬阻塞项，本地桩是当前唯一可用的回归手段。
 *
 * 覆盖：KV 存储、文件存储、HTTP fetch、传感器、健康、通知、振动。
 */

import http from 'node:http'

/** 所有桩共享的可观测状态，测试里用它做断言与重置。 */
export const memory = {
  kv: new Map(),
  files: new Map(),
  dirs: new Set(),
  notifications: [],
  vibrations: [],
  requests: [],
  fetchFails: 0,
  reset() {
    this.kv.clear()
    this.files.clear()
    this.dirs.clear()
    this.notifications.length = 0
    this.vibrations.length = 0
    this.requests.length = 0
    this.fetchFails = 0
    fetchStub.reset()
    scheduleStub.reset()
    bluetoothStub.reset()
  }
}

/** 把值直接塞进 KV，等价于「手表上已配置过」。 */
export function setKV(key, value) {
  memory.kv.set(key, JSON.stringify(value))
}

export function getKV(key) {
  const raw = memory.kv.get(key)
  return raw === undefined ? undefined : JSON.parse(raw)
}

// ---------------- KV 存储 ----------------

export const storageStub = {
  set({ key, value, success, fail }) {
    if (this.failSet) {
      if (fail) fail('storage full', 500)
      return
    }
    memory.kv.set(key, value)
    if (success) success()
  },
  get({ key, success, fail }) {
    if (memory.kv.has(key)) {
      if (success) success({ value: memory.kv.get(key) })
    } else if (fail) {
      fail('not found', 201)
    }
  },
  delete({ key, success }) {
    memory.kv.delete(key)
    if (success) success()
  }
}

// ---------------- 文件存储 ----------------

export const fileStub = {
  /**
   * 真实平台在目录已存在时也会走 fail（recursive 也一样），桩按同样行为实现。
   * 这正是 storage.js 的 mkdirp 必须用 access 复核、不能把 fail 一律当错误的原因。
   * 这里刻意给一个非 202 的 code，防止实现退回「靠错误码判断」。
   */
  mkdir({ uri, success, fail }) {
    if (memory.dirs.has(uri)) {
      if (fail) fail(`目录/文件 ${uri} 已经存在。`, 500)
      return
    }
    memory.dirs.add(uri)
    if (success) success()
  },
  writeText({ uri, text, append, success, fail }) {
    const parent = uri.slice(0, uri.lastIndexOf('/'))
    if (!memory.dirs.has(parent)) {
      if (fail) fail(`目录不存在: ${parent}`, 201)
      return
    }
    const prev = append ? (memory.files.get(uri) || '') : ''
    memory.files.set(uri, prev + text)
    if (success) success()
  },
  readText({ uri, success, fail }) {
    if (memory.files.has(uri)) {
      if (success) success({ text: memory.files.get(uri) })
    } else if (fail) {
      fail('not found', 201)
    }
  },
  access({ uri, success, fail }) {
    if (memory.files.has(uri) || memory.dirs.has(uri)) {
      if (success) success()
    } else if (fail) {
      fail(`目录/文件 ${uri} 不存在。`, 201)
    }
  },
  delete({ uri, success }) {
    memory.files.delete(uri)
    if (success) success()
  }
}

// ---------------- HTTP fetch ----------------

/**
 * 模拟 `@blueos.network.fetch`：回调式，success 收到 `{ code, data, headers }`。
 * 用 `fetchStub.respond(pattern, handler)` 按 URL 编排响应；
 * 未编排的请求打真实 HTTP（供外部服务联调测试打到本地 mock 服务）。
 */
export const fetchStub = {
  _routes: [],
  reset() {
    this._routes.length = 0
  },
  /** handler 可以是返回值，也可以是 (body) => 返回值 的函数。同 pattern 覆盖前一条。 */
  respond(pattern, handler) {
    const route = { pattern, handler }
    const idx = this._routes.findIndex(r => r.pattern === pattern)
    if (idx === -1) this._routes.push(route)
    else this._routes[idx] = route
  },
  _match(url) {
    return this._routes.find(r => String(url).indexOf(r.pattern) !== -1) || null
  }
}

export function blueosFetch(options) {
  const { url, method = 'GET', header = {}, data, responseType = 'json', success, fail } = options
  memory.requests.push({ url, method, data })

  // 平台实测（模拟器）：responseType:'json' 遇空响应体（如 204）在原生 JSON.parse 就抛
  // JSError: unexpected end of input，success/fail 都走不到；只有 'text' 能安全拿到空体。
  // 桩照此模拟，逼着可能拿到空响应的调用（轮询 204）用 'text' + 手工解析。
  function deliver(status, body, headers) {
    if (responseType !== 'text' && typeof body === 'string' && body.trim() === '') {
      memory.fetchFails++
      if (fail) fail('unexpected end of input', -1)
      return
    }
    if (success) success({ code: status, data: body, headers })
  }

  const route = fetchStub._match(url)
  if (route) {
    let body
    try {
      body = typeof route.handler === 'function' ? route.handler(data) : route.handler
    } catch (e) {
      memory.fetchFails++
      if (fail) fail(e.message, 500)
      return
    }
    if (body && body.__status && body.__status >= 400) {
      memory.fetchFails++
      if (fail) fail(body, body.__status)
      return
    }
    deliver(200, body, {})
    return
  }

  const payload = data === undefined || data === null ? null : JSON.stringify(data)
  const target = new URL(url)
  const headers = Object.assign({}, header)
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload)

  const req = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method,
    headers
  }, (res) => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed = raw
      // 'text' 交付原文；'json' 平台会自己解析，桩同形（非 JSON 保留原文兜底）
      if (responseType !== 'text') {
        try { parsed = JSON.parse(raw) } catch (e) { /* 保留原文 */ }
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        deliver(res.statusCode, parsed, res.headers)
      } else {
        memory.fetchFails++
        if (fail) fail(parsed, res.statusCode)
      }
    })
  })

  req.on('error', (e) => {
    memory.fetchFails++
    if (fail) fail(e.message, 0)
  })
  if (payload) req.write(payload)
  req.end()
}

export default blueosFetch

/**
 * 平台真实形状：默认导出是「带 .fetch 方法的对象」，不是可调用函数。
 * 桩必须照抄这个形状，否则代码里写错 fetch() / fetch.fetch() 在本地测不出来
 * （真机上表现为 JSError: not a function）。
 */
export const fetchModule = { fetch: blueosFetch }

// ---------------- 传感器 ----------------

export const sensorStub = {
  _subs: {},
  subscribeOnBodyState({ callback }) { this._subs.onBody = callback },
  subscribeWristLift({ callback }) { this._subs.wristLift = callback },
  subscribeStepCounter({ callback }) { this._subs.steps = callback },
  emitOnBody(value) { if (this._subs.onBody) this._subs.onBody({ value }) },
  emitWristLift() { if (this._subs.wristLift) this._subs.wristLift() },
  emitSteps(steps) { if (this._subs.steps) this._subs.steps({ steps }) }
}

// ---------------- 健康 ----------------

export const healthStub = {
  DATA_TYPES: { HEART_RATE: 'heart_rate', STEP_COUNT: 'step_count' },
  STATISTIC_TYPES: { SUM: 'sum' },
  _subs: {},
  _todaySteps: 3200,
  subscribeSample({ dataType, callback }) { this._subs[dataType] = callback },
  getTodayStatistic({ success }) { if (success) success({ value: this._todaySteps }) },
  emitHeartRate(value) { if (this._subs.heart_rate) this._subs.heart_rate({ value }) }
}

// ---------------- 通知 / 振动 ----------------

export const notificationStub = {
  publish({ request, success }) {
    memory.notifications.push(request)
    if (success) success()
  }
}

export const vibratorStub = {
  vibrate({ mode, success }) {
    memory.vibrations.push(mode)
    if (success) success()
  }
}

// ---------------- 定时任务（心跳载体） ----------------

/**
 * 模拟 `@blueos.app.appmanager.schedule`。
 * 真实平台由系统后台拉起 app.ux 上的 triggerMethod，桩里由测试显式 fire()。
 */
export const scheduleStub = {
  jobs: new Map(),
  _nextId: 1,
  _byMethod: {},
  /** 注册「哪个方法名对应哪个回调」，等价于 app.ux 上挂了 agentTick。 */
  bind(methodName, fn) {
    this._byMethod[methodName] = fn
  },
  scheduleJob({ type, timeout, interval, triggerMethod, params, success, fail }) {
    if (this.hangNext) {
      // 平台既不 success 也不 fail：真机上出现过整条启动链停在这一步
      this.hangNext = false
      return undefined
    }
    if (this.failNext) {
      this.failNext = false
      if (fail) fail('generic error', 200)
      return
    }
    const id = this._nextId++
    this.jobs.set(id, { id, type, timeout, interval, triggerMethod, params, fired: 0 })
    if (success) success({ id })
    return id
  },
  cancel({ id, success }) {
    const had = this.jobs.delete(id)
    if (success) success({ value: had })
  },
  /** 触发一次心跳（返回 triggerMethod 的调用结果）。 */
  async fire(methodName, params) {
    const job = [...this.jobs.values()].find(j => j.triggerMethod === methodName)
    if (!job) throw new Error(`未注册的心跳方法: ${methodName}`)
    if (job.type !== 2) throw new Error(`心跳必须用 type=2 真实时间流逝，实际 ${job.type}`)
    job.fired++
    const fn = this._byMethod[methodName]
    return fn ? fn(params || job.params || {}) : undefined
  },
  reset() {
    this.jobs.clear()
    this._byMethod = {}
    this._nextId = 1
    this.failNext = false
    this.hangNext = false
  }
}

// ---------------- 蓝牙 GATT Server（入站服务面） ----------------

export const bluetoothStub = {
  BLE: {
    createGattServer() {
      const server = {
        services: [],
        advertising: null,
        _writeCb: null,
        responses: [],
        notifications: [],
        addService(service) {
          this.services.push(service)
          return true
        },
        startAdvertising(setting, advData, advResponse) {
          this.advertising = { setting, advData, advResponse }
          return true
        },
        subscribeCharacteristicWrite({ callback }) {
          this._writeCb = callback
          return true
        },
        sendResponse(serverResponse) {
          this.responses.push(serverResponse)
          return true
        },
        notifyCharacteristicChanged(deviceId, notifyCharacteristic) {
          this.notifications.push({ deviceId, notifyCharacteristic })
          return true
        },
        /** 测试用：模拟对端往 cmd 特征写了一段 UTF-8 文本。 */
        async writeFromClient(deviceId, text) {
          const bytes = new Uint8Array(Buffer.from(text, 'utf8'))
          const req = {
            deviceId,
            transId: 7,
            offset: 0,
            isPrep: false,
            needRsp: true,
            value: bytes.buffer,
            characteristicUuid: '0000f381-0000-1000-8000-00805f9b34fb'
          }
          if (!this._writeCb) throw new Error('未订阅写请求')
          return this._writeCb(req)
        }
      }
      bluetoothStub._servers.push(server)
      return server
    }
  },
  _servers: [],
  get lastServer() {
    return this._servers[this._servers.length - 1] || null
  },
  reset() {
    this._servers = []
  }
}


