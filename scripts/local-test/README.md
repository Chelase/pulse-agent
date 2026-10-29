# local-test — agent-core 的本地测试套件

## 为什么存在

`blueos/src` 的代码跑在 BlueOS 上，依赖 `@blueos.*` 平台模块和 `.ux` 页面，Node 里无法直接加载。
而 Step 0 的真机验证是唯一硬阻塞项——**在拿到真机之前，这是唯一能验证 agent-core 逻辑的手段**。

2026-09-14 实施 MVP 时，这套桩第一次跑就抓到一个真实缺陷：闸门求值器用真假值判断
`_overSince`，时间戳为 0 时会被反复重置，导致 `sustainedSeconds` 永远累计不满。

## 跑法

```bash
node scripts/local-test/run.mjs
```

运行器先镜像源码，再逐个测试文件用独立进程执行（`AgentRuntime` 是模块级单例，同进程会互相污染）。

## 覆盖范围

| 文件 | 覆盖 |
|------|------|
| `agent-loop.test.mjs` | 多步工具循环：工具串联、结果回填、fenced 解析、达上限强制收口、工具抛错降级、未配置不联网 |
| `gate.test.mjs` | 闸门：持续时长、静默期、越限重置、布尔比较、单次触发；事件路径：提醒/不打扰/兜底/不写对话历史 |
| `skills.test.mjs` | frontmatter 解析、加载与首次落盘、`internal://files` 覆盖、常驻与按命中注入、无注册表降级 |
| `runtime.test.mjs` | 端到端集成：九步启动 → 采样 → 闸门 → LLM → 通知 + 振动；静默期、外部任务入口、stop 后不再处理 |
| `llm-config-cli.test.mjs` | CLI/Web 配置：本地文件、脱敏 show、Web GET/POST、留空 Key 保留 |
| `llm-config.test.mjs` | BlueOS LLM 客户端：供应商、endpoint、API Key、模型与请求参数 |
| `harness-layer.test.mjs` | harness 分层：工具拒绝/异常结构化、事件禁写工具、拒绝回填、系统提示分节、工具输出截断、环境快照、上下文体积上限 |
| `startup.test.mjs` | 启动链韧性：平台定时任务不回调时仍能跑完、关键步骤失败可读且引导照常起来 |

## 它是怎么工作的

`build.mjs` 把 `blueos/src` 镜像成 Node 能加载的 `.mjs` 树，解决三个问题：

1. `blueos/package.json` 没有 `"type": "module"`，`.js` 会被 Node 当 CJS，而源码是 ESM。
2. 源码里的相对 import 不带扩展名（`from './llm-client'`），ESM 要求带扩展名。
3. `@blueos.*` 是 BlueOS 专有模块，Node 里不存在。

镜像产物在 `.build/`（已 gitignore，勿手改）。`@blueos.*` 会被换成 `stubs.mjs` 里的桩。

## 桩能做什么

`stubs.mjs` 提供 KV、文件、HTTP、传感器、健康、通知、振动的内存实现，并暴露可观测状态：

```js
import { memory, setKV, fetchStub, healthStub, sensorStub } from './stubs.mjs'

memory.reset()                            // 清空全部桩状态
setKV('llm_config', { ... })              // 等价于「手表上已配置过」
fetchStub.respond('/chat/completions', fn) // 按 URL 编排响应；未编排的打真实 HTTP
healthStub.emitHeartRate(130)             // 触发一次心率采样
sensorStub.emitOnBody(false)              // 触发一次佩戴状态变化

memory.notifications                      // 断言发过什么通知
memory.vibrations                         // 断言振动过几次
memory.files                              // 断言文件写到了哪
```

## 配置文件

CLI/Web 默认把配置写入 `config/llm-config.local.json`。该文件包含 API Key，已被 `.gitignore` 忽略。
测试使用独立临时文件并在结束时删除，不会污染默认配置。

## 限制

- **只验证 agent-core 的逻辑**，不验证 BlueOS 平台 API 的真实行为。桩是「按契约假设」写的，
  真机行为与假设不符时，这里全绿也说明不了什么。
- 不加载 `.ux` 页面，UI 相关代码不在覆盖范围。
- 不覆盖 LLM 的真实输出质量，只覆盖「模型给了某种输出，Agent 怎么处理」。

## 新增一个测试

在 `scripts/local-test/` 下建 `xxx.test.mjs`，从 `./.build/...` 导入被测源码，
用 `harness.mjs` 的 `check` / `summary` 写断言，运行器会自动发现。

> 相关：`.agent-rules/mechanisms/blueos-agent-runtime.md`（启动链路）、
> `dev-plans/mvp-core-capabilities-plan.md`（真机验证仍是未清阻塞项）。
