# 生产首启配置（设备码 + 浏览器 H5）

> **状态：目标态草案（尚未落地）**。硬约束：只发布手表 Agent，**不提供手机伴侣 App**。研发现状仍见 llm-configuration.md（开发机 CLI/Web）。

## 结论

手表 LLM 未配置时，展示**短设备码**（或等价扫码信息）；用户用手机**系统浏览器**打开傻瓜 H5，输入设备码并完成供应商配置；轻量 setup 服务把配置交给已联网的手表，写入 llm-config.json 后**热加载**。全程**不依赖外部生态、不依赖手机 App、不自研 BLE**。

## 涉及对象

| 对象 | 角色 |
| --- | --- |
| 手表引导（建议 config-onboarding.js） | configured=false 时申请/展示设备码；轮询或收取配置；落盘并热加载 |
| 系统通知 / 日志可读提示 | 提示用户打开 H5 并输入码（表上无配置表单；允许短码展示或通知文案） |
| 傻瓜 H5 面板 | 系统浏览器打开；预设供应商 + API Key + 测连通；高级项折叠 |
| Setup 服务（轻量，新建） | 签发设备码、绑定会话、接收面板提交、向手表下发配置（或手表拉取） |
| llm-client.js + storage.js | 消费同一份 llm-config.json；热加载后 configured=true |
| 开发机 scripts/llm-config.js | 仅研发；与生产首启分离 |

## 运行链路

`
手表启动 → LLMClient.init() → configured=false
  └─ onboarding.start()
       ├─ 向 Setup 申请 device_code（绑定 device_id / root_id）
       ├─ 展示短码（通知文案 / 只读状态）+ 可选 setup URL
       └─ 开始拉取：GET /setup/session/{code}/config 或等价长轮询

用户手机系统浏览器打开 H5（书签/说明书/通知里的 URL）
  ├─ 输入设备码（或扫码带上 code）
  ├─ 选预设供应商 + 粘贴 API Key（高级：endpoint/model）
  ├─ 「测试连接」在【浏览器/Setup 侧】直连供应商，成功才允许提交
  └─ POST 配置到 Setup（TLS；短期绑定；成功后码作废）

手表拉到配置
  └─ normalize + validate（对齐 llm-config-store 规则）
       ├─ 写入 llm-config.json
       ├─ LLMClient 热加载 → configured=true
       └─ 停止 onboarding 轮询

之后事件/任务路径照常直连 LLM；脱离任何生态也可完整运行
`

## 使用点

- 
untime.start() / LLMClient.init()：未配置触发 onboarding，**不阻塞** runtime 启动。
- 用户主动重配：再次进入未配置态或「重新绑定」入口（实现计划定交互）。
- Key 失效：回到 configured=false 或等价，可重新走设备码。
- **不**经 BlueXlink 伴侣 App；官方互联若未来有 App，仅作可选增强，不是前提。
- **不**作为外部生态代管任务；代管配置若做，另开机制且不得取代本主路径。

## 修改点

| 要做什么 | 改哪里 | 怎么改 |
| --- | --- | --- |
| 改 H5 文案/预设供应商 | H5 + Setup 预设表 | 与 llm-client 归一化字段一致 |
| 改码有效期/重试 | Setup + 手表 onboarding | 过期重新申请；防暴力猜码 |
| 改下发方式 | Setup ↔ 手表 | 手表拉或服务推，契约单处定义 |
| 改落盘格式 | storage + llm-client | 必须仍能被现有 init 直接消费 |
| 研发排障 | scripts/llm-config.js | 保持；标明非生产路径 |

## 关键约束

1. **无手机 App。** 生产用户只使用系统浏览器 + 手表 Agent。
2. **独立于外部生态。** 无中枢也能完成首启并直连 LLM。
3. **手表无配置表单。** 允许展示短码/URL 提示；不恢复完整设置页。
4. **落盘与现加载路径统一。** 只认 llm-config.json（及现有 KV 兼容），热加载生效。
5. **傻瓜主路径。** 默认「设备码 + 供应商 + API Key + 测试」；密钥不进日志。
6. **未配置不阻止 runtime 启动。** Agent 可起，但不发 LLM，直到配置成功。

## 维护方式

- **验收**：清空配置 → 起表 → 得码 → 手机浏览器打开 H5 → 配通 → 表上热加载后一次 LLM 成功；全程无手机 App、无外部依赖。
- **排查「一直未配置」**：码是否过期、手表是否能访问 Setup、提交是否校验失败、落盘路径是否可读。
- **排查「表上不出设备码」**：表端残留有效 `llm-config.json`（或 KV `llm_config`）时 configured=true 会**短路引导**，永远不申请码；把文件移走（如改 `.bak`）再重启应用即可重新进入引导。重新配置已配置的表目前也只有这两条路（清文件 / CLI sync 直写），「重新绑定」入口尚未实现。
- **排查「测通但表未生效」**：下发是否到达、热加载是否调用、文件字段是否通过归一化。
- **与 llm-configuration.md**：本文 = 生产用户路径（目标态）；彼文 = 研发现状。

## 已决（2026-09-15）

1. **无手机伴侣 App**；主路径 = **设备码 + 系统浏览器 H5 + 轻量 Setup**。
2. **不自研 BLE**；不以 BlueXlink 伴侣为前置（官方互联仅可选增强）。
3. **热加载**写入后生效。
4. **手机代理 LLM** 只记录、本期不实现；首启只负责把配置写到表上，表上仍直连。

## 一期实现备忘

- Setup：`node scripts/setup-server/server.js --host 0.0.0.0`（默认只绑 `127.0.0.1`，手表/模拟器要访问必须换成 `0.0.0.0` 或局域网 IP）；启动后自动打开本机浏览器，桩测用 `--no-open` 关掉。
- 引导地址来源（三处兜底，按优先级）：① KV `setup_config.baseUrl`；② `internal://files/agent/setup-config.json`；③ 构建期默认 `blueos/src/assets/runtime-config.js` 的 `setupBaseUrl`。`node scripts/llm-config.js sync-simulator` 会把 `setup-config.json`（默认 `http://<本机局域网IP>:8790`，可 `--setup-url` 覆盖）连同 `llm-config.json` 一起写进模拟器 agent 目录——但**只对模拟器有效**，真机上这两处都没有写入通道，只能靠构建期默认地址（改完重新打包安装）。
- **手表不能拉起手机浏览器**（平台无控制手机的能力，且不做手机 App）。落地形态是手表屏出二维码：`pages/index` 用官方 `qrcode` 组件渲染 `setupUrl?code=<6位码>`，手机扫码直接进填 Key 页（H5 读 `?code=` 预填）。
- 页面状态来源是 `runtime.getState().onboarding`：`no-url / requesting / waiting / applying / done / failed`，页面每秒轮询刷新，`onHide/onDestroy` 释放定时器。
- 轮询响应必须先判 `error` 再判「未就绪」：错误体里没有 endpoint/apiKey，顺序反了会被当成还没提交而无限轮询。
- **码失效自愈链**（Setup 重启清会话 / 码过期 / 已领取）：表端轮询到「无效/已过期/已使用/已领取」错误体时自动重新申请码（上限 3 次，会话恢复 204 后重置预算，防异常循环），二维码与通知随之更新；H5 保存碰到 404/410 自动解绑旧码（并清掉地址栏旧参数），跟随 3 秒轮询自动绑上表的新码，已通过的测试连接不失效。
- **全自动重配配方**（2026-10-25 实跑验证，无需手机）：① 备份移走表端 `llm-config.json`；② 核对 `setup-config.json` 的 baseUrl 是否为**本机当前局域网 IP**（DHCP 换网段后必改，否则表端 requesting 直接 fetch failed）；③ 重启表端应用（模拟器：命令面板 `open simulator`，会重新编译并拉起 `watch.exe`）；④ 等表申请码（GET /api/setup/sessions）；⑤ `POST /api/setup/test-connection` 验通后 `POST /api/setup/session/<code>/config` 提交；⑥ 表 2 秒内领走配置（会话即删），验证见下条。全程唯一人工步骤是无。
- **模拟器应用控制台日志位置（排障必读）**：当前 Studio 实例数据目录是 `C:\Users\<user>\AppData\Roaming\BlueOS Studio\logs\<会话>\window1\output_*\project.log`（**目录名带空格**，区别于旧的 `Roaming\BlueOSStudio`——旧目录 2026-09 起就是死档，别再翻）；但模拟器 sdcard（表端 `internal://files`）仍在旧目录 `Roaming\BlueOSStudio\simulator\sdcard\` 下，两者分裂是工具链现状。`blueos/logs/project-*.log` 只有旧版模拟器模式才写。模拟器引擎是 `watch.exe`（无独立窗口，画面渲染在 Studio 内嵌 webview，经 127.0.0.1:8000 WebSocket 桥连接），被遮挡时截屏会返回过期缓存帧，验证状态以 project.log 为准。
- **一只表同时只一个活码**：Setup 在 `POST /api/setup/sessions` 签发新码时先清掉同 `device_id` 的全部旧会话（旧码即刻 404），H5 轮询发现绑定的码被**别的会话顶替**（列表非空但没了自己的码）时自动解绑跟随；列表**清空**则视为配置已被领取，保持绑定显示不解绑（否则保存成功后页面立刻翻红「未绑定」误导用户）。不清理的话等待列表同表出两个按钮，点旧码会把配置写进表已不再轮询的死会话且页面仍显示「已提交」。注意会话在内存里，**改完服务端代码必须重启 setup 进程**才生效，旧进程照旧累积重复会话。
- 轮询 GET /config 用 `responseType:'text'` + 手工解析：平台 json 模式对 204 空 body 在原生解析层抛 JSError（详见 blueos-platform-constraints.md「fetch 的实测平台行为」），本地桩同样按「json+空体 → fail」模拟。
- 本地桩：`scripts/local-test/setup-server.test.mjs`（服务端）、`scripts/local-test/onboarding.test.mjs`（引导状态机，含码失效重申路径与重申上限）。
- 未验：模拟器/真机上手表能否访问电脑局域网端口、二维码在 466 圆屏上的可读尺寸。

> 更新时间：2026-10-25
