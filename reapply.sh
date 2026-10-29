#!/bin/bash
# dsh-workbuddy-connect 11128 加固补丁 —— 重新套用（插件升级覆盖 lib 之后跑这个）
# 用法: ./reapply.sh [插件目录]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$HOME/.dsh/profiles/web/node_modules/dsh-workbuddy-connect/lib}"

if [ ! -d "$TARGET" ]; then
  echo "找不到插件 lib 目录: $TARGET" >&2
  echo "用第一个参数指定，例如: ./reapply.sh /path/to/dsh-workbuddy-connect/lib" >&2
  exit 1
fi

HOST_FILE="$(ls "$TARGET"/host-heartbeat-*.js 2>/dev/null | head -1 || true)"
if [ -z "$HOST_FILE" ]; then
  echo "在 $TARGET 内没找到 host-heartbeat-*.js，插件结构可能变了。" >&2
  exit 1
fi

VERSION="$(node -p "require('$(dirname "$TARGET")/package.json').version" 2>/dev/null || echo unknown)"
echo "target : $TARGET"
echo "version: $VERSION"

STAMP="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$HERE/backups/$STAMP"

cp "$(basename "$HOST_FILE")" /dev/null 2>/dev/null || true
cp "$HOST_FILE" "$HERE/backups/$STAMP/$(basename "$HOST_FILE")"
[ -f "$TARGET/index.js" ] && cp "$TARGET/index.js" "$HERE/backups/$STAMP/index.js"
echo "backup : $HERE/backups/$STAMP"

cp "$HERE/patched/lib/$(basename "$HOST_FILE")" "$HOST_FILE" 2>/dev/null || \
  cp "$(ls "$HERE"/patched/lib/host-heartbeat-*.js | head -1)" "$HOST_FILE"
[ -f "$TARGET/index.js" ] && cp "$HERE/patched/lib/index.js" "$TARGET/index.js"

# 语法自检
node --check <(cat "$HOST_FILE") 2>/dev/null || { cp "$HERE/backups/$STAMP/$(basename "$HOST_FILE")" "$HOST_FILE"; echo "语法检查失败，已回滚" >&2; exit 1; }

echo "patched: $(basename "$HOST_FILE")  index.js"
echo "完成。重启 dsh 生效。"
