import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getAuditPath } from "./paths.js";

/**
 * Audit event for one tool call (NFR-AUD-001, ADR-005).
 * URLs are recorded as host + path only: query, hash and credentials are
 * stripped before logging so tokens cannot leak. storageState file content
 * never enters an event.
 */
export interface AuditEvent {
  ts: string;
  requestId: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  host?: string;
  path?: string;
  error?: string;
}

export function newRequestId(): string {
  return randomUUID();
}

/** Strip query/hash/credentials; keep host and path only (NFR-AUD-001). */
export function sanitizeUrl(input: string): { host: string; path: string } | null {
  try {
    const parsed = new URL(input.trim());
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname || "/" };
  } catch {
    return null;
  }
}

/**
 * JSONL audit writer. Writes are serialized on a promise chain and failures
 * are warned, never thrown, so auditing can never block or break a tool call
 * (NFR-AUD-001).
 */
export class AuditLog {
  private readonly filePath: string;
  private enabled: boolean;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: { filePath?: string; enabled?: boolean } = {}) {
    this.filePath = options.filePath ?? getAuditPath();
    this.enabled = options.enabled ?? true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  record(event: AuditEvent): void {
    if (!this.enabled) return;
    const line = `${JSON.stringify(event)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) => {
        console.warn(`[browser-mcp] audit write failed: ${String(error)}`);
      });
  }

  flush(): Promise<void> {
    return this.writeChain;
  }
}
