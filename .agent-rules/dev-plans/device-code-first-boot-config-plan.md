# 设备码首启配置 — 开发计划

> **机制**：.agent-rules/mechanisms/phone-first-boot-config.md（目标态）  
> **研发现状**：.agent-rules/mechanisms/llm-configuration.md  

## 当前阶段

一期：打通「设备码 → 浏览器 H5 → Setup → 表上热加载」最小闭环，本地/模拟器可验收；真机网络与通知展示留验证项。

## 一期已决默认（原待决拍板）

| 项 | 决定 |
| --- | --- |
| 短码展示 | **系统通知文案 + runtime 日志**；不恢复完整设置页。若通知 API 不可用则仅日志（真机再验） |
| 下发模型 | **手表拉**：短轮询 Setup GET /api/setup/session/:code/config；不做服务推 |

## 目标与非目标

**目标**
1. 未配置时手表申请 device_code 并开始轮询
2. H5：输入码、预设供应商、API Key、测连通、提交
3. Setup：签发码、绑定会话、收配置、手表拉取；码用后作废、有 TTL
4. 手表校验后写入 llm-config.json，LLMClient **热加载**
5. 本地桩测覆盖主路径；开发机 CLI/Web 路径不破坏

**非目标（本期不做）**
- 手机伴侣 App / BlueXlink 配置通道
- 手机代理 LLM
- 公网部署、账号体系、多设备管理台
- 表上完整配置表单 UI

## 步骤

### Step A — Setup 服务 + H5

- scripts/setup-server/server.js：HTTP JSON API + 静态 H5
- API 草案：
  - POST /api/setup/sessions → { device_id, root_id? } → { code, expires_at, poll_interval_ms }
  - GET /api/setup/session/:code → 会话状态（无密钥）
  - POST /api/setup/session/:code/config → body 对齐 llm-config 字段；服务端可做基本校验；成功后标记 ready
  - GET /api/setup/session/:code/config → 手表拉；ready 前 204；ready 后返回配置并**一次性消费**（或返回后作废）
  - POST /api/setup/test-connection → 可选：服务端用提交的 endpoint/key 做一次最小 chat 探测（失败则面板不可提交）
- H5：傻瓜主路径；高级折叠 endpoint/model
- 复用/对齐 scripts/llm-config-store.js 的字段归一化与校验（能抽则抽，避免第三套 schema）

### Step B — 手表 onboarding + 热加载

- 新增 lueos/src/agent-core/config-onboarding.js
- 
untime 在 LLM init 后：若未配置则 onboarding.start({ setupBaseUrl })
- setupBaseUrl 来源：KV / 本地文件 / 构建期默认（开发默认指向电脑局域网 IP 需可配置；文档写明）
- 轮询拿到配置 → validate → Storage 写 llm-config.json → 调用 LLMClient 热加载（新增 
eload() 或等价）
- 通知：有则发「请用浏览器打开 … 并输入码 XXXXXX」

### Step C — 本地桩测与文档

- scripts/local-test/ 增加 setup 会话、一次性拉取、热加载相关断言
- 更新 phone-first-boot-config.md 状态说明与 llm-configuration.md 互指
- 本计划进度表回写

## 验收清单

- [x] Setup 能签发码；过期/错误码有明确错误
- [ ] H5 傻瓜路径可提交；测试连接失败不可提交（或明显警告，实现时选严格模式）
- [ ] 手表（或 Node 桩模拟 onboarding）拉到配置后文件落盘且热加载 configured=true
- [x] 同码不可重复拉取敏感配置（一次性）
- [ ] 未配置时 runtime 仍能启动、不发 LLM
- [ ] 现有 llm-config CLI/Web/sync-simulator 回归不挂
- [ ] 机制文档与计划索引已更新

## 进度

| 步骤 | 状态 |
| --- | --- |
| Step A Setup + H5 | **已完成（本地桩测通过）** |
| Step B 手表 onboarding + 热加载 | **代码已接入**（需配置 setupBaseUrl；真机待验） |
| Step C 桩测与文档 | **进行中**（setup-server.test 已过） |

> 更新时间：2026-09-15
