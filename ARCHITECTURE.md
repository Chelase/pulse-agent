# Pulse Agent 架构方案

## 一、平台定位：只做 BlueOS

本项目的目标平台是 **vivo 蓝河 BlueOS**，也是唯一实现平台。

选择的根据：手表上的第三方 Agent 生态仍是空位，而蓝河提供争取系统级入口的可能——默认助手位、侧键/表冠唤起、表盘直接进入可争取，系统级上下文访问可申请权限。手表 Agent 的核心价值在于腕上独有的被动感知与低打扰输出，这是手机等设备替代不了的位置。

其他手表平台的覆盖不属于本仓库范围。

---

## 二、两层职责边界

`common/` 是手表 Agent 的**对外契约层**：身份、能力、数据模型与协议接口。Agent 本体独立完整，这些契约不是运行的前提，而是让外部生态能够发现并接入它。

### Layer 1 — `common/`（对外契约层）

**原则：只含契约、模型、能力声明，不含可执行代码。**

```
common/
├── protocol/               手表 Agent ↔ 外部生态的接口契约（预留）
├── identity/               Agent 身份
│   └── identity-schema.json  root_id 持久化格式
├── models/                 共享数据模型
│   ├── gate-conditions.schema.json  闸门条件格式定义
│   └── gate-conditions.json         默认闸门条件集
├── capabilities/           能力声明
│   └── watch-capabilities.json  手表 Agent 向外部生态注册的能力清单
└── tests/                  契约一致性测试
```

**这一层面向谁？** 面向任何想接入手表 Agent 的外部系统。手表 Agent 声明的能力、上报的数据形状、使用的身份格式，都要能被外部系统理解。

**产出物：** `.md` 文档、`.yaml` / `.json` 契约文件、平台无关的测试用例。

---

### Layer 2 — `blueos/`（BlueOS 实现层）

**原则：唯一的可执行实现。**

```
blueos/
├── src/
│   ├── manifest.json       应用配置（权限、后台 features）
│   ├── app.ux              应用入口
│   ├── app.ux              应用入口（无 UI 执行层）
│   ├── agent-core/         Agent 执行层
│   │   ├── runtime.js          单例装配 + 启动序列
│   │   ├── agent-loop.js       主循环
│   │   ├── tool-registry.js    工具注册与调度
│   │   ├── context-manager.js  上下文管理
│   │   ├── llm-client.js       LLM API 调用
│   │   ├── identity.js         root_id 生成与持久化
│   │   ├── sensor-bridge.js    传感器订阅
│   │   ├── health-bridge.js    健康数据订阅
│   │   └── file-manager.js     文件 I/O
│   └── platform/           BlueOS 原生 API 封装
│       ├── storage.js          KV + 文件
│       ├── notification.js     通知
│       └── vibrator.js         振动
└── package.json
```

> 用 BlueOS Studio 打开的是 `blueos/` 目录，源码必须在 `blueos/src/` 下。

运行时链路详见 `.agent-rules/mechanisms/blueos-agent-runtime.md`。

---

### Scripts — 构建脚本

```
scripts/
├── build-blueos.sh     构建 RPK 包
└── deploy.sh           部署到手表
```

---

## 三、Agent 的四步闭环

这是本项目的核心形态，也是 `common/` 里真正该沉淀的契约：

```
1. 感知   别的设备拿不到的东西——是不是本人、醒着没、平静还是紧张、动没动
2. 闸门   本地廉价规则判断什么值得进一步处理，不为每个心率样本烧电
3. 思考   跨过闸门的事件才进入 LLM 判断
4. 输出   落回腕上——振动提醒，不需要用户在手表上操作
```

### 手表不提供 UI

**手表端不提供页面、配置面板或聊天输入；BlueOS 只承载执行层 Agent。**

理由：手表的交互输入是它最弱的模态——466px 圆屏、无键盘、语音在公共场合不便。在手表上打字让 Agent 干活是鸡肋功能，用户会去用手机。手表的价值全在**被动感知**和**低带宽输出**这两端。

因此：
- `blueos/src/` 只有 `app.ux` 执行入口，没有 `pages/`、`ui/` 或状态展示页面
- 模型供应商、请求地址、API Key、模型等配置统一在仓库 CLI/Web 控制面完成，不放到手表
- Agent 的触发来源是**传感器事件**（经闸门）和**外部调用**（外部生态 / 其他设备），不是用户在腕上问话
- `agent-loop.js` 的 `handleUserInput` 保留为**程序化入口**，供外部生态调用使用

### 为什么必须有第 2 步

阈值规则能做「心率 > 120 就告警」，做不到上下文融合：心率 130、步频为零、不在运动模式、周三下午三点、日历上写着「绩效评审」→ 这是压力不是运动。同样的 130，如果前 90 秒步频在爬升，那是爬楼。区分这两者需要判断，这是 LLM 的活。

但**不能每个样本都调 LLM**，功耗和延迟撑不住。规则不是被 LLM 替代，是**给 LLM 把门**。

### 闸门契约是声明式的

闸门条件在 `common/models/` 里表达成数据（数据类型 + 比较符 + 阈值 + 持续时长 + 静默期），而不是命令式代码。声明式条件能被生态里其他设备读懂、能改配置而不重新打包、能翻译成平台原生的低功耗阈值检测；命令式代码三条都做不到。

- 契约定义：`common/models/gate-conditions.schema.json`
- 默认条件集：`common/models/gate-conditions.json`
- 设计说明：`common/models/README.md`

**闸门只做单信号廉价比较，不做上下文融合。** 「心率 130 + 步频为零 + 日历上写着绩效评审」这种融合是 LLM 的活。闸门只把「心率 130 且持续 10 分钟」捞出来。这也是 schema 里没有 AND / OR 组合条件的原因——一旦开始组合，就是在用错误的层做 LLM 的工作。

### LLM 调用路径：直连为主，委派为预留降级

| | 主路径（当前实现） | 降级路径（预留） |
|---|---|---|
| 形态 | 手表直接调 LLM API（`llm-client.js`） | 经手机转发（需 `deviceRpcSdk` + 手机端 App） |
| 触发 | 默认 | 仅无网络 / 电量极低 |
| 状态 | **已实现** | **预留，本期不做** |

选直连为主路径的决定性理由是工作量：降级路径需要额外写一个手机端 App 当 RPC 对端，而手表侧至今没在真机上跑通。约束条件见「六、关键决策记录」的 LLM 调用路径一行。

### Agent 不能是常驻循环

BlueOS 的后台运行受 `manifest.json` 的 `background.features` 约束。**这个 Agent 只能是「被事件唤醒的处理器」，不能是「一直跑着的循环」。**

> ⚠️ 当前 `blueos/src/agent-core/agent-loop.js` 的注释写着 Sense → Think → Act → Observe，但 Sense 那一环没接上：`sensor-bridge.js` 和 `health-bridge.js` 的回调只更新内存 state，没有任何路径通向 `agentLoop`，也没有闸门求值器。也就是说现在的 Agent 永远不会被传感器唤醒。这是与本节架构的已知偏差，见 `dev-plans/mvp-core-capabilities-plan.md` Step 2。

### 投射层：外部数据的通用展示面

**任何接入方都可以把自己的设备数据「投射」到手表的输出通道。手表 Agent 不提供自研 UI，只负责接收并交给 BlueOS 系统级显示/通知能力。**

- **通道无关**：投射来源可以是手机伴侣 App（穿戴业务 Kit / BLE），也可以是任何外部接入系统经标准协议推送。手表端不关心通道，只认统一的投射卡片格式。
- **数据自描述**：投射内容是一张卡片（来源 + 优先级 + 有效期 + 渲染块列表）。渲染块是一组有限原语——文本、图片、进度、同步滚动文本（歌词/字幕）、列表、键值对；未知 block 类型优雅降级。
- **Agent 的角色最小化**：主链路是 投射接收器 → 系统级输出适配，**不过 LLM**（省电、零延迟）。
- **输出仲裁**：投射卡、系统通知、Agent 提醒共用系统输出通道，按优先级仲裁；投射内容必须做尺寸与频率限制。

> 投射层是 MVP 后能力（依赖系统级输出适配与接入通道，不恢复手表自研 UI），契约已预留：能力声明 `common/capabilities/watch-capabilities.json` 的 `projection_display`。

---

## 四、协作流程

### 新增一个能力

```
1. common/capabilities/watch-capabilities.json
   └── 添加能力声明（供外部生态发现）

2. blueos/src/platform/
   └── 封装 BlueOS 原生 API

3. blueos/src/agent-core/tool-registry.js
   └── 注册为 Agent 可调用的工具

4. blueos/src/manifest.json
   └── 声明对应的 features / permissions（漏了会在真机上 import 即失败）
```


---


---

## 五、关键决策记录

| 决策 | 方案 | 理由 |
|------|------|------|
| 目标平台 | 只做 vivo 蓝河 BlueOS | 蓝河提供可争取的系统级 Agent 入口，手表第三方 Agent 生态仍是空位 |
| 其他手表平台覆盖 | 由外部生态接入层解决 | 本仓库只做一个平台的完整 Agent，不复刻其他平台实现 |
| 独立运行 | Agent 脱离任何生态完整可运行，外部接入为可选增强 | Agent 本体是完整 Agent；生态连接由外部实现 |
| `common/` 定位 | 对外契约层，外部生态是使用方之一 | 契约面向外部接入方；Agent 本体不依赖任何生态 |
| Agent 形态 | 事件唤醒，非常驻循环 | 后台受 `background.features` 约束 |
| 交互输入 | 手表不做，只被动接受调用 | 小圆屏 + 无键盘是手表最弱模态，腕上打字是鸡肋，用户会去用手机 |
| 外部数据展示 | 通用投射层，不写死场景 | 任何接入方投射自描述卡片，Agent 只交给系统级输出适配；不恢复手表自研 UI |
| 闸门实现 | 本地廉价规则先筛，LLM 只处理筛出来的 | 每样本调 LLM 的功耗和延迟撑不住 |
| 闸门契约 | 声明式数据，非命令式代码 | 声明式条件才能被其他设备读懂、改配置不重新打包、翻译成硬件阈值检测 |
| 闸门表达力 | 单信号比较，不支持 AND/OR | 上下文融合是 LLM 的活，组合条件是用错误的层做 LLM 的工作 |
| LLM 调用路径 | 直连为主，委派预留为降级 | 委派需额外写手机端 App，手表侧尚未真机跑通 |
| 身份系统 | root_id 机制 | 统一身份标识（外部接入时复用） |
| 能力注册 | 本地维护能力列表 | 供外部生态发现，不自建注册中心 |
| 健康解读边界 | 只出描述性提示 | 「持续 20 分钟心率偏高且无活动」可以说，「你可能有心律不齐」不可以——那是医疗建议 |

> 更新时间：2026-10-26
