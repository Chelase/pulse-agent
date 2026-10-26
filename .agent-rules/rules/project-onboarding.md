# 项目速览

> 本文件由 Agent 在首次分析项目时自动填充，供后续任务快速投入开发。
> 内容来源：项目 README、ARCHITECTURE.md、目录结构扫描、代码分析。

## 1. 项目概述

pulse-agent 是一个**独立的手表 Agent**：脱离任何生态可完整执行；对外契约使其可被外部生态发现与接入（可选，生态连接由外部实现）。**目标平台只有 vivo 蓝河 BlueOS**
（见 `ARCHITECTURE.md` §一）。
两层结构：common/（对外契约）→ blueos/（唯一实现）。
手表 Agent 是完整的本地 Agent，直接调用 LLM API，人格由 root_id 统一。

## 2. 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 对外契约 | OpenAPI / JSON Schema | - |
| BlueOS 平台 | JavaScript + .ux (BlueOS Studio) | - |
| 构建脚本 | Shell | - |

## 3. 目录结构

```
pulse-agent/
├── common/           ← 对外契约层（协议/身份/模型/能力）
├── blueos/           ← BlueOS 实现层（JS + .ux），唯一实现
├── scripts/          ← 构建部署脚本
├── docs/             ← 项目文档
└── .agent-rules/     ← Agent 规则链路
```

### 核心目录说明

| 目录 | 作用 |
|------|------|
| `common/` | 对外协议契约、身份模型、能力定义 — 面向生态里其他设备 Agent |
| `blueos/` | BlueOS 手表 Agent — JS API 调用 + .ux UI |
| `scripts/` | 构建 BlueOS RPK / 部署脚本 |

## 4. 核心模块

### common/ 对外契约层

定义手表 Agent 对外的通信协议、身份持久化格式、能力清单，供外部生态发现与接入。

- 关键文件：`common/identity/identity-schema.json`、`common/capabilities/watch-capabilities.json`

### blueos/ BlueOS Agent

BlueOS 平台的手表 Agent 实现，使用 JavaScript 开发，是本项目唯一的可执行实现。

- 入口文件：`blueos/src/app.ux` → `blueos/src/agent-core/runtime.js`
- 关键文件：`blueos/src/agent-core/agent-loop.js`、`blueos/src/platform/storage.js`
- 运行时链路：`.agent-rules/mechanisms/blueos-agent-runtime.md`

## 5. 特殊机制

### 两层隔离机制

common/ 只放契约不放可执行代码，blueos/ 是唯一实现。详见 `ARCHITECTURE.md`。

### 统一身份

手表 Agent 的身份模型基于 root_id 机制，供外部系统接入时复用。

### 事件唤醒形态

Agent 受 `manifest.json` 的 `background.features` 约束，不能是常驻循环，只能是被事件唤醒的处理器。

## 6. 常用开发路径

### 新增传感器能力

1. `common/capabilities/` 加能力声明
2. `blueos/src/platform/` 封装 BlueOS API
3. `blueos/src/agent-core/tool-registry.js` 注册为工具
4. `blueos/src/manifest.json` 声明 features / permissions

### 修改通信协议

1. `common/protocol/` 更新契约
2. `blueos/src/agent-core/` 同步更新

## 7. 注意事项

- 不要往 common/ 里写平台可执行代码 — 它只放文档和契约
- `.ux` 只认内联 `<script>`，同目录独立 `.js` 不生效（`pages/index/index.js` 就是死文件）
- 蓝河响应式基于 Proxy，`data` 里每个属性都建代理，精简 data 能降内存提性能
- manifest 未声明的 feature 在真机上 import 即失败
- 构建脚本在 `scripts/` 下，不要在 blueos/ 下手动构建

## 8. 构建与运行

```bash
# 构建 BlueOS 版本
./scripts/build-blueos.sh

# 部署
./scripts/deploy.sh [--device <ip>]
```

> 更新时间：2026-09-13
