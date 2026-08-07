import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuditEvent, ModelWorkerConfig } from "./types.js";

export function hashPrompt(prompt: string): string {
  return `sha256:${createHash("sha256").update(prompt).digest("hex")}`;
}

export async function writeAudit(
  config: ModelWorkerConfig,
  configPath: string,
  event: AuditEvent,
): Promise<void> {
  if (!config.settings.auditEnabled) return;
  const filePath = config.settings.auditPath || path.join(path.dirname(configPath), "model-worker-audit.jsonl");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
}
