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