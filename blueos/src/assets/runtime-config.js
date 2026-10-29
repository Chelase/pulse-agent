/**
 * 构建期运行配置。
 *
 * 为什么需要它：真机上没有任何通道能写 `setup-config.json` / KV `setup_config`
 * （`sync-simulator` 只写模拟器目录），首启引导因此只能落在「缺少引导地址」。
 * 打包时把 setup 地址带进应用，是让真机出码的唯一简单办法。
 *
 * 用法：运行 Setup 服务后（`node scripts/setup-server/server.js --host 0.0.0.0`），
 * 把电脑的局域网地址填进来，重新打包安装。手表和电脑要在同一网络。
 */

export const RUNTIME_CONFIG = {
  // 例：'http://192.168.1.20:8790'；留空表示不启用构建期默认地址
  setupBaseUrl: ''
}
