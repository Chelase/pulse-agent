# BlueOS 平台约束（官方文档核对结果）

> 来源：`developers-watch.vivo.com.cn`（蓝河手表文档正文实际托管域名；`developers.vivo.com` 只是 iframe 外壳）。
> 页面更新时间多为 2024-09～2024-11，蓝牙页 2025-10-09；**尚无蓝河 4 的第三方开发文档**。

## 结论

蓝河手表第三方应用不是常驻进程、也没有端口监听能力；本项目的常驻与入站只能落在「定时任务后台拉起 app.ux 方法」与「BLE GATT 外围设备」这两条官方路径上。

## 涉及对象

| 对象 | 角色 |
| --- | --- |
| `blueos/src/app.ux` | 官方定位为「应用首页」，缺失则应用无法启动；同时是 `triggerMethod` 与通知按钮回调的宿主 |
| `blueos/src/manifest.json` | `features`（接口权限声明）/ `config`（运行依赖能力）/ `router`（entry+pages）分属不同层级 |
| `blueos/src/platform/schedule.js` | 对应官方「后台管理 > 定时任务」 |
| `blueos/src/platform/ble-service.js` | 对应官方「通信能力 > 蓝牙」中的 BLE 外围设备（GATT 服务端） |
| `blueos/src/agent-core/llm-client.js` | 对应「通信能力 > 数据请求」，客户端角色 |

## 运行链路

```
官方能力分层（第三方可见）
  形态       表盘 / 快捷卡片 / 快应用(.ux)          ← 本项目是快应用，必须有首页与 router
  API        JS API(.ux，兼容快应用) / Native API(C/C++，仅 BlueOS Studio)
  入站       蓝牙(GATT Server/Client) ；其余全是出站客户端：
               数据请求 fetch、websocket、上传下载、网络状态
  后台       定时任务：scheduleJob{type:1 硬件时间 | 2 真实时间流逝(休眠也计时),
               timeout, interval, triggerMethod:app.ux 方法名, params}
               错误码 -27 任务已满 / -28 已注册
             「后台运行」文档存在，但接入方式写明「具体方案请联系商务」
  输出       通知 publish：contentType 1 文本 / 2 图片，actionButtons 最多 2 个，
               channel 1=PHONE 2=WATCH_APP，按钮 triggerMethod 需在 app.ux 定义
             振动 vibrator ；AI 服务为云侧（视觉/语音/NLP 走 vivo 算法平台）
  渲染       UI 组件覆盖投射卡片原语：text / span / arc-text(圆屏弧形) / image /
               marquee(滚动文本) / progress / list+list-item / scroll / swiper / canvas /
               vw-* ；表冠旋转可作为滚动输入
```

## 构建工具链的 feature 翻译（模拟器排障得来的事实）

`blueos/build/<device>/manifest.json` 是工具链产物，其中 **`features` 会被翻译成运行时真名**：

```
blueos.network.fetch     → system.fetch            blueos.health.health   → service.health
blueos.network.webSocket → system.websocketfactory blueos.network.networkManager → system.network
blueos.storage.storage   → system.storage          blueos.app.appmanager.schedule → system.schedule
blueos.storage.file      → system.file             blueos.hardware.sensor.sensor → system.sensor
blueos.hardware.vibrator.vibrator → system.vibrator
blueos.app.notification.notificationManager → system.notification
```

**判据**：翻译过去 = 本机 SDK 有该能力；**原样留着 `blueos.*` = SDK 不认**。
`blueos.bluetooth.ble` 实测原样保留（蓝牙 GATT Server 文档 2025-10 才更新，比本机 SDK 新），
把它 import 进应用链路后模拟器直接 `ErrExit code: 1`，故 BLE 已从默认装配摘除。

`config.*` 下的名字**不翻译**（`config.background.features` 在旧构建里同样是 `blueos.*`），那里写 `blueos.*` 是正常的，不是故障源。

## fetch 的实测平台行为（模拟器排障得来的事实）

- **`responseType: 'json'` 遇空响应体在原生层就崩**（2026-10-03 模拟器实测）：平台自己 `JSON.parse` 空 body，
  抛 `JSError: unexpected end of input at parse (native)`，success/fail 的正常语义走不到，轮询间隔多长就多久刷一条错误。
  可能拿到空响应体的请求（如 setup 轮询的 204 未就绪）必须用 `responseType: 'text'` + 手工解析
  （空体 = 未就绪），见 `agent-core/config-onboarding.js` 的 `httpJson`；本地桩 `stubs.mjs` 的
  `blueosFetch` 按此行为模拟（json 模式 + 空 body → fail），防止实现退回 json 模式。

## 模拟器控制台的两条常见噪音（均无碍，勿当故障排查）

- `A subdirectory or file ...\simulator\sdcard\internal\com.pulse.agent\files\agent already exists.`：
  模拟器宿主往宿主机 sdcard 镜像同步目录时 `mkdir` 撞已存在目录的抱怨（cmd mkdir 原文），非应用错误；
  每次表端写 `internal://files` 都可能带出一条，应用侧写入紧随其后成功。
- `ScheduleFeature scheduleJob error`：模拟器不支持平台定时任务（`@blueos.app.appmanager.schedule` → system.schedule），
  代码已有降级：心跳退化为进程内 60 秒定时器（真机则走系统级后台拉起）。模拟器上见到它 = 正常走了降级路径。

## 真机安装通道（2026-10-25 核实：个人开发者不可用）

- **官方快速入门**（developers-watch.vivo.com.cn/reference/quickstart/quick-start）只覆盖模拟器调试与 IDE 打包
  （「打包」按钮选 release/debug + 环境；release 需先生成签名证书，成功后 rpk 落在项目 `dist/`），**通篇没有真机安装/真机调试章节**。
- **社区实测口径**（知乎 2024-11 踩坑帖）：普通用户未开放真机调试，rpk 只能经 vivo 开放平台上架应用商店，
  而上架要求**企业资质**；个人开发者拿不到手表侧安装通道。
- **手机不能当蓝牙安装网关**：手表蓝牙链路是伴侣通道（通知/健康/通话），不是应用安装通道；
  手机侧（即使 root/SSH 进 Termux）没有任何可调用的官方接口能把 rpk 塞进手表系统安装器。
  rpk 签名校验在手表系统层，自签/无证书包装不上。
- **结论**：现阶段模拟器是唯一可运行目标；上真表只有「企业资质 + 应用商店上架」一条官方路。

## Studio 2.2.1 打包功能实测（2026-10-26）

- **本机安装的 BlueOS Studio 2.2.1 没有「打包」UI，且 2.2.1 就是官网最新版**（studio.blueos.com.cn 的
  Download 脚本里 win 包只有 `blue-os-studio-win-2.2.1.zip`，应用内更新器口径一致）——不存在"升级获得打包按钮"的路。
  官方文档的顶部工具栏打包按钮（截图含 安装依赖/编译/打包）对应的是更新版的 IDE 形态。
- **打包能力实际在 CLI：`blueos-pack`**（`extensions/blueos-debugger/node_modules/blueos-pack/`，README §2 证实
  IDE 的打包界面就是调用它）。命令行直接用：
  `node <Studio>/resources/app/extensions/blueos-debugger/node_modules/blueos-pack/bin/index.js release --device-type watch-round`
  （debug 包用 `build` 子命令；其余选项 `--help`）。产出 `blueos/dist/watch-round/release/com.pulse.agent.release.<ver>.rpk`。
  本项目 2026-10-26 实跑成功：90KB，内含 manifest.json + `com.pulse.agent.vru`（编译产物主体）+ META-INF/CERT（签名 zip：hash.json SHA-256 摘要清单）+ META-INF/build.txt。
- **签名证书**：菜单「工具 → 生成证书」弹「创建新的签名」表单（国家 2 字母/省/城市/组织/部门/通用名/邮箱；
  邮箱校验严格，`.local` 伪 TLD 被拒），生成到 `blueos/sign/certificate.pem` + `private.pem`，pack CLI 自动引用同目录。
- **UI 自动化的可靠打法**（本次沉淀）：① Studio 带 `--remote-debugging-port=9333` 启动，用其自带
  `chrome-remote-interface`（`resources/app/node_modules/`，createRequire 显式指向）经 CDP 驱动——
  键盘 `Input.dispatchKeyEvent`/`insertText`、点击 `Input.dispatchMouseEvent`、截图 `Page.captureScreenshot`，全程不抢用户前台；
  ② **Input 坐标是 CSS 像素，截图是 dpr(1.25) 放大像素，两者差 1.25 倍**——所有点击先除以 dpr（本次全靠这步修正才点准菜单）；
  ③ 中文输入用 `Input.insertText`，别用剪贴板注入；④ 盲发全局按键（SendKeys）会打进用户正聚焦的其他窗口，禁用。
- **已知坑**：模拟器进程 `watch.exe` 偶发启动即崩（`ErrExit code 1/3221225477`），重开模拟器即可；
  应用日志真身在 `Roaming\BlueOS Studio\logs\<会话>\window1\output_*\project.log`（带空格目录）。

## 使用点

- `runtime.start()` 的十三步装配与 `heartbeat.start()` 依赖定时任务语义。
- `app.ux` 的 `agentTick` 依赖「triggerMethod 必须是 app.ux 上的方法名」。
- `agent-core/config-onboarding.js` 的对外连接依赖 fetch/websocket 主动外连。
- `blueos/src/pages/index/index.ux` 存在的直接原因是「必须有首页」。
- `platform/ble-service.js` 目前只能显式装配（`new BleService(...).start()`），不进 `runtime.start()`。

## 修改点

| 要做什么 | 改哪里 | 怎么改 |
| --- | --- | --- |
| 加平台接口 | `manifest.json` `features` + `platform/` 封装 | 名称逐字照官方「接口声明」写，import 前必须已声明 |
| 要后台周期性动作 | `platform/schedule.js` | 用 type=2；不要指望常驻，按窗口预算切步 |
| 要外部可调用 | `platform/ble-service.js` 或主动外连 | 不存在监听端口方案；BLE 是唯一本机可被连的入口 |
| 腕上做投射渲染 | `blueos/src/pages/` + 组件 | 用 `marquee`/`progress`/`list` 等原语，不要退化到只用通知 |
| 申请权限 | `manifest.json` `permissions` | 健康类已有；蓝牙需 `blueos.permission.BLUETOOTH`，敏感权限是否需白名单未核 |

## 关键约束

1. 第三方应用没有监听端口 API；一切「外部找到手表」都要么手表主动外连，要么走 BLE 被连接。
2. `app.ux` 必须是首页且可被后台回调，`router.entry`/`router.pages` 缺失会导致应用无法启动。
3. 「后台运行」不是自助开放能力（文档指向联系商务）；能自主用的只有定时任务 + 事件订阅。
4. 一次后台窗口的可用时长官方没有公布数值，所有链路必须按「随时可能被中断」设计（见 `resident-heartbeat-chain.md` 约束 3）。
5. 官方 AI 服务在云侧且依赖 vivo 算法平台，与本项目「自带 Key、任意 OpenAI 兼容端点」是两条路。
6. 通知按钮最多 2 个、健康实时采样固定 200ms 间隔、单次会话上限 10 分钟——闸门与投影设计要按这几个硬数走。

## 维护方式

- **重新核对**：文档正文取 `https://developers-watch.vivo.com.cn/<路径>/`（带 `/` 结尾），`developers.vivo.com/product/blueos/doc/...` 只是外壳，直接抓会是空页。
- **新增事实**：本文件只记已核对的官方描述；未核项显式标注「未核」，不要写成结论。
- **待补核清单**：权限白名单机制、`background` 顶层字段（官方示例为 `{type:'health', patterns:[...]}`）与本项目 `config.background.features` 的关系、定时任务最小 interval、GATT `characteristics.properties` 字段形态。
- **蓝河 4 跟进**：AgentOS/能力总线/原子技能的第三方接入文档放出后，新增独立机制文档，不要覆盖本文件（本文件是 3 代实机可依据的现状）。

> 更新时间：2026-10-26
