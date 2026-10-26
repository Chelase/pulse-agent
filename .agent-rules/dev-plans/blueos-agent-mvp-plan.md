# BlueOS 手表 Agent MVP 开发计划

> **架构参考**：`ARCHITECTURE.md`
> **Agent 执行层参考**：openclaw / hermes（执行层架构模式复用）
> **平台 API**：https://developers-watch.vivo.com.cn

---

## 当前阶段


**目标平台只有 BlueOS**（见 `ARCHITECTURE.md` §一）。

---

## 一、BlueOS 平台能力调研结论

### 可用于 Agent 的核心 API

| 能力域 | BlueOS JS API | 用途 |
|--------|--------------|------|
| **AI 服务** | `@blueos.ai.nlp`、`@blueos.ai.vision`、`@blueos.ai.speech` | 翻译、图像识别、语音交互 |
| **通信** | `@blueos.network.fetch` | HTTP 请求（调用 LLM API） |
| **存储** | `@blueos.storage.localstorage`、`@blueos.storage.file` | 上下文持久化、文件读写 |
| **传感器** | `@blueos.hardware.sensor.sensor` | 佩戴检测、抬腕、计步等 |
| **健康** | `@blueos.health.health` | 心率、血氧、运动数据 |
| **通知** | `@blueos.app.notification.notificationManager` | Agent 消息推送 |
| **事件** | `@blueos.app.event.eventManager` | 系统事件（亮屏、充电等） |
| **设备互联** | HealthKit、RelayKit、ShareKit | 手表 ↔ 手机通信 |
| **后台** | manifest background features | 后台保活 |
| **硬件** | `@blueos.hardware.vibrator`、`@blueos.hardware.geolocation` | 振动反馈、定位 |
| **网络状态** | `@blueos.network.networkManager` | 连接状态监测 |

### 关键约束

- 后台运行需在 `manifest.json` 中声明 `background.features`
- 传感器/健康权限需在 `manifest.json` 的 `permissions` 中声明
- 应用沙箱目录不可越界
- 手表 LLM 推理通过 `@blueos.network.fetch` 调用远程 API

---

## 二、整体里程碑

```
Phase 1: BlueOS Agent 执行层 (当前)
  ├── 项目脚手架 + manifest 配置
  ├── Agent 主循环 (感知→决策→行动)
  ├── 工具注册与调度
  ├── 上下文管理 + 文件 I/O
  ├── 身份持久化 (直接在代码里实现)
  ├── 传感器/健康桥接
  └── LLM API 调用
       ↓
Phase 2: 事件驱动链路 (下一步)
  ├── 闸门求值器（读 common/models/gate-conditions.json）
  ├── agent-loop 增加 handleEvent 入口
  ├── sensor/health 回调 → 闸门 → agent-loop
  └── background.features 补齐
       ↓
Phase 3: BlueOS 展示层
  ├── 健康数据展示
  ├── Agent 状态展示
  ├── 快捷卡片 (Widget)
  └── 抬腕唤醒（作为展示触发，不是输入）
       ↓
```

> **不做对话输入页面。** 手表只被动接受调用，不提供用户输入界面——小圆屏无键盘是手表最弱模态，腕上打字是鸡肋。理由见 `ARCHITECTURE.md` §三。


---

## 三、Phase 1 — BlueOS Agent 执行层

### 改动范围

#### 4.1 项目脚手架 (`blueos/`)

> 用 BlueOS Studio 打开的是 `blueos/` 目录（不是 `pulse-agent/`，也不是 `blueos/src/`）。
> 所有源码放在 `blueos/src/` 下，因为 BlueOS Studio 要求源码在 `src/` 目录下。

**文件清单：**
- `blueos/src/manifest.json` — BlueOS 应用配置（含后台、权限声明）
- `blueos/src/app.ux` — 应用入口（初始化 Agent、注册后台服务）
- `blueos/src/pages/index/index.ux` — 首页入口页面
- `blueos/src/pages/index/index.js` — 首页逻辑
- `blueos/src/pages/index/index.css` — 首页样式
- `blueos/src/agent-core/` — Agent 执行层代码
- `blueos/src/platform/` — BlueOS 平台 API 封装
- `blueos/src/ui/` — 可复用 UI 组件

**manifest.json 关键配置：**
```json
{
  "package": "com.pulse.agent",
  "name": "Pulse Agent",
  "versionName": "0.1.0",
  "versionCode": 1,
  "config": {
    "logLevel": "trace",
    "background": {
      "features": [
        "blueos.communication.network.request",
        "blueos.hardware.geolocation"
      ]
    }
  },
  "permissions": [
    { "name": "watch.permission.READ_HEALTH_DATA" },
    { "name": "watch.permission.STEP_COUNTER" }
  ]
}
```

#### 4.2 Agent 主循环 (`blueos/src/agent-core/`)

**文件清单：**
- `blueos/src/agent-core/agent-loop.js` — Agent 主循环（核心引擎）
- `blueos/src/agent-core/tool-registry.js` — 工具注册与调度
- `blueos/src/agent-core/context-manager.js` — 上下文管理
- `blueos/src/agent-core/llm-client.js` — LLM API 调用封装

**Agent 主循环流程：**
```
1. Sense   — 感知输入（传感器事件、用户抬腕、健康告警）
2. Think   — 调用 LLM API 做意图分析/决策
3. Act     — 执行工具调用（写文件、发通知、振动等）
4. Observe — 观察工具执行结果
5. Loop    — 回到 1 或等待下一触发
```

**设计参考：** 参照 openclaw/hermes 的 agent-loop 模式。

**LLM API 调用：**
```javascript
import fetch from '@blueos.network.fetch'

class LLMClient {
  async chat(messages) {
    const resp = await fetch.fetch({
      url: this.endpoint,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 256
      })
    })
    return JSON.parse(resp.body)
  }
}
```

#### 4.3 工具注册与调度 (`blueos/src/agent-core/`)

**文件清单：**
- `blueos/src/agent-core/tool-registry.js`

**内置工具（第一期）：**
| 工具名 | 功能 | 实现方式 |
|--------|------|---------|
| `file_read` | 读取文件内容 | `@blueos.storage.file.readText` |
| `file_write` | 写入文件 | `@blueos.storage.file.writeText` |
| `notification_send` | 推送通知 | `@blueos.app.notification.notificationManager.publish` |
| `vibrate` | 振动反馈 | `@blueos.hardware.vibrator.vibrate` |
| `get_health_data` | 查询健康数据 | `@blueos.health.health.getRecentSamples` |
| `get_sensor_data` | 查询传感器数据 | `@blueos.hardware.sensor.sensor` |

#### 4.4 上下文管理 (`blueos/src/agent-core/`)

**文件清单：**
- `blueos/src/agent-core/context-manager.js`

**能力：**
- 最近 N 条消息的缓存（KV storage）
- Agent 状态的持久化（文件存储）
- 工具调用结果缓存
- 会话历史管理

#### 4.5 身份管理 (`blueos/src/agent-core/`)

**文件清单：**
- `blueos/src/agent-core/identity.js`

**职责：**
- 首次启动生成 root_id，持久化到 KV storage
- 后续启动从 KV storage 读取
- 提供 `getIdentity()` 供其他模块调用

#### 4.6 传感器/健康桥接 (`blueos/src/agent-core/`)

**文件清单：**
- `blueos/src/agent-core/sensor-bridge.js` — 传感器事件订阅
- `blueos/src/agent-core/health-bridge.js` — 健康数据采样

```javascript
// 传感器桥接
class SensorBridge {
  start() {
    sensor.subscribeOnBodyState({
      callback: (ret) => this.onBodyState(ret.value)
    })
    sensor.subscribeWristLift({
      callback: () => this.onWristLift()
    })
    sensor.subscribeStepCounter({
      callback: (ret) => this.onSteps(ret.steps)
    })
  }
}

// 健康桥接
class HealthBridge {
  start() {
    health.subscribeSample({
      dataType: health.DATA_TYPES.HEART_RATE,
      callback: (sample) => this.onHeartRate(sample.value)
    })
  }
}
```

#### 4.7 文件 I/O (`blueos/src/agent-core/`)

**文件清单：**
- `blueos/src/agent-core/file-manager.js`

**封装 `@blueos.storage.file` 的方法：**
- `read(path)` — 读文本文件
- `write(path, data)` — 写文本文件
- `append(path, data)` — 追加写
- `delete(path)` — 删除文件
- `list(dir)` — 列目录
- `exists(path)` — 判断存在

#### 4.8 平台封装层 (`blueos/src/platform/`)

**文件清单：**
- `blueos/src/platform/notification.js` — 通知 API 封装
- `blueos/src/platform/vibrator.js` — 振动反馈封装
- `blueos/src/platform/storage.js` — 存储封装（KV + File）

**原则：** 将 BlueOS 原生 API 封装成统一的内部接口，便于后续替换或适配其他平台。

---

## 五、Phase 1 验收清单

- [ ] `common/identity/root-id-spec.md` — root_id 规范
- [ ] `common/models/` — 数据模型文档
- [ ] `blueos/src/manifest.json` — 权限与后台配置
- [ ] `blueos/agent-core/identity.js` — root_id 生成与持久化
- [ ] `blueos/src/agent-core/agent-loop.js` — Agent 主循环（Sense→Think→Act）
- [ ] `blueos/src/agent-core/tool-registry.js` — 至少 3 个内置工具
- [ ] `blueos/src/agent-core/context-manager.js` — 上下文读写
- [ ] `blueos/src/agent-core/llm-client.js` — LLM API 调用
- [ ] `blueos/src/agent-core/sensor-bridge.js` — 佩戴/抬腕/计步订阅
- [ ] `blueos/src/agent-core/health-bridge.js` — 心率采样
- [ ] `blueos/src/agent-core/file-manager.js` — 文件操作
- [ ] `blueos/src/platform/notification.js` — 通知能力
- [ ] `blueos/src/platform/vibrator.js` — 振动能力
- [ ] `blueos/src/platform/storage.js` — 存储封装
- [ ] 手表端 `app.rpk` 可启动 Agent

---

## 六、不在本期做的事

| 事项 | 原因 |
|------|------|
| 快捷卡片 (Widget) | 需 Agent 核心稳定后再做 |
| AI 视觉/语音能力 | 非 MVP 必需 |
| 端侧 LLM | 策略上不做 |
| UI 动画/表盘 | MVP 聚焦功能 |
| OpenClaw/Hermes 代码分析 | 需拿到代码后并行做 |

---

## 七、风险与应对

| 风险 | 应对 |
|------|------|
| BlueOS fetch API 对 LLM 服务端延迟高 | 降低调用频率 + 缓存 + 轻量化模型 |
| BlueOS Studio 调试能力有限 | console.log + 远程日志方案 |
| OpenClaw/Hermes 执行层模式未确认 | 启动后并行调研，调整 agent-loop 设计 |
| BlueOS 后台保活策略变更 | manifest 声明 + 定期唤醒 |

---

## 八、进度

| 步骤 | 状态 |
|------|------|
| 项目脚手架 + manifest | completed |
| Agent 主循环 (agent-loop) | coding done, not verified |
| 工具注册与调度 (tool-registry) | coding done, not verified |
| 上下文管理 (context-manager) | coding done, not verified |
| LLM API 调用 (llm-client) | coding done, not verified |
| 身份管理 (identity) | coding done, not verified |
| 传感器桥接 (sensor-bridge) | coding done, not verified |
| 健康桥接 (health-bridge) | coding done, not verified |
| 文件 I/O (file-manager) | coding done, not verified |
| 平台封装 (notification/vibrator/storage) | coding done, not verified |
| 闸门条件契约 (common/models/) | completed |
| 已知缺陷修复（runtime 作用域、vibrate 参数、死文件） | completed 2026-07-26 |
| **端到端验证 — 真机启动 app.rpk** | **待验证（阻塞项已清）** |
