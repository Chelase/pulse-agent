#!/bin/bash
# ============================================================
# deploy.sh — 部署手表 Agent 到目标设备
# ============================================================
# 用法:
#   ./scripts/deploy.sh [--device <ip>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 解析参数
DEVICE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --device)   DEVICE="$2";   shift 2 ;;
        --help)
            echo "Usage: $0 [--device <id>]"
            exit 0 ;;
        *) echo "Unknown: $1"; exit 1 ;;
    esac
done

# ---------- BlueOS 部署 ----------
echo "Deploying to BlueOS device..."
BLUEOS_DIST="$PROJECT_DIR/blueos/dist"

if [ ! -d "$BLUEOS_DIST" ]; then
    echo "Error: no build artifacts found. Run build-blueos.sh first."
    exit 1
fi

RPK_FILE=$(find "$BLUEOS_DIST" -name "*.rpk" | head -1)
if [ -z "$RPK_FILE" ]; then
    echo "Error: no .rpk file found in $BLUEOS_DIST"
    exit 1
fi

# BlueOS 部署方式（根据实际工具链调整）
if [ -n "$DEVICE" ]; then
    echo "  Deploying $RPK_FILE to $DEVICE ..."
    # blueos-cli install --device "$DEVICE" "$RPK_FILE"
else
    echo "  Installing $RPK_FILE locally..."
    # blueos-cli install "$RPK_FILE"
fi

echo "  BlueOS deploy command placeholder — implement per toolchain"
