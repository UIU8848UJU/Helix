import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSettings } from "./types.js";

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function getConfigPath(): string {
  if (process.env.HELIX_SSH_CONFIG) {
    return path.resolve(expandHome(process.env.HELIX_SSH_CONFIG));
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "Helix", "ssh-mcp.json");
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "helix", "ssh-mcp.json");
}

export function getAuditPath(): string {
  if (process.env.HELIX_SSH_AUDIT_LOG) {
    return path.resolve(expandHome(process.env.HELIX_SSH_AUDIT_LOG));
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Helix", "ssh-mcp", "audit.jsonl");
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "helix", "ssh-mcp", "audit.jsonl");
}

export function getCredentialBrokerPath(settings?: GlobalSettings): string {
  const configured = process.env.HELIX_CREDENTIAL_BROKER ?? settings?.credentialBrokerPath ?? undefined;
  if (configured) return path.resolve(expandHome(configured));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const executable = process.platform === "win32"
    ? "helix-credential-broker.exe"
    : "helix-credential-broker";
  return path.resolve(here, "../../credential-broker/target/release", executable);
}

export function getLocalPathRoots(): string[] {
  const raw = process.env.HELIX_LOCAL_PATH_ROOTS;
  if (raw) {
    const delimiter = process.platform === "win32" ? ";" : ":";
    return raw
      .split(delimiter)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(expandHome(item)));
  }

  if (process.platform !== "win32") return [path.parse(process.cwd()).root];

  const roots = [process.cwd(), os.homedir(), os.tmpdir()]
    .map((item) => path.parse(path.resolve(item)).root)
    .filter(Boolean);
  return [...new Set(roots)];
}
