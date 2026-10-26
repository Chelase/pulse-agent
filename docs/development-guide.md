# 开发指南

> 本项目只做 BlueOS——唯一目标平台（见根 `ARCHITECTURE.md` §一）。

## 目录导航速查

| 你想做什么 | 去哪个目录 |
|-----------|-----------|
| 管理 Agent 身份和 root_id | `common/identity/` |
| 定义与外部生态共享的数据结构 | `common/models/` |
| 调整闸门条件（什么值得叫醒 LLM） | `common/models/gate-conditions.json` |
| 注册手表 Agent 的能力 | `common/capabilities/` |
| Agent 执行层开发 | `blueos/src/agent-core/` |
| BlueOS 原生 API 封装 | `blueos/src/platform/` |
| 模型配置 CLI / 设备码 H5 | `scripts/llm-config.js`、`scripts/setup-server/` |
| 构建部署 | `scripts/` |

## 两层的协作模式

### 场景 1：新增一个传感器能力

```
1. common/capabilities/watch-capabilities.json
   └─ 添加能力声明（供外部生态发现）

2. blueos/src/platform/
   └─ 封装 BlueOS 原生 API

3. blueos/src/agent-core/tool-registry.js
   └─ 注册为 Agent 可调用的工具

4. blueos/src/manifest.json
   └─ 声明 features / permissions
      ⚠️ 漏声明会在真机上 import 即失败
```


### 场景 3：配置模型供应商

模型配置不放在手表端。使用仓库 CLI 或本地 Web 配置服务：

```bash
# 交互式 Web 配置页
node scripts/setup-server/server.js --host 0.0.0.0 --port 8790

# CLI 直接写入本地配置文件
node scripts/llm-config.js set \
  --provider deepseek \
  --endpoint https://api.deepseek.com/v1/chat/completions \
  --model deepseek-chat \
  --api-key "$DEEPSEEK_API_KEY"

# 查看脱敏配置
node scripts/llm-config.js show
```

配置文件只保存在本地 `config/llm-config.local.json`，已加入 `.gitignore`，不会进入提交；用 `sync-simulator` 复制到 BlueOS 模拟器 internal 文件目录。

### 场景 4：新增一个闸门条件

```
common/models/gate-conditions.json
   └─ 按 gate-conditions.schema.json 加一条
      cooldownSeconds 必填——缺了它会把 LLM 调用打爆
```

闸门只做单信号廉价比较，不做上下文融合。设计说明见 `common/models/README.md`。

## 性能注意事项

手表端没有页面和响应式 UI；Agent 进程只保留执行所需的内存状态，避免引入展示层生命周期和额外功耗。

## 与上游项目同步

| 上游项目 | 同步内容 | 频率 |
|---------|---------|------|
| `AgentOpenConnect` (D:\code\project\AgentOpenConnect) | root_id 身份机制、能力注册模式、网络协议 | 架构变更时 |
| `aos-agent` (E:\code\AndroidAutomotiveOS\aos-agent) | Agent 主循环模式、工具系统设计 | 参考学习 |
| [BlueOS 官方文档](https://developers-watch.vivo.com.cn) | JS API 更新、Studio 新功能、后台策略变更 | 关注版本更新 |

## 开发原则

1. **契约驱动**：先定接口再实现，`common/` 是对外约定，外部生态按它接入（可选增强）
2. **就近决策**：BlueOS 特有的逻辑不要污染 `common/`
3. **平台封装先行**：原生 API 先封装进 `platform/`，`agent-core/` 只用封装
4. **事件唤醒，非常驻循环**：Agent 受 `background.features` 约束，不能假设进程一直活着
5. **闸门先于 LLM**：本地廉价规则筛掉噪声，不为每个传感器样本调 LLM
6. **健康解读只出描述性提示**：不给医疗建议或疾病判断

## 构建与运行

```bash
# 构建 BlueOS 版本
./scripts/build-blueos.sh

# 部署
./scripts/deploy.sh [--device <ip>]
```

> 用 BlueOS Studio 打开 `blueos/` 目录（不是仓库根，也不是 `blueos/src/`），源码必须在 `blueos/src/` 下。
> LLM 需在手表上配置后使用，见 `blueos/src/README.md`。
