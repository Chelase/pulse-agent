# 事件闸门链路

## 结论

传感器/健康采样先经 `GateEvaluator` 做单信号廉价比较，只有跨过闸门的事件才唤醒 `AgentLoop.handleEvent` 并调用 LLM；未跨门的采样在本地被丢弃，不产生任何 LLM 调用。

## 涉及对象

| 对象 | 角色 |
| --- | --- |
| `blueos/src/agent-core/gate-evaluator.js` | 闸门求值器，条件集与静默期状态持有者 |
| `common/models/gate-conditions.schema.json` | 闸门条件的格式契约（字段与枚举来源） |
| `common/models/gate-conditions.json` | 默认条件集；与 `gate-evaluator.js` 的 `DEFAULT_CONDITIONS` 一致 |
| `blueos/src/agent-core/sensor-bridge.js` | 佩戴/抬腕/计步订阅，回调后 `_emit(dataType, value)` |
| `blueos/src/agent-core/health-bridge.js` | 心率订阅，回调后 `_emit('heart_rate', value)` |
| `blueos/src/agent-core/runtime.js` | 装配闸门与桥接、注入 `onSample`、实现 `_onSample` |
| `blueos/src/agent-core/agent-loop.js` | `handleEvent(event)` 事件入口与事件上下文 |
| `blueos/src/manifest.json` | `background.features` 声明传感器/健康/通知/振动 |
| `internal://files/agent/gate-conditions.json` | 可选覆盖条件集（存在即整体替换内置集） |

## 运行链路

```
sensor.subscribeOnBodyState / subscribeStepCounter / subscribeWristLift
health.subscribeSample(HEART_RATE)
  └─ 回调更新内存 state（保持原有行为）
  └─ bridge._emit(dataType, value)        同步，无 IO
       └─ runtime._onSample(dataType, value)      ready=false 直接返回
            ├─ gateEvaluator.evaluate(dataType, value)   同步、廉价
            │    ├─ 未跨门 → 返回 null → 丢弃，不烧 LLM
            │    └─ 跨门 → 返回条件对象
            ├─ _eventBusy 为真 → 丢弃本次事件（避免并发 LLM 调用）
            └─ _eventBusy = true
                 └─ agentLoop.handleEvent(event)
                      ├─ 独立轻量上下文：system(EVENT_SYSTEM_PROMPT + 工具清单) + 事件载荷
                      ├─ _runLoop(messages, stepHardLimit)   ← 事件与对话共用防失控硬顶（默认 50，不封顶语义）
                      │    └─ 中间消息只留在本地数组，不写对话历史
                      ├─ _parseEventVerdict(raw) → { notify, vibrate }
                      └─ _emitVerdict → notification_send（notify 非空时）+ vibrate（vibrate 为真时）
                 └─ _eventBusy = false

runtime.getState() → lastEvent 反映最近一次「闸门: <conditionId>」或事件结论
```

闸门求值语义（`evaluate`）：

```
for 每条 condition:
  dataType 不匹配 → 跳过
  未越限        → overSince[id] = null，继续
  越限          → overSince[id] 首次记录为 now
                  (now - overSince[id]) < sustainedSeconds → 继续
                  冷却未过 (now - lastFired[id] < cooldownSeconds) → 继续
                  命中 → lastFired[id] = now，overSince[id] = null，返回该条件
```

## 使用点

- `runtime.js` 构造：`new GateEvaluator()`，并把 `(type, value) => this._onSample(type, value)` 注入两个 bridge。
- `runtime.js` `start()` 的 `gateEvaluator.init` 步骤：尝试读取覆盖条件集，失败保持内置。
- `sensor-bridge.js` / `health-bridge.js` 的订阅回调：三处 `_emit`（`on_body` / `step_count` / `wrist_lift`）与一处 `_emit('heart_rate')`。
- `agent-loop.js` `handleEvent`：被 `runtime._onSample` 调用，无其他调用方。

## 修改点

| 要做什么 | 改哪里 | 怎么改 |
| --- | --- | --- |
| 新增闸门条件 | `common/models/gate-conditions.json` + `gate-evaluator.js` 的 `DEFAULT_CONDITIONS` | 两处同步加一条，`cooldownSeconds` 必填；只做单信号比较，不加 AND/OR |
| 改阈值不重新打包 | 手表 `internal://files/agent/gate-conditions.json` | 按 schema 写整份条件集，重启后生效 |
| 接入新的数据源 | 对应 bridge 的回调 + `_emit` | 采样后调用 `_emit(dataType, value)`，`dataType` 必须是 schema 枚举值 |
| 调整事件 LLM 预算 | `agent-loop.js` 的 `stepHardLimit` | 事件与对话共用防失控硬顶（默认 50）；调大直接增加每次事件的 LLM 调用数 |
| 调整事件产出形式 | `agent-loop.js` 的 `EVENT_SYSTEM_PROMPT` 与 `_emitVerdict` | 输出协议与落地动作要一起改 |
| 新增后台保活项 | `blueos/src/manifest.json` 的 `background.features` | 与顶层 `features` 名称保持一致 |

## 关键约束

1. 闸门只做单信号比较。上下文融合（心率 + 步频 + 日历）是 LLM 的活，不要往条件里加组合逻辑。
2. `cooldownSeconds` 是必填项。缺了它，持续偏高的心率会在每个采样点都触发一次，把 LLM 调用打爆。
3. `_overSince` / `_lastFired` 的判断必须用显式 `undefined` / `null` 比较，不能用真假值——时间戳 0 是合法值。
4. `handleEvent` 不写对话历史。事件上下文是临时的，只有 `handleUserInput` 才落 `ContextManager`。
5. `_eventBusy` 期间到达的事件被丢弃而不是排队。宁可漏一次提醒，也不并发调用 LLM。
6. 闸门状态只在内存，进程重启归零。重启后 `sustainedSeconds` 需重新累计。

## 维护方式

- **新增数据源**：先在 `platform/` 或对应 bridge 封装原生 API，回调里 `_emit(dataType, value)`，`dataType` 对齐 `gate-conditions.schema.json` 的枚举。
- **排查「事件不触发」**：依次看日志 `[HealthBridge] heartRate:` / `[SensorBridge] onBodyState:`（采样是否到达）、`[Runtime] gate passed:`（闸门是否放行）、`[AgentLoop] step<N> tool=`（LLM 是否被调用）。三段都无输出说明采样没到；有采样无 `gate passed` 说明条件未满足或仍在冷却期。
- **排查「重复触发」**：检查对应条件的 `cooldownSeconds` 是否为 0 或过小；再看 `_eventBusy` 丢弃日志是否在刷。
- **验证**：真机制造持续高心率（或注入测试事件），确认 `gate passed → LLM → 通知/振动` 完整链路，且冷却期内不重复。
- **未接通的数据源**：`blood_oxygen`（health-bridge 只订阅心率，`spo2` 字段无写入）与 `battery_level`（无电量桥接）当前没有采样来源，对应条件不会触发。

> 更新时间：2026-09-14
