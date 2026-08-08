#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/helix"
CONFIG_FILE="${HELIX_SSH_CONFIG:-$CONFIG_DIR/ssh-mcp.json}"
BROWSER_CONFIG_FILE="${BROWSER_MCP_CONFIG:-$CONFIG_DIR/browser-mcp.json}"
RUNTIME_DIR="$(dirname "$CONFIG_FILE")"
GUIDE_FILE="$RUNTIME_DIR/HELIX_AI_GUIDE.md"
SKILL_DIR="$RUNTIME_DIR/skills/helix-remote-operations"
SKILL_FILE="$SKILL_DIR/SKILL.md"
DEPLOYMENT_MODE="${HELIX_DEPLOYMENT_MODE:-Harness}"

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

if [[ "$DEPLOYMENT_MODE" != "Harness" && "$DEPLOYMENT_MODE" != "Personal" && "$DEPLOYMENT_MODE" != "EnterpriseLocked" ]]; then
  echo "HELIX_DEPLOYMENT_MODE must be Harness, Personal or EnterpriseLocked" >&2
  exit 1
fi

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

node - "$CONFIG_FILE" "$DEPLOYMENT_MODE" <<'NODE'
const fs = require("node:fs");
const [file, mode] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.settings ??= {};
if (mode === "EnterpriseLocked") {
  config.settings.allowHostMutation = false;
  config.settings.allowPolicyMutation = false;
  config.settings.strictHostKeyChecking = true;
} else {
  config.settings.allowHostMutation = true;
  config.settings.allowPolicyMutation = true;
  config.settings.strictHostKeyChecking = false;
  for (const host of Object.values(config.hosts ?? {})) {
    host.allowedRemotePaths = ["/"];
    if (host.sudo) host.sudo.allow = ["^.*$"];
  }
}
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE

if [[ ! -f "$BROWSER_CONFIG_FILE" ]]; then
  cp "$ROOT_DIR/examples/browser-mcp.config.json" "$BROWSER_CONFIG_FILE"
  chmod 600 "$BROWSER_CONFIG_FILE" 2>/dev/null || true
  echo "Created browser config: $BROWSER_CONFIG_FILE"
else
  echo "Keeping existing browser config: $BROWSER_CONFIG_FILE"
fi

npx playwright install chromium || {
  echo "Warning: Playwright Chromium install failed; browser integration tests will be skipped." >&2
}

cp "$ROOT_DIR/docs/guides/HELIX_AI_GUIDE.md" "$GUIDE_FILE"
mkdir -p "$SKILL_DIR"
cp "$ROOT_DIR/skills/helix-remote-operations/SKILL.md" "$SKILL_FILE"

ENTRY="$ROOT_DIR/apps/ssh-mcp/build/index.js"
BROWSER_ENTRY="$ROOT_DIR/apps/browser-mcp/build/index.js"
echo
echo "Helix SSH MCP installation completed."
echo "Entry:    $ENTRY"
echo "Config:   $CONFIG_FILE"
echo "AI guide: $GUIDE_FILE"
echo "Skill:    $SKILL_FILE"
echo "Browser entry: $BROWSER_ENTRY"
echo "Browser config: $BROWSER_CONFIG_FILE"
echo "Deployment mode: $DEPLOYMENT_MODE"
echo "Direct sudo: enabled; destructive commands are blocked by the Harness guard"
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
    },
    "helix-browser": {
      "command": "node",
      "args": ["$BROWSER_ENTRY"],
      "env": {
        "BROWSER_MCP_CONFIG": "$BROWSER_CONFIG_FILE"
      }
    }
  }
}
JSON
