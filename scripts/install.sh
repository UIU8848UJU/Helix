#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/helix"
CONFIG_FILE="${HELIX_SSH_CONFIG:-$CONFIG_DIR/ssh-mcp.json}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少依赖: $1" >&2
    exit 1
  fi
}

require_command node
require_command npm
require_command ssh
require_command scp

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "需要 Node.js 20+，当前版本: $(node --version)" >&2
  exit 1
fi

cd "$ROOT_DIR"
npm install
npm run build

mkdir -p "$(dirname "$CONFIG_FILE")"
if [[ ! -f "$CONFIG_FILE" ]]; then
  cp "$ROOT_DIR/examples/ssh-mcp.config.json" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  echo "已创建配置: $CONFIG_FILE"
else
  echo "保留现有配置: $CONFIG_FILE"
fi

ENTRY="$ROOT_DIR/apps/ssh-mcp/build/index.js"
echo
echo "Helix SSH MCP 安装完成。"
echo "入口: $ENTRY"
echo "配置: $CONFIG_FILE"
echo
echo "MCP 客户端配置片段:"
cat <<JSON
{
  "mcpServers": {
    "helix-ssh": {
      "command": "node",
      "args": ["$ENTRY"],
      "env": {
        "HELIX_SSH_CONFIG": "$CONFIG_FILE"
      }
    }
  }
}
JSON
