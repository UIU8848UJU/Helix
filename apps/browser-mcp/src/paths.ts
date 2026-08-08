import os from "node:os";
import path from "node:path";

export function getConfigPath(): string {
  if (process.env.BROWSER_MCP_CONFIG) {
    return path.resolve(process.env.BROWSER_MCP_CONFIG);
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "Helix", "browser-mcp.json");
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "helix", "browser-mcp.json");
}

export function getAuditPath(): string {
  if (process.env.BROWSER_MCP_AUDIT_LOG) {
    return path.resolve(process.env.BROWSER_MCP_AUDIT_LOG);
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Helix", "browser-mcp", "audit.jsonl");
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "helix", "browser-mcp", "audit.jsonl");
}
