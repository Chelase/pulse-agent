# BlueOS Watch Agent

## 运行前配置

LLM 需要配置后才能执行思考与工具调用。**手表端没有 UI，配置统一在仓库 CLI 或本地 Web 配置服务完成。**

程序化配置入口（BlueOS 运行时仍通过 KV 读取）：

```js
import { AgentRuntime } from './agent-core/runtime'
const runtime = AgentRuntime.getInstance()
await runtime.agentLoop.llm.setConfig({
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  apiKey: 'your-api-key',
  model: 'deepseek-chat',
})
```

开发时推荐使用仓库 CLI/Web：

```bash
node scripts/setup-server/server.js --host 0.0.0.0
node scripts/llm-config.js sync-simulator
```

`sync-simulator` 会把本地配置复制成模拟器 `internal://files/agent/llm-config.json`；BlueOS 启动时优先读取这个文件，没有该文件时兼容 KV `llm_config`。`provider` 只是供应商标识；请求协议当前按 OpenAI-compatible Chat Completions 发送：Bearer API Key、`model`、`messages`、`temperature`。

未配置 LLM 时，运行时仍可启动、传感器仍可采样，但 Agent 不会调用网络。

## 可选配置

以下三项都不配也能跑，配了才生效。


### 闸门条件（改阈值不重新打包）

默认条件集内嵌在 `agent-core/gate-evaluator.js`，内容与 `common/models/gate-conditions.json` 一致。
要覆盖，把整份条件集写到手表（存在即整体替换内置集）：

```js
await Storage.writeFile('gate-conditions.json', JSON.stringify({
  version: '0.1.0',
  conditions: [ /* 按 common/models/gate-conditions.schema.json 写 */ ]
}))
```

### skill（改步骤不重新打包）

内置 skill 首次启动会落盘到 `internal://files/agent/skills/<name>/SKILL.md`，
覆盖同名文件即生效。格式约定见 `common/skills/README.md`。

改仓库里的 `assets/skills/**/SKILL.md` 之后，**必须**重跑生成脚本，否则运行时仍用旧的内嵌副本：

```bash
node scripts/sync-skills.js
```

## 构建

使用 BlueOS Studio 打开 `blueos/` 目录，构建并生成 `app.rpk`。

## 目录结构

- `manifest.json` — 应用配置（无 router/page）
- `app.ux` — 无 UI 的执行入口
- `agent-core/` — Agent 执行层（含闸门求值器、skill 注册表）
- `platform/` — BlueOS API 封装
- `assets/skills/` — skill 原文与生成的内嵌模块

手表端没有 `pages/`、`ui/` 或状态展示页面。
