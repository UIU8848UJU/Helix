import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { BrokerResponse, ExecutionResult, GlobalSettings, HostConfig } from "./types.js";
import { getCredentialBrokerPath } from "./paths.js";
import { newRequestId, writeAudit } from "./audit.js";

function responseToExecution(response: BrokerResponse): ExecutionResult {
  return {
    ok: response.ok,
    exitCode: response.exitCode ?? (response.ok ? 0 : null),
    signal: null,
    stdout: response.stdout ?? "",
    stderr: response.stderr ?? response.error ?? "",
    timedOut: response.timedOut ?? false,
    truncated: response.truncated ?? false,
    durationMs: response.durationMs ?? 0,
  };
}

export async function runBroker(
  settings: GlobalSettings,
  request: Record<string, unknown>,
  timeoutSeconds = settings.defaultTimeoutSeconds,
): Promise<BrokerResponse> {
  const executable = getCredentialBrokerPath(settings);
  await fs.access(executable).catch(() => {
    throw new Error(`Helix credential broker was not found: ${executable}`);
  });

  return await new Promise<BrokerResponse>((resolve, reject) => {
    const child = spawn(executable, ["serve-once"], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
        settled = true;
        reject(new Error(`Credential broker timed out after ${timeoutSeconds}s`));
      }
    }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const response = JSON.parse(stdout.trim()) as BrokerResponse;
        if (!response.ok) {
          reject(new Error(response.error ?? (stderr.trim() || "Credential broker operation failed")));
          return;
        }
        resolve(response);
      } catch (error) {
        reject(new Error(`Invalid credential broker response: ${String(error)}; stderr=${stderr.trim()}`));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function passwordAuth(host: HostConfig): { credentialRef: string } {
  if (host.auth.type !== "windows-credential") {
    throw new Error("Host is not configured for Windows credential authentication");
  }
  return { credentialRef: host.auth.credentialRef };
}

export async function brokerSshExecute(input: {
  settings: GlobalSettings;
  hostAlias: string;
  host: HostConfig;
  command: string;
  timeoutSeconds?: number;
}): Promise<ExecutionResult> {
  const auth = passwordAuth(input.host);
  const timeout = input.timeoutSeconds ?? input.settings.defaultTimeoutSeconds;
  const response = await runBroker(input.settings, {
    op: "ssh_execute",
    credential_ref: auth.credentialRef,
    host: input.host.hostname,
    port: input.host.port ?? 22,
    username: input.host.username,
    command: input.command,
    timeout_seconds: timeout,
    max_output_bytes: input.settings.maxOutputBytes,
    strict_host_key_checking: input.settings.strictHostKeyChecking,
  }, timeout + 5);
  return responseToExecution(response);
}

export async function brokerTransfer(input: {
  settings: GlobalSettings;
  host: HostConfig;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  recursive: boolean;
  timeoutSeconds?: number;
}): Promise<ExecutionResult> {
  const auth = passwordAuth(input.host);
  const timeout = input.timeoutSeconds ?? input.settings.defaultTimeoutSeconds;
  const requestId = newRequestId();
  const startedAt = Date.now();
  try {
    const response = await runBroker(input.settings, {
      op: input.direction === "upload" ? "sftp_upload" : "sftp_download",
      credential_ref: auth.credentialRef,
      host: input.host.hostname,
      port: input.host.port ?? 22,
      username: input.host.username,
      local_path: input.localPath,
      remote_path: input.remotePath,
      recursive: input.recursive,
      timeout_seconds: timeout,
      strict_host_key_checking: input.settings.strictHostKeyChecking,
    }, timeout + 5);
    const result = responseToExecution(response);
    await writeAudit(input.settings, {
      timestamp: new Date().toISOString(),
      requestId,
      tool: input.direction === "upload" ? "ssh_upload" : "ssh_download",
      host: input.host.hostname,
      operation: `${input.localPath} ${input.direction === "upload" ? "->" : "<-"} ${input.remotePath}`,
      durationMs: result.durationMs || Date.now() - startedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      success: result.ok,
    });
    return result;
  } catch (error) {
    await writeAudit(input.settings, {
      timestamp: new Date().toISOString(),
      requestId,
      tool: input.direction === "upload" ? "ssh_upload" : "ssh_download",
      host: input.host.hostname,
      operation: `${input.localPath} ${input.direction === "upload" ? "->" : "<-"} ${input.remotePath}`,
      durationMs: Date.now() - startedAt,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function brokerCredentialExists(
  settings: GlobalSettings,
  credentialRef: string,
): Promise<boolean> {
  const response = await runBroker(settings, {
    op: "credential_exists",
    credential_ref: credentialRef,
  }, 15);
  return response.exists ?? false;
}

export async function brokerConsumeApproval(input: {
  settings: GlobalSettings;
  requestId: string;
  hostAlias: string;
  commandHash: string;
}): Promise<void> {
  await runBroker(input.settings, {
    op: "approval_consume",
    request_id: input.requestId,
    host_alias: input.hostAlias,
    command_hash: input.commandHash,
  }, 15);
}

export async function brokerSudoExecute(input: {
  settings: GlobalSettings;
  hostAlias: string;
  host: HostConfig;
  requestId: string;
  commandHash: string;
  command: string;
  timeoutSeconds?: number;
}): Promise<ExecutionResult> {
  const auth = passwordAuth(input.host);
  if (!input.host.sudo.credentialRef) {
    throw new Error("reviewed-password sudo requires sudo.credentialRef");
  }
  const timeout = input.timeoutSeconds ?? input.settings.defaultTimeoutSeconds;
  const requestId = newRequestId();
  const startedAt = Date.now();
  try {
    const response = await runBroker(input.settings, {
      op: "sudo_execute_approved",
      login_credential_ref: auth.credentialRef,
      sudo_credential_ref: input.host.sudo.credentialRef,
      request_id: input.requestId,
      host_alias: input.hostAlias,
      command_hash: input.commandHash,
      host: input.host.hostname,
      port: input.host.port ?? 22,
      username: input.host.username,
      command: input.command,
      timeout_seconds: timeout,
      max_output_bytes: input.settings.maxOutputBytes,
      strict_host_key_checking: input.settings.strictHostKeyChecking,
    }, timeout + 5);
    const result = responseToExecution(response);
    await writeAudit(input.settings, {
      timestamp: new Date().toISOString(),
      requestId,
      tool: "sudo_execute",
      host: input.hostAlias,
      command: input.command,
      operation: `approved request ${input.requestId}`,
      durationMs: result.durationMs || Date.now() - startedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      success: result.ok,
    });
    return result;
  } catch (error) {
    await writeAudit(input.settings, {
      timestamp: new Date().toISOString(),
      requestId,
      tool: "sudo_execute",
      host: input.hostAlias,
      command: input.command,
      operation: `approved request ${input.requestId}`,
      durationMs: Date.now() - startedAt,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
