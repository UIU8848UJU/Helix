import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getAuditPath } from "./paths.js";
import type { AuditEvent, GlobalSettings } from "./types.js";

function redactCommand(command: string): string {
  return command
    .replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)([^\s]+)/gi, "$1<redacted>")
    .replace(/(--(?:password|passwd|token|secret|api-key)(?:=|\s+))([^\s]+)/gi, "$1<redacted>");
}

function encodeCommand(command: string, mode: GlobalSettings["auditCommandMode"]): string {
  const redacted = redactCommand(command);
  if (mode === "hash") {
    return `sha256:${createHash("sha256").update(redacted).digest("hex")}`;
  }
  return redacted;
}

export function newRequestId(): string {
  return randomUUID();
}

export async function writeAudit(
  settings: GlobalSettings,
  event: AuditEvent,
): Promise<void> {
  if (!settings.auditEnabled) {
    return;
  }

  const normalized: AuditEvent = {
    ...event,
    command: event.command ? encodeCommand(event.command, settings.auditCommandMode) : undefined,
  };

  const filePath = getAuditPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(normalized)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
}
