import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getApprovalDirectory, getCredentialBrokerPath } from "./paths.js";
import { newRequestId, writeAudit } from "./audit.js";
import type { GlobalSettings, HostConfig, PendingApproval } from "./types.js";

export function hashCommand(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

function requestPath(requestId: string): string {
  return path.join(getApprovalDirectory(), `${requestId}.json`);
}

export async function createApprovalRequest(input: {
  settings: GlobalSettings;
  hostAlias: string;
  host: HostConfig;
  command: string;
  reason: string;
}): Promise<{ request: PendingApproval; requestFile: string; approvalCommand: string }> {
  const now = Date.now();
  const request: PendingApproval = {
    version: 1,
    requestId: randomUUID(),
    hostAlias: input.hostAlias,
    hostname: input.host.hostname,
    username: input.host.username,
    command: input.command,
    commandHash: hashCommand(input.command),
    reason: input.reason,
    createdAt: new Date(now).toISOString(),
    expiresAtUnixMs: now + input.host.sudo.approvalTtlSeconds * 1000,
  };
  const directory = getApprovalDirectory();
  await fs.mkdir(directory, { recursive: true });
  const file = requestPath(request.requestId);
  await fs.writeFile(file, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
  const broker = getCredentialBrokerPath(input.settings);
  const approvalCommand = `"${broker}" approve --request-file "${file}"`;
  await writeAudit(input.settings, {
    timestamp: new Date().toISOString(),
    requestId: newRequestId(),
    tool: "sudo_request",
    host: input.hostAlias,
    command: input.command,
    operation: `pending approval ${request.requestId}; reason=${input.reason}`,
    success: true,
  });
  return { request, requestFile: file, approvalCommand };
}

export async function loadApprovalRequest(requestId: string): Promise<{ request: PendingApproval; file: string }> {
  if (!/^[a-fA-F0-9-]{36}$/.test(requestId)) {
    throw new Error("Invalid sudo request ID");
  }
  const file = requestPath(requestId);
  const request = JSON.parse(await fs.readFile(file, "utf8")) as PendingApproval;
  if (request.requestId !== requestId) throw new Error("Sudo request ID mismatch");
  if (request.expiresAtUnixMs <= Date.now()) throw new Error("Sudo request has expired");
  return { request, file };
}

export async function removeApprovalRequest(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}
