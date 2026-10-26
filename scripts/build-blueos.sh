#!/bin/bash
# ============================================================
# build-blueos.sh — 构建 BlueOS 版本的 RPK 包
# ============================================================
# 前置条件: BlueOS Studio CLI 已安装
# 用法: ./scripts/build-blueos.sh [--release|--debug]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BLUEOS_DIR="$PROJECT_DIR/blueos"
BUILD_TYPE="${1:-debug}"

echo "========================================"
echo "  Building BlueOS Watch Agent"
echo "  Type: $BUILD_TYPE"
echo "========================================"

# 1. 复制共享契约到 BlueOS 项目
echo "[1/3] Syncing common protocol definitions..."
cp -r "$PROJECT_DIR/common/protocol" "$BLUEOS_DIR/src/protocol" 2>/dev/null || true
cp "$PROJECT_DIR/common/identity/identity-schema.json" "$BLUEOS_DIR/src/config/" 2>/dev/null || true

# 2. 构建 RPK
echo "[2/3] Building BlueOS Studio project..."
cd "$BLUEOS_DIR/src"

if [ "$BUILD_TYPE" = "release" ]; then
    # BlueOS Studio CLI 构建命令 (根据实际 CLI 调整)
    blueos-studio build --release
else
    blueos-studio build
fi

# 3. 输出结果
echo "[3/3] Output..."
OUTPUT_DIR="$BLUEOS_DIR/dist"
mkdir -p "$OUTPUT_DIR"
cp ./*.rpk "$OUTPUT_DIR/" 2>/dev/null || echo "  (no rpk found, check build output)"

echo ""
echo "========================================"
echo "  BlueOS build complete"
echo "  Output: $OUTPUT_DIR"
echo "========================================"
