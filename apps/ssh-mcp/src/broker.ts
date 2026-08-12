import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { BrokerResponse, ExecutionResult, GlobalSettings, HostConfig } from "./types.js";
import { getCredentialBrokerPath } from "./paths.js";
import { newRequestId, writeAudit } from "./audit.js";

const BROKER_PROTOCOL_VERSION = 1;
const BROKER_ENDPOINT = process.platform === "win32"
  ? "\\\\.\\pipe\\helix-credential-broker-v1"
  : "/tmp/helix-credential-broker-v1.sock";

type BrokerTaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface BrokerDaemonResponse {
  ok: boolean;
  protocolVersion?: number;
  taskId?: string;
  state?: BrokerTaskState;
  result?: BrokerResponse;
  cancelRequested?: boolean;
  workers?: number;
  queuedTasks?: number;
  runningTasks?: number;
  pooledSessions?: number;
  error?: string;
}

let daemonStartInFlight: Promise<void> | null = null;
let autoEnrollInFlight: Promise<boolean> | null = null;

const AUTO_ENROLL_WAIT_MS = 120_000;

const CREDENTIAL_ERROR_MARKERS = [
  "credential not found",
  "ssh password authentication failed",
  "ssh server rejected the credential",
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isCredentialError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return CREDENTIAL_ERROR_MARKERS.some((marker) => message.includes(marker));
}

function credentialRefFromError(error: unknown): string | null {
  const ref = /credential not found:\s*(\S+)/i.exec(errorMessage(error))?.[1];
  return ref ? ref.replace(/[:\s]+$/, "") : null;
}

export function buildBrokerCredentialUiArgs(input: {
  username: string;
  credentialRefs: string[];
  separatePasswords?: boolean;
}): string[] {
  const args = ["credential-ui", "--username", input.username];
  for (const ref of input.credentialRefs) args.push("--target", ref);
  if (input.separatePasswords) args.push("--separate-passwords");
  return args;
}

function credentialRefsList(host: HostConfig): string[] {
  const refs: string[] = [];
  if (host.auth.type === "windows-credential" && host.auth.credentialRef) {
    refs.push(host.auth.credentialRef);
  }
  if (host.sudo.credentialRef) {
    refs.push(host.sudo.credentialRef);
  }
  return [...new Set(refs)];
}

function credentialRefsForEnrollment(host: HostConfig, error: unknown): string[] {
  const all = credentialRefsList(host);
  const missing = credentialRefFromError(error);
  if (missing) {
    return all.filter((ref) => ref === missing);
  }
  // Authentication failures happen while opening the SSH session, so the login
  // credential is the one that needs to be re-entered. Never clobber a
  // separate sudo password that was not involved in the failure.
  const login = host.auth.type === "windows-credential" ? host.auth.credentialRef : null;
  return login ? all.filter((ref) => ref === login) : all;
}

async function credentialExists(settings: GlobalSettings, credentialRef: string): Promise<boolean> {
  const response = await runBroker(
    settings,
    { op: "credential_exists", credential_ref: credentialRef },
    10,
  );
  return response.exists === true;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export interface AutoEnrollOptions {
  settings: GlobalSettings;
  host: HostConfig;
  hostAlias: string;
  waitMs?: number;
}

export async function autoEnrollHost(options: AutoEnrollOptions, credentialRefs: string[]): Promise<boolean> {
  const username = options.host.username;
  if (!username || username.trim().length === 0 || credentialRefs.length === 0) {
    return false;
  }
  const brokerPath = getCredentialBrokerPath(options.settings);
  try {
    await fs.access(brokerPath);
  } catch {
    return false;
  }
  const child = spawn(
    brokerPath,
    buildBrokerCredentialUiArgs({
      username,
      credentialRefs,
      separatePasswords: false,
    }),
    {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  const exitCode = await waitForExit(child, options.waitMs ?? AUTO_ENROLL_WAIT_MS);
  if (exitCode === null || exitCode !== 0) {
    return false;
  }
  try {
    const results = await Promise.all(
      credentialRefs.map((ref) => credentialExists(options.settings, ref)),
    );
    return results.every(Boolean);
  } catch {
    return false;
  }
}

export async function withCredentialAutoEnroll<T>(
  options: AutoEnrollOptions & { enroll?: (credentialRefs: string[]) => Promise<boolean> },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (process.platform !== "win32" || !isCredentialError(error)) {
      throw error;
    }
    if (options.host.auth.type !== "windows-credential") {
      throw error;
    }
    const refs = credentialRefsForEnrollment(options.host, error);
    if (refs.length === 0) {
      throw error;
    }
    const enroll = options.enroll ?? ((enrollRefs: string[]) => {
      if (!autoEnrollInFlight) {
        autoEnrollInFlight = autoEnrollHost(options, enrollRefs).finally(() => {
          autoEnrollInFlight = null;
        });
      }
      return autoEnrollInFlight;
    });
    const enrolled = await enroll(refs);
    if (!enrolled) {
      throw new Error(
        `Credential auto-enrollment did not complete for ${options.hostAlias}: ${errorMessage(error)}`,
      );
    }
    return await run();
  }
}

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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function daemonRpc(
  request: Record<string, unknown>,
  timeoutMs = 2_000,
): Promise<BrokerDaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(BROKER_ENDPOINT);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Credential broker IPC timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const payload = buffer.slice(0, newline).trim();
      finish(() => {
        try {
          const response = JSON.parse(payload) as BrokerDaemonResponse;
          if (!response.ok) {
            reject(new Error(response.error ?? "Credential broker daemon request failed"));
            return;
          }
          resolve(response);
        } catch (error) {
          reject(new Error(`Invalid credential broker daemon response: ${String(error)}`));
        }
      });
    });
    socket.on("error", (error) => {
      finish(() => reject(error));
    });
    socket.on("end", () => {
      if (!settled && !buffer.includes("\n")) {
        finish(() => reject(new Error("Credential broker IPC closed before a complete response")));
      }
    });
  });
}

function assertProtocolCompatible(response: BrokerDaemonResponse): void {
  if (response.protocolVersion !== BROKER_PROTOCOL_VERSION) {
    throw new Error(
      `Credential broker protocol mismatch: expected ${BROKER_PROTOCOL_VERSION}, `
      + `got ${String(response.protocolVersion ?? "unknown")}`,
    );
  }
}

async function pingDaemon(timeoutMs = 500): Promise<BrokerDaemonResponse> {
  const response = await daemonRpc({ op: "ping" }, timeoutMs);
  assertProtocolCompatible(response);
  return response;
}

async function waitForDaemonExit(): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await daemonRpc({ op: "ping" }, 250);
      await sleep(100);
    } catch {
      return true;
    }
  }
  return false;
}

async function stopIncompatibleDaemon(response: BrokerDaemonResponse): Promise<void> {
  const actual = response.protocolVersion ?? "unknown";
  try {
    await daemonRpc({ op: "shutdown" }, 1_000);
  } catch (error) {
    throw new Error(
      `Credential broker protocol mismatch: expected ${BROKER_PROTOCOL_VERSION}, got ${String(actual)}. `
      + `The old daemon could not be stopped automatically: ${String(error)}`,
    );
  }
  if (!await waitForDaemonExit()) {
    throw new Error(
      `Credential broker protocol mismatch: expected ${BROKER_PROTOCOL_VERSION}, got ${String(actual)}. `
      + "The old daemon accepted shutdown but did not exit.",
    );
  }
}

async function startBrokerDaemon(settings: GlobalSettings): Promise<void> {
  const executable = getCredentialBrokerPath(settings);
  await fs.access(executable).catch(() => {
    throw new Error(`Helix credential broker was not found: ${executable}`);
  });

  const workers = Math.max(1, settings.maxConcurrentCommands);
  const queueCapacity = Math.max(32, workers * 16);
  const child = spawn(executable, [
    "serve-daemon",
    "--endpoint", BROKER_ENDPOINT,
    "--workers", String(workers),
    "--queue-capacity", String(queueCapacity),
    "--task-retention-seconds", "600",
    "--session-idle-seconds", "120",
    "--max-idle-sessions-per-key", "2",
  ], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pingDaemon(500);
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`Credential broker daemon did not become ready: ${String(lastError)}`);
}

async function ensureBrokerDaemon(settings: GlobalSettings): Promise<void> {
  let existing: BrokerDaemonResponse | null = null;
  try {
    existing = await daemonRpc({ op: "ping" }, 500);
  } catch {
    // No daemon is currently listening. Start it below.
  }

  if (existing) {
    if (existing.protocolVersion === BROKER_PROTOCOL_VERSION) return;
    await stopIncompatibleDaemon(existing);
  }

  if (!daemonStartInFlight) {
    daemonStartInFlight = startBrokerDaemon(settings).finally(() => {
      daemonStartInFlight = null;
    });
  }
  await daemonStartInFlight;
}

export async function brokerDaemonStatus(settings: GlobalSettings): Promise<BrokerDaemonResponse> {
  await ensureBrokerDaemon(settings);
  return await pingDaemon();
}

export async function runBroker(
  settings: GlobalSettings,
  request: Record<string, unknown>,
  timeoutSeconds = settings.defaultTimeoutSeconds,
): Promise<BrokerResponse> {
  await ensureBrokerDaemon(settings);
  const submitted = await daemonRpc({ op: "submit", request });
  assertProtocolCompatible(submitted);
  const taskId = submitted.taskId;
  if (!taskId) throw new Error("Credential broker daemon did not return a taskId");

  const deadline = Date.now() + timeoutSeconds * 1000;
  let delayMs = 50;
  while (Date.now() < deadline) {
    const status = await daemonRpc({ op: "task_status", task_id: taskId });
    assertProtocolCompatible(status);
    switch (status.state) {
      case "succeeded":
        if (!status.result) throw new Error(`Credential broker task ${taskId} completed without a result`);
        return status.result;
      case "failed":
        throw new Error(status.result?.error ?? status.error ?? `Credential broker task ${taskId} failed`);
      case "cancelled":
        throw new Error(`Credential broker task ${taskId} was cancelled`);
      case "queued":
      case "running":
        await sleep(delayMs);
        delayMs = Math.min(250, Math.round(delayMs * 1.5));
        break;
      default:
        throw new Error(`Credential broker task ${taskId} returned invalid state: ${String(status.state)}`);
    }
  }

  await daemonRpc({ op: "task_cancel", task_id: taskId }).catch(() => undefined);
  throw new Error(`Credential broker task ${taskId} timed out after ${timeoutSeconds}s`);
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
  return withCredentialAutoEnroll(input, async () => {
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
  });
}

export async function brokerSudoExecute(input: {
  settings: GlobalSettings;
  hostAlias: string;
  host: HostConfig;
  command: string;
  timeoutSeconds?: number;
}): Promise<ExecutionResult> {
  return withCredentialAutoEnroll(input, async () => {
    const auth = passwordAuth(input.host);
    if (!input.host.sudo.credentialRef) {
      throw new Error("Password-backed sudo requires sudo.credentialRef");
    }
    const timeout = input.timeoutSeconds ?? input.settings.defaultTimeoutSeconds;
    const requestId = newRequestId();
    const startedAt = Date.now();
    const response = await runBroker(input.settings, {
      op: "sudo_execute",
      login_credential_ref: auth.credentialRef,
      sudo_credential_ref: input.host.sudo.credentialRef,
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
      tool: "sudo_exec",
      host: input.hostAlias,
      command: input.command,
      operation: "direct sudo",
      durationMs: result.durationMs || Date.now() - startedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      success: result.ok,
    });
    return result;
  });
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
  return withCredentialAutoEnroll(
    { settings: input.settings, host: input.host, hostAlias: input.host.hostname },
    async () => {
      const auth = passwordAuth(input.host);
      const timeout = input.timeoutSeconds ?? input.settings.defaultTimeoutSeconds;
      const requestId = newRequestId();
      const startedAt = Date.now();
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
    },
  );
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
