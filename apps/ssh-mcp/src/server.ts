import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { newRequestId, writeAudit } from "./audit.js";
import {
  brokerCredentialExists,
  brokerSshExecute,
  brokerSshPty,
  brokerSudoExecute,
  brokerTransfer,
} from "./broker.js";
import { ConfigStore, hostMutationAllowed, redactHost, validateHost } from "./config.js";
import { getLocalPathRoots } from "./paths.js";
import {
  assertComposeService,
  assertContainerName,
  assertLocalPathAllowed,
  assertRemotePathAllowed,
  buildComposeExecCommand,
  buildDockerExecCommand,
  buildRemoteScript,
  buildWindowsCommand,
  shellQuote,
} from "./policy.js";
import { Semaphore } from "./process.js";
import { assertCommandSafe } from "./safety.js";
import {
  buildEnvironmentProbeScript,
  buildWindowsEnvironmentProbeScript,
  parseEnvironmentProbe,
  runScp,
  runSsh,
  runSshPty,
} from "./ssh.js";
import type { ExecutionResult, GlobalSettings, HelixConfig, HostConfig } from "./types.js";

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwInvalid(error: unknown): never {
  if (error instanceof McpError) throw error;
  throw new McpError(ErrorCode.InvalidParams, errorMessage(error));
}

function mergeOptional<T extends Record<string, unknown>>(target: T, patch: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key as keyof T] = value as T[keyof T];
  }
  return target;
}

export function createServer(store = new ConfigStore()): McpServer {
  const server = new McpServer({ name: "helix-ssh", version: "0.3.0" });
  let limiter: Semaphore | null = null;
  let limiterSize = 0;

  const getLimiter = (settings: GlobalSettings): Semaphore => {
    if (!limiter || limiterSize !== settings.maxConcurrentCommands) {
      limiter = new Semaphore(settings.maxConcurrentCommands);
      limiterSize = settings.maxConcurrentCommands;
    }
    return limiter;
  };

  const auditExecution = async (input: {
    config: HelixConfig;
    requestId: string;
    tool: string;
    host?: string;
    command?: string;
    operation?: string;
    result?: ExecutionResult;
    success: boolean;
    error?: string;
  }): Promise<void> => {
    await writeAudit(input.config.settings, {
      timestamp: new Date().toISOString(),
      requestId: input.requestId,
      tool: input.tool,
      host: input.host,
      operation: input.operation,
      command: input.command,
      durationMs: input.result?.durationMs,
      exitCode: input.result?.exitCode,
      timedOut: input.result?.timedOut,
      truncated: input.result?.truncated,
      success: input.success,
      error: input.error,
    });
  };

  const executeRemote = async (input: {
    tool: string;
    hostAlias: string;
    command: string;
    timeoutSeconds?: number;
    operation?: string;
    pty?: { input?: string; cols?: number; rows?: number };
  }): Promise<ExecutionResult> => {
    const config = await store.read();
    const host = config.hosts[input.hostAlias];
    if (!host) throw new Error(`Unknown host alias: ${input.hostAlias}`);
    const requestId = newRequestId();
    try {
      const result = host.auth.type === "windows-credential"
        ? input.pty
          ? await brokerSshPty({
              settings: config.settings,
              hostAlias: input.hostAlias,
              host,
              command: input.command,
              timeoutSeconds: input.timeoutSeconds,
              cols: input.pty.cols,
              rows: input.pty.rows,
              input: input.pty.input,
            })
          : await brokerSshExecute({
              settings: config.settings,
              hostAlias: input.hostAlias,
              host,
              command: input.command,
              timeoutSeconds: input.timeoutSeconds,
            })
        : input.pty
          ? await runSshPty({
              host,
              settings: config.settings,
              command: input.command,
              timeoutSeconds: input.timeoutSeconds,
              input: input.pty.input,
              limiter: getLimiter(config.settings),
            })
          : await runSsh({
              host,
              settings: config.settings,
              command: input.command,
              timeoutSeconds: input.timeoutSeconds,
              limiter: getLimiter(config.settings),
            });
      await auditExecution({
        config,
        requestId,
        tool: input.tool,
        host: input.hostAlias,
        command: input.command,
        operation: input.operation,
        result,
        success: result.ok,
      });
      return result;
    } catch (error) {
      await auditExecution({
        config,
        requestId,
        tool: input.tool,
        host: input.hostAlias,
        command: input.command,
        operation: input.operation,
        success: false,
        error: errorMessage(error),
      });
      throw error;
    }
  };

  server.tool("host_list", "List configured SSH hosts with secrets redacted.", {}, async () => {
    const config = await store.read();
    return textResult({
      configPath: store.filePath,
      allowHostMutation: hostMutationAllowed(config),
      hosts: Object.fromEntries(Object.entries(config.hosts).map(([alias, host]) => [alias, redactHost(host)])),
    });
  });

  server.tool("host_get", "Read one configured SSH host with secrets redacted.", { host: z.string() }, async ({ host }) => {
    try { return textResult({ alias: host, host: redactHost(await store.getHost(host)) }); }
    catch (error) { throwInvalid(error); }
  });

  server.tool("host_add", "Add an SSH host. Harness mode enables host changes by default.", {
    alias: z.string(),
    hostname: z.string(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().optional(),
    identityFile: z.string().optional(),
    proxyJump: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    allowedRemotePaths: z.array(z.string()).optional(),
    defaultWorkingDir: z.string().optional(),
    os: z.enum(["unix", "windows"]).optional(),
    authType: z.enum(["openssh", "windows-credential"]).optional(),
    authCredentialRef: z.string().optional(),
    sudoMode: z.enum(["disabled", "reviewed-nopasswd", "reviewed-password"]).optional(),
    sudoCredentialRef: z.string().optional(),
    sudoAllow: z.array(z.string()).optional(),
    sudoApprovalTtlSeconds: z.number().int().min(30).max(3600).optional(),
  }, async (input) => {
    const current = await store.read();
    try {
      if (!hostMutationAllowed(current)) throw new Error("Host mutation is disabled by the deployment profile");
      if (current.hosts[input.alias]) throw new Error(`Host alias already exists: ${input.alias}`);
      const auth = input.authType === "windows-credential"
        ? { type: "windows-credential", credentialRef: input.authCredentialRef }
        : { type: "openssh" };
      const candidate: Record<string, unknown> = {
        hostname: input.hostname,
        os: input.os ?? "unix",
        port: input.port ?? 22,
        tags: input.tags ?? [],
        allowedRemotePaths: input.allowedRemotePaths ?? (input.os === "windows" ? ["C:\\helix"] : ["/tmp/helix"]),
        auth,
        sudo: {
          mode: input.sudoMode ?? (input.authType === "windows-credential" ? "reviewed-password" : "reviewed-nopasswd"),
          credentialRef: input.sudoCredentialRef,
          allow: input.sudoAllow ?? ["^.*$"],
          approvalTtlSeconds: input.sudoApprovalTtlSeconds ?? 300,
        },
      };
      mergeOptional(candidate, {
        username: input.username,
        identityFile: input.identityFile,
        proxyJump: input.proxyJump,
        defaultWorkingDir: input.defaultWorkingDir,
      });
      const host = validateHost(input.alias, candidate);
      await store.mutate((config) => { config.hosts[input.alias] = host; });
      return textResult({ alias: input.alias, host: redactHost(host) });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("host_update", "Update a configured SSH host. Harness mode permits policy changes by default.", {
    alias: z.string(),
    hostname: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().nullable().optional(),
    identityFile: z.string().nullable().optional(),
    proxyJump: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    allowedRemotePaths: z.array(z.string()).optional(),
    defaultWorkingDir: z.string().nullable().optional(),
    os: z.enum(["unix", "windows"]).optional(),
    authType: z.enum(["openssh", "windows-credential"]).optional(),
    authCredentialRef: z.string().nullable().optional(),
    sudoMode: z.enum(["disabled", "reviewed-nopasswd", "reviewed-password"]).optional(),
    sudoCredentialRef: z.string().nullable().optional(),
    sudoAllow: z.array(z.string()).optional(),
    sudoApprovalTtlSeconds: z.number().int().min(30).max(3600).optional(),
  }, async (input) => {
    const current = await store.read();
    try {
      if (!hostMutationAllowed(current)) throw new Error("Host mutation is disabled by the deployment profile");
      const existing = current.hosts[input.alias];
      if (!existing) throw new Error(`Unknown host alias: ${input.alias}`);
      const candidate = structuredClone(existing) as unknown as Record<string, unknown>;
      mergeOptional(candidate, {
        hostname: input.hostname,
        os: input.os,
        port: input.port,
        tags: input.tags,
        allowedRemotePaths: input.allowedRemotePaths,
      });
      for (const field of ["username", "identityFile", "proxyJump", "defaultWorkingDir"] as const) {
        const value = input[field];
        if (value === null) delete candidate[field];
        else if (value !== undefined) candidate[field] = value;
      }
      if (input.authType || input.authCredentialRef !== undefined) {
        const type = input.authType ?? existing.auth.type;
        candidate.auth = type === "windows-credential"
          ? { type, credentialRef: input.authCredentialRef ?? (existing.auth.type === "windows-credential" ? existing.auth.credentialRef : undefined) }
          : { type: "openssh" };
      }
      const sudo = { ...existing.sudo };
      if (input.sudoMode !== undefined) sudo.mode = input.sudoMode;
      if (input.sudoCredentialRef === null) delete sudo.credentialRef;
      else if (input.sudoCredentialRef !== undefined) sudo.credentialRef = input.sudoCredentialRef;
      if (input.sudoAllow !== undefined) sudo.allow = input.sudoAllow;
      if (input.sudoApprovalTtlSeconds !== undefined) sudo.approvalTtlSeconds = input.sudoApprovalTtlSeconds;
      candidate.sudo = sudo;
      const host = validateHost(input.alias, candidate);
      await store.mutate((config) => { config.hosts[input.alias] = host; });
      return textResult({ alias: input.alias, host: redactHost(host) });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("get_working_dir", "Read the persistent default working directory configured for a host.", {
    host: z.string(),
  }, async ({ host }) => {
    try {
      const hostConfig = await store.getHost(host);
      return textResult({ host, defaultWorkingDir: hostConfig.defaultWorkingDir ?? null });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("set_working_dir", "Set or clear the persistent default working directory for a host. Paths must be absolute and inside the host allowlist; ssh_exec, job_start, docker_exec and compose_exec use it when cwd is omitted.", {
    host: z.string(),
    path: z.string().min(1).nullable(),
  }, async ({ host, path }) => {
    try {
      const hostConfig = await store.getHost(host);
      if (path !== null) assertRemotePathAllowed(hostConfig, path);
      await store.mutate((config) => {
        const target = config.hosts[host];
        if (!target) throw new Error(`Unknown host alias: ${host}`);
        if (path === null) delete target.defaultWorkingDir;
        else target.defaultWorkingDir = path;
      });
      return textResult({ host, defaultWorkingDir: path });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("host_remove", "Remove a host configuration.", { host: z.string() }, async ({ host }) => {
    try {
      const current = await store.read();
      if (!hostMutationAllowed(current)) throw new Error("Host mutation is disabled by the deployment profile");
      if (!current.hosts[host]) throw new Error(`Unknown host alias: ${host}`);
      await store.mutate((config) => { delete config.hosts[host]; });
      return textResult({ removed: host });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("credential_status", "Check whether configured Windows credentials exist. Secret values are never returned.", {
    host: z.string(),
  }, async ({ host }) => {
    try {
      const config = await store.read();
      const hostConfig = config.hosts[host];
      if (!hostConfig) throw new Error(`Unknown host alias: ${host}`);
      const login = hostConfig.auth.type === "windows-credential"
        ? { credentialRef: hostConfig.auth.credentialRef, exists: await brokerCredentialExists(config.settings, hostConfig.auth.credentialRef) }
        : { type: "openssh", exists: null };
      const sudo = hostConfig.sudo.credentialRef
        ? { credentialRef: hostConfig.sudo.credentialRef, exists: await brokerCredentialExists(config.settings, hostConfig.sudo.credentialRef) }
        : { credentialRef: null, exists: null };
      return textResult({ host, login, sudo });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("ssh_check", "Check SSH connectivity with the configured authentication backend.", {
    host: z.string(),
    timeoutSeconds: z.number().int().min(1).max(120).optional(),
  }, async ({ host, timeoutSeconds }) => {
    try {
      const hostConfig = await store.getHost(host);
      return textResult(await executeRemote({
        tool: "ssh_check",
        hostAlias: host,
        command: hostConfig.os === "windows"
          ? buildWindowsCommand(hostConfig, "Write-Output 'helix-ssh-ok'")
          : "printf 'helix-ssh-ok\\n'",
        timeoutSeconds,
        operation: "connectivity check",
      }));
    } catch (error) { throwInvalid(error); }
  });

  server.tool("ssh_exec", "Execute a remote command. Sudo is not rejected, but use sudo_exec for password-backed sudo.", {
    host: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    sourceScripts: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async ({ host, command, cwd, env, sourceScripts, timeoutSeconds }) => {
    try {
      assertCommandSafe(command);
      const hostConfig = await store.getHost(host);
      const wrapped = hostConfig.os === "windows"
        ? buildWindowsCommand(hostConfig, command, { cwd, env, sourceScripts })
        : buildRemoteScript(hostConfig, command, { cwd, env, sourceScripts });
      return textResult(await executeRemote({
        tool: "ssh_exec",
        hostAlias: host,
        command: wrapped,
        timeoutSeconds,
        operation: command,
      }));
    } catch (error) { throwInvalid(error); }
  });

  server.tool("ssh_pty", "Execute a remote command under an allocated PTY (xterm). Use for TTY-dependent commands such as top, htop, bash -i, or interactive prompts; optional one-shot input is written to the PTY stdin. Note: PTY input is echoed back in the output, so never pass passwords or secrets via input; use sudo_exec or the credential flow for password-backed sudo.", {
    host: z.string(),
    command: z.string(),
    input: z.string().optional(),
    cols: z.number().int().min(1).max(1000).optional(),
    rows: z.number().int().min(1).max(1000).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async ({ host, command, input, cols, rows, timeoutSeconds }) => {
    try {
      assertCommandSafe(command);
      return textResult(await executeRemote({
        tool: "ssh_pty",
        hostAlias: host,
        command,
        timeoutSeconds,
        operation: command,
        pty: { input, cols, rows },
      }));
    } catch (error) { throwInvalid(error); }
  });

  server.tool("sudo_exec", "Execute a command directly with sudo. No allowlist, approval request, confirmation token, or expiry is used; only the Harness dangerous-command guard applies.", {
    host: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    sourceScripts: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async ({ host, command, cwd, env, sourceScripts, timeoutSeconds }) => {
    try {
      assertCommandSafe(command);
      const config = await store.read();
      const hostConfig = config.hosts[host];
      if (!hostConfig) throw new Error(`Unknown host alias: ${host}`);
      if (hostConfig.os === "windows") {
        throw new Error("sudo_exec is not supported on Windows hosts");
      }
      const wrapped = buildRemoteScript(hostConfig, command, { cwd, env, sourceScripts });
      if (hostConfig.auth.type === "windows-credential") {
        return textResult(await brokerSudoExecute({
          settings: config.settings,
          hostAlias: host,
          host: hostConfig,
          command: wrapped,
          timeoutSeconds,
        }));
      }
      return textResult(await executeRemote({
        tool: "sudo_exec",
        hostAlias: host,
        command: `sudo -n -- sh -lc ${shellQuote(wrapped)}`,
        timeoutSeconds,
        operation: command,
      }));
    } catch (error) { throwInvalid(error); }
  });

  const transfer = async (input: {
    direction: "upload" | "download";
    host: string;
    localPath: string;
    remotePath: string;
    recursive?: boolean;
    timeoutSeconds?: number;
  }): Promise<ExecutionResult> => {
    const config = await store.read();
    const hostConfig = config.hosts[input.host];
    if (!hostConfig) throw new Error(`Unknown host alias: ${input.host}`);
    const localPath = assertLocalPathAllowed(input.localPath, getLocalPathRoots());
    const remotePath = assertRemotePathAllowed(hostConfig, input.remotePath);
    if (hostConfig.auth.type === "windows-credential") {
      return await brokerTransfer({
        settings: config.settings,
        host: hostConfig,
        direction: input.direction,
        localPath,
        remotePath,
        recursive: input.recursive ?? false,
        timeoutSeconds: input.timeoutSeconds,
      });
    }
    return await runScp({
      direction: input.direction,
      host: hostConfig,
      settings: config.settings,
      localPath,
      remotePath,
      recursive: input.recursive ?? false,
      timeoutSeconds: input.timeoutSeconds,
      limiter: getLimiter(config.settings),
    });
  };

  server.tool("ssh_upload", "Upload a file or directory using SCP or broker SFTP.", {
    host: z.string(),
    localPath: z.string(),
    remotePath: z.string(),
    recursive: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async (input) => {
    try { return textResult(await transfer({ direction: "upload", ...input })); }
    catch (error) { throwInvalid(error); }
  });

  server.tool("ssh_download", "Download a file or directory using SCP or broker SFTP.", {
    host: z.string(),
    remotePath: z.string(),
    localPath: z.string(),
    recursive: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async (input) => {
    try { return textResult(await transfer({ direction: "download", ...input })); }
    catch (error) { throwInvalid(error); }
  });

  server.tool("docker_list", "List Docker containers.", {
    host: z.string(),
    all: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(300).optional(),
  }, async ({ host, all, timeoutSeconds }) => {
    try {
      const command = `docker ps ${all ? "-a " : ""}--format '{{json .}}'`;
      const result = await executeRemote({
        tool: "docker_list",
        hostAlias: host,
        command,
        timeoutSeconds,
        operation: "list Docker containers",
      });
      const containers = result.ok ? result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line) as unknown; } catch { return { raw: line }; }
      }) : [];
      return textResult({ ...result, containers });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("docker_exec", "Execute a command inside a Docker container.", {
    host: z.string(),
    container: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    sourceScripts: z.array(z.string()).optional(),
    user: z.string().optional(),
    shell: z.enum(["sh", "bash"]).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async ({ host, container, command, cwd, env, sourceScripts, user, shell, timeoutSeconds }) => {
    try {
      assertCommandSafe(command);
      const hostConfig = await store.getHost(host);
      assertContainerName(container);
      const wrapped = buildDockerExecCommand({ host: hostConfig, container, command, cwd, env, sourceScripts, user, shell });
      return textResult(await executeRemote({
        tool: "docker_exec",
        hostAlias: host,
        command: wrapped,
        timeoutSeconds,
        operation: `${container}: ${command}`,
      }));
    } catch (error) { throwInvalid(error); }
  });

  server.tool("compose_ps", "List Docker Compose services.", {
    host: z.string(),
    projectDir: z.string(),
    timeoutSeconds: z.number().int().min(1).max(300).optional(),
  }, async ({ host, projectDir, timeoutSeconds }) => {
    try {
      const safeProject = assertRemotePathAllowed(await store.getHost(host), projectDir);
      const command = `cd ${shellQuote(safeProject)} && docker compose ps --format json`;
      return textResult(await executeRemote({
        tool: "compose_ps",
        hostAlias: host,
        command,
        timeoutSeconds,
        operation: `compose ps in ${safeProject}`,
      }));
    } catch (error) { throwInvalid(error); }
  });

  server.tool("compose_exec", "Execute a command inside a Docker Compose service.", {
    host: z.string(),
    projectDir: z.string(),
    service: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    sourceScripts: z.array(z.string()).optional(),
    user: z.string().optional(),
    shell: z.enum(["sh", "bash"]).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async ({ host, projectDir, service, command, cwd, env, sourceScripts, user, shell, timeoutSeconds }) => {
    try {
      assertCommandSafe(command);
      const hostConfig = await store.getHost(host);
      assertComposeService(service);
      const wrapped = buildComposeExecCommand({ host: hostConfig, projectDir, service, command, cwd, env, sourceScripts, user, shell });
      return textResult(await executeRemote({
        tool: "compose_exec",
        hostAlias: host,
        command: wrapped,
        timeoutSeconds,
        operation: `${service}: ${command}`,
      }));
    } catch (error) { throwInvalid(error); }
  });

  server.tool("environment_probe", "Probe OS, architecture, tools, containers and source scripts.", {
    host: z.string(),
    timeoutSeconds: z.number().int().min(1).max(600).optional(),
  }, async ({ host, timeoutSeconds }) => {
    try {
      const hostConfig = await store.getHost(host);
      const result = await executeRemote({
        tool: "environment_probe",
        hostAlias: host,
        command: hostConfig.os === "windows"
          ? buildWindowsEnvironmentProbeScript(hostConfig)
          : buildEnvironmentProbeScript(hostConfig),
        timeoutSeconds,
        operation: "read-only environment discovery",
      });
      return textResult({ ...result, probe: result.ok ? parseEnvironmentProbe(result.stdout) : null });
    } catch (error) { throwInvalid(error); }
  });

  return server;
}
