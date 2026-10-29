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

### 引导地址（真机必须构建期带入）

LLM 未配置时手表屏（`pages/index`）出二维码/设备码，指向电脑上的 Setup 服务。地址按下面顺序取：

1. KV `setup_config.baseUrl`
2. `internal://files/agent/setup-config.json`
3. 构建期默认 `assets/runtime-config.js` 的 `setupBaseUrl`

前两处只有 `sync-simulator` 能写到**模拟器**目录，真机没有写入通道——真机必须把 `runtime-config.js` 里的 `setupBaseUrl` 改成电脑局域网 IP（如 `http://192.168.1.20:8790`）再重新打包安装，否则首页会停在「缺少引导地址」。

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

- `manifest.json` — 应用配置（`router.entry` 指向 `pages/index`）
- `app.ux` — 执行入口，承载 `onCreate` 与后台心跳方法 `agentTick`
- `pages/index/` — 首页 = 首启配置面板（设备码/二维码/启动步骤）
- `agent-core/` — Agent 执行层（含闸门求值器、skill 注册表、设备码引导）
- `platform/` — BlueOS API 封装
- `assets/skills/` — skill 原文与生成的内嵌模块
- `assets/runtime-config.js` — 构建期运行配置（引导地址）

手表端不做输入 UI；`pages/index` 只展示状态与二维码，不承载表单。
