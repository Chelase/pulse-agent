# Pulse Agent

> 运行在 vivo 蓝河 BlueOS 上的独立手表 Agent —— 专注于腕上独立执行。

**Pulse Agent** 是一个运行在 vivo 蓝河 BlueOS 上的完整手表 Agent：独立的感知、闸门、思考与输出闭环，脱离任何生态都可单独执行。通过对外契约可被外部系统发现与接入（可选增强，不是运行前提）。

## 架构层次

```
┌──────────────────────────────────────────────────────────┐
│                      pulse-agent                          │
├──────────────────────────────────────────────────────────┤
│   common/        ← Layer 1: 对外契约层                    │
│   (协议 / 身份 / 模型 / 能力)                              │
├──────────────────────────────────────────────────────────┤
│   blueos/        ← Layer 2: BlueOS 实现层                 │
│   (agent-core / platform / pages / ui)                    │
├──────────────────────────────────────────────────────────┤
│   scripts/       ← 构建部署                                │
└──────────────────────────────────────────────────────────┘
```

`common/` 面向外部接入系统。Agent 本体不依赖它们运行。

## Agent 的四步闭环

```
1. 感知   别的设备拿不到的——是不是本人、醒着没、平静还是紧张、动没动
2. 闸门   本地廉价规则筛掉噪声，不为每个心率样本烧电
3. 思考   跨过闸门的事件才进入 LLM 判断
4. 输出   落回腕上——振动提醒
```

手表的不可替代性在于三件事叠加：**被动输入极强**（唯一贴皮肤、连续、不需用户配合）、**低带宽输出极强**（腕上振动是抵达率最高的通道）、**交互输入极差**（小圆屏、无键盘）。

所以强形态是**被事件唤醒的 Agent，不是被问话唤醒的助手**——手表端不提供 UI，BlueOS 只承载执行层 Agent。模型配置统一通过仓库 CLI 或本地 Web 配置服务完成。Agent 由传感器事件和外部调用触发。

闸门条件是声明式契约，定义在 [`common/models/`](./common/models/README.md)。

## 快速开始

```bash
# 配模型：起设备码 H5，手表没配时屏上出二维码，手机扫码填 Key
node scripts/setup-server/server.js --host 0.0.0.0

# 或直接用 CLI 配置
node scripts/llm-config.js set \
  --provider deepseek \
  --endpoint https://api.deepseek.com/v1/chat/completions \
  --model deepseek-chat \
  --api-key-stdin < api-key.txt

# 同步到 BlueOS Studio 默认模拟器
node scripts/llm-config.js sync-simulator

# 构建 BlueOS 无 UI 执行层
./scripts/build-blueos.sh

# 部署到设备
./scripts/deploy.sh
```

> 用 BlueOS Studio 打开 `blueos/` 目录构建，源码在 `blueos/src/` 下。
> 手表端不提供配置或展示 UI；模型配置在本机 CLI/Web 控制面完成，见 [blueos/src/README.md](./blueos/src/README.md)。


## 项目结构

```
pulse-agent/
├── common/              Layer 1 — 对外契约（协议/身份/模型/能力）
│   ├── protocol/        手表 Agent ↔ 外部生态接口契约
│   ├── identity/        Agent 身份 (root_id)
│   ├── models/          共享数据模型（闸门条件契约）
│   ├── capabilities/    能力声明
│   └── tests/           契约一致性测试
├── blueos/              Layer 2 — BlueOS 实现
│   └── src/
│       ├── app.ux       无 UI 执行入口
│       ├── agent-core/  Agent 执行层 (JS)
│       └── platform/    BlueOS 原生 API 封装
├── scripts/             构建/部署/CLI/Web 配置脚本
├── docs/                文档
└── .agent-rules/        Agent 规则链路
```

## 文档

| 文档 | 内容 |
|------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构方案与关键决策记录 |
| [docs/development-guide.md](./docs/development-guide.md) | 开发指南 |
| [.agent-rules/](./.agent-rules/) | Agent 规则、机制文档、开发计划 |
