#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/helix"
CONFIG_FILE="${HELIX_SSH_CONFIG:-$CONFIG_DIR/ssh-mcp.json}"
RUNTIME_DIR="$(dirname "$CONFIG_FILE")"
GUIDE_FILE="$RUNTIME_DIR/HELIX_AI_GUIDE.md"
SKILL_DIR="$RUNTIME_DIR/skills/helix-remote-operations"
SKILL_FILE="$SKILL_DIR/SKILL.md"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require_command node
require_command npm
require_command ssh
require_command scp

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20 or newer is required. Current version: $(node --version)" >&2
  exit 1
fi

cd "$ROOT_DIR"
npm install
npm run check
npm test
npm run build

mkdir -p "$RUNTIME_DIR"
if [[ ! -f "$CONFIG_FILE" ]]; then
  cp "$ROOT_DIR/examples/ssh-mcp.config.json" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  echo "Created config: $CONFIG_FILE"
else
  echo "Keeping existing config: $CONFIG_FILE"
fi

cp "$ROOT_DIR/docs/guides/HELIX_AI_GUIDE.md" "$GUIDE_FILE"
mkdir -p "$SKILL_DIR"
cp "$ROOT_DIR/skills/helix-remote-operations/SKILL.md" "$SKILL_FILE"

ENTRY="$ROOT_DIR/apps/ssh-mcp/build/index.js"
echo
echo "Helix SSH MCP installation completed."
echo "Entry:    $ENTRY"
echo "Config:   $CONFIG_FILE"
echo "AI guide: $GUIDE_FILE"
echo "Skill:    $SKILL_FILE"
echo
echo "MCP client configuration:"
cat <<JSON
{
  "mcpServers": {
    "helix-ssh": {
      "command": "node",
      "args": ["$ENTRY"],
      "env": {
        "HELIX_SSH_CONFIG": "$CONFIG_FILE",
        "HELIX_AI_GUIDE": "$GUIDE_FILE"
      }
    }
  }
}
JSON
