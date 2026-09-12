import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { HttpConfig } from "./types.js";
const sensitiveHeaders = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);
function auditPath(): string { return process.env.HELIX_HTTP_AUDIT_PATH ?? path.join(process.env.HELIX_HTTP_CONFIG_HOME ?? (process.env.APPDATA ?? path.join(process.env.HOME ?? ".", ".config")), "Helix", "http-mcp-audit.jsonl"); }
export function newRequestId(): string { return randomUUID(); }
export function redactUrl(rawUrl: string): string { try { const url = new URL(rawUrl); return `${url.origin}${url.pathname}`; } catch { return "<invalid-url>"; } }
export function safeHeaderNames(headers: Record<string, string> | undefined): string[] { return Object.keys(headers ?? {}).filter((name) => !sensitiveHeaders.has(name.toLowerCase())); }
export async function writeAudit(config: HttpConfig, event: { requestId: string; method: string; url: string; headerNames: string[]; status?: number; durationMs: number; errorCode?: string }): Promise<void> {
  if (!config.auditEnabled) return; const filePath = auditPath(); await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.appendFile(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event, url: redactUrl(event.url) })}\n`, { encoding: "utf8", mode: 0o600 }); if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
}
