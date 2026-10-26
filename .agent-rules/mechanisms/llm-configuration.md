# LLM 自定义供应商配置

## 结论

模型配置属于仓库控制面：通过 CLI 或本地 Web 页面保存 OpenAI-compatible LLM 配置，再用 CLI 同步到 BlueOS 模拟器文件目录；手表端不提供配置 UI。

## 涉及对象

| 对象 | 角色 |
| --- | --- |
| `scripts/llm-config.js` | CLI：show / set / clear / sync-simulator |
| `scripts/setup-server/server.js` | 设备码 H5 配置服务（手表主动拉取），默认端口 8790；原 8787 本地 Web 面板已删除 |
| `scripts/llm-config-store.js` | 本地配置读写、字段归一化、校验、脱敏 |
| `config/llm-config.local.json` | 本机配置文件，含 API Key，已被 `.gitignore` 忽略 |
| `blueos/src/agent-core/llm-client.js` | BlueOS 侧读取 KV 或 `internal://files/agent/llm-config.json`，组装 LLM 请求 |
| `blueos/src/platform/storage.js` | BlueOS KV / internal 文件读写 |
| `scripts/local-test/llm-config.test.mjs` | LLM 客户端配置与请求回归 |
| `scripts/local-test/llm-config-cli.test.mjs` | CLI/Web 配置与模拟器同步回归 |

## 运行链路

```
CLI / Web 控制面
  ├─ set / Web POST /api/config
  │    └─ read current → normalize + validate → 写 config/llm-config.local.json
  ├─ show / Web GET /api/config
  │    └─ 只返回 endpoint / model / apiMode / hasApiKey / 脱敏预览
  └─ sync-simulator
       └─ 复制本地配置 → <模拟器 sdcard>/internal/com.pulse.agent/files/agent/llm-config.json

BlueOS Agent 启动
  └─ LLMClient.init()
       ├─ 读 internal://files/agent/llm-config.json（存在且有效时优先）
       └─ 否则读 KV llm_config（兼容原程序化配置）
            ├─ endpoint + apiKey 都有 → configured=true
            └─ 缺 apiKey → configured=false；运行时继续启动，但不发 LLM 请求

LLMClient.chat(messages)
  └─ POST endpoint
       { Authorization: Bearer apiKey,
         model, messages, temperature }
```

## 使用点

- `node scripts/setup-server/server.js --host 0.0.0.0`：设备码 H5，启动后自动打开本机浏览器。
- `node scripts/llm-config.js set ...`：CLI 直接保存配置。
- `node scripts/llm-config.js sync-simulator`：把配置复制到 BlueOS Studio 默认模拟器目录；可用 `--root` 指定其他目录。
- `AgentRuntime.start()` 的 `agentLoop.init`：加载 BlueOS 侧配置。
- `AgentLoop.handleUserInput` / `handleEvent`：通过 `llm.isConfigured()` 判断是否允许请求。
- `scripts/llm-config.js`：把本地控制面配置同步到模拟器或设备可读取的 internal 文件。

## 修改点

| 要做什么 | 改哪里 | 怎么改 |
| --- | --- | --- |
| 增加配置字段 | `llm-config-store.js` + H5 表单 + `llm-client.js` `_normalizeConfig` | 同步本地保存、H5 表单、BlueOS 加载与请求组装；旧配置必须可读 |
| 增加 CLI 命令 | `llm-config.js` | 命令只操作控制面文件，不把配置逻辑复制到 BlueOS 页面 |
| 支持非 OpenAI 协议 | `agent-core/llm-adapters.js` + `common/models/api-modes.json` | 加一个模式适配器 + 一条契约清单；端点末尾路径由 endpointSuffix 在保存时校验 |
| 修改模拟器同步位置 | `llm-config.js` `defaultSimulatorRoot()` | 默认适配 Windows BlueOS Studio，也可始终用 `--root` 显式指定 |

## 关键约束

1. **手表没有 UI。** 模型配置、状态查看和连接测试都在 CLI/Web 控制面，BlueOS 只承载执行层。
2. `apiMode` 决定请求形状（openai-chat / anthropic-messages / openai-responses），清单唯一来源是 `common/models/api-modes.json`；Bedrock Converse 需 SigV4 签名，不支持。
3. endpoint 与 apiKey 都存在才算 configured；未配置不发网络请求，也不阻塞 runtime 启动。
4. API Key 只进入本地配置文件与请求 Authorization；Web/CLI 输出脱敏，日志不得打印原文。
5. `sync-simulator` 生成的文件名必须是 `llm-config.json`，对应 BlueOS 的 `Storage.readFile('llm-config.json')`。
6. internal 文件配置优先于旧 KV 配置，便于 CLI/Web 管理；没有同步文件时仍兼容 KV `llm_config`。

## 维护方式

- **启动设备码 H5**：`node scripts/setup-server/server.js --host 0.0.0.0 --port 8790`，手表要访问需 --host 0.0.0.0；本机浏览器自动打开。
- **CLI 配置**：`node scripts/llm-config.js set --api-mode anthropic-messages --endpoint https://api.anthropic.com/v1/messages --model <模型> --api-key-stdin < api-key.txt`；查看用 `show`。
- **同步模拟器**：默认执行 `node scripts/llm-config.js sync-simulator`；路径不匹配时使用 `--root <.../files/agent>`。
- **排查「Agent 未就绪」**：手表无状态页面，直接看 runtime 启动失败步骤；LLM 未配置只表示 configured=false，不是启动失败。
- **排查「连接失败」**：检查完整 `/chat/completions` endpoint、API Key、模拟器网络；不要把 Key 写入日志。连接测试探测超时默认 30 秒（`PULSE_SETUP_PROBE_TIMEOUT_MS` 可调），超时报错形如「连接测试超过 N 秒无响应」，代表远端在窗口内没回话而非配置被拒。
- **本地验证**：运行 `node scripts/local-test/run.mjs`，覆盖 BlueOS 客户端、CLI、Web、脱敏和同步。

> **生产路径（草案）**：终端用户首启配置见 phone-first-boot-config.md（设备码 + 系统浏览器 H5，无手机 App）。