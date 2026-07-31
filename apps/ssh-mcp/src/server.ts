import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { newRequestId, writeAudit } from "./audit.js";
import { createApprovalRequest, hashCommand, loadApprovalRequest, removeApprovalRequest } from "./approval.js";
import {
  brokerConsumeApproval,
  brokerCredentialExists,
  brokerSshExecute,
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
  assertSudoAllowed,
  buildComposeExecCommand,
  buildDockerExecCommand,
  buildRemoteScript,
  shellQuote,
} from "./policy.js";
import { Semaphore } from "./process.js";
import {
  buildEnvironmentProbeScript,
  parseEnvironmentProbe,
  runScp,
  runSsh,
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
  const server = new McpServer({ name: "helix-ssh", version: "0.2.0" });
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
  }): Promise<ExecutionResult> => {
    const config = await store.read();
    const host = config.hosts[input.hostAlias];
    if (!host) throw new Error(`Unknown host alias: ${input.hostAlias}`);
    const requestId = newRequestId();
    try {
      const result = host.auth.type === "windows-credential"
        ? await brokerSshExecute({
            settings: config.settings,
            hostAlias: input.hostAlias,
            host,
            command: input.command,
            timeoutSeconds: input.timeoutSeconds,
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

  server.tool("host_add", "Add an SSH host. Mutation must be enabled by an administrator.", {
    alias: z.string(),
    hostname: z.string(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().optional(),
    identityFile: z.string().optional(),
    proxyJump: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    allowedRemotePaths: z.array(z.string()).optional(),
    authType: z.enum(["openssh", "windows-credential"]).optional(),
    authCredentialRef: z.string().optional(),
    sudoMode: z.enum(["disabled", "reviewed-nopasswd", "reviewed-password"]).optional(),
    sudoCredentialRef: z.string().optional(),
    sudoAllow: z.array(z.string()).optional(),
    sudoApprovalTtlSeconds: z.number().int().min(30).max(3600).optional(),
  }, async (input) => {
    const current = await store.read();
    try {
      if (!hostMutationAllowed(current)) throw new Error("Host mutation is disabled");
      if (current.hosts[input.alias]) throw new Error(`Host alias already exists: ${input.alias}`);
      const auth = input.authType === "windows-credential"
        ? { type: "windows-credential", credentialRef: input.authCredentialRef }
        : { type: "openssh" };
      const candidate: Record<string, unknown> = {
        hostname: input.hostname,
        port: input.port ?? 22,
        tags: input.tags ?? [],
        allowedRemotePaths: input.allowedRemotePaths ?? ["/tmp/helix"],
        auth,
        sudo: {
          mode: input.sudoMode ?? "disabled",
          credentialRef: input.sudoCredentialRef,
          allow: input.sudoAllow ?? [],
          approvalTtlSeconds: input.sudoApprovalTtlSeconds ?? 300,
        },
      };
      mergeOptional(candidate, {
        username: input.username,
        identityFile: input.identityFile,
        proxyJump: input.proxyJump,
      });
      const host = validateHost(input.alias, candidate);
      await store.mutate((config) => { config.hosts[input.alias] = host; });
      return textResult({ alias: input.alias, host: redactHost(host) });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("host_update", "Update a configured SSH host.", {
    alias: z.string(),
    hostname: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().nullable().optional(),
    identityFile: z.string().nullable().optional(),
    proxyJump: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    allowedRemotePaths: z.array(z.string()).optional(),
    authType: z.enum(["openssh", "windows-credential"]).optional(),
    authCredentialRef: z.string().nullable().optional(),
    sudoMode: z.enum(["disabled", "reviewed-nopasswd", "reviewed-password"]).optional(),
    sudoCredentialRef: z.string().nullable().optional(),
    sudoAllow: z.array(z.string()).optional(),
    sudoApprovalTtlSeconds: z.number().int().min(30).max(3600).optional(),
  }, async (input) => {
    const current = await store.read();
    try {
      if (!hostMutationAllowed(current)) throw new Error("Host mutation is disabled");
      const existing = current.hosts[input.alias];
      if (!existing) throw new Error(`Unknown host alias: ${input.alias}`);
      const candidate = structuredClone(existing) as unknown as Record<string, unknown>;
      mergeOptional(candidate, {
        hostname: input.hostname,
        port: input.port,
        tags: input.tags,
        allowedRemotePaths: input.allowedRemotePaths,
      });
      for (const field of ["username", "identityFile", "proxyJump"] as const) {
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

  server.tool("host_remove", "Remove a host. Mutation must be enabled.", { host: z.string() }, async ({ host }) => {
    try {
      const current = await store.read();
      if (!hostMutationAllowed(current)) throw new Error("Host mutation is disabled");
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
      return textResult(await executeRemote({
        tool: "ssh_check",
        hostAlias: host,
        command: "printf 'helix-ssh-ok\\n'",
        timeoutSeconds,
        operation: "connectivity check",
      }));
    } catch (error) { throwInvalid(error); }
  });

  server.tool("ssh_exec", "Execute a remote command with optional cwd, env and source scripts.", {
    host: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    sourceScripts: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async ({ host, command, cwd, env, sourceScripts, timeoutSeconds }) => {
    try {
      const wrapped = buildRemoteScript(await store.getHost(host), command, { cwd, env, sourceScripts });
      return textResult(await executeRemote({
        tool: "ssh_exec",
        hostAlias: host,
        command: wrapped,
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

  server.tool("sudo_request", "Create an exact, expiring sudo request for local human approval.", {
    host: z.string(),
    command: z.string(),
    reason: z.string().min(1),
  }, async ({ host, command, reason }) => {
    try {
      const config = await store.read();
      const hostConfig = config.hosts[host];
      if (!hostConfig) throw new Error(`Unknown host alias: ${host}`);
      assertSudoAllowed(hostConfig, command);
      const approval = await createApprovalRequest({
        settings: config.settings,
        hostAlias: host,
        host: hostConfig,
        command,
        reason,
      });
      return textResult({
        request: approval.request,
        approvalCommand: approval.approvalCommand,
        nextStep: "Run approvalCommand in a local terminal, review the exact command, type APPROVE, then call sudo_execute with the same requestId and command.",
      });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("sudo_execute", "Execute an exact sudo request only after a local one-time human approval.", {
    host: z.string(),
    requestId: z.string(),
    command: z.string(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }, async ({ host, requestId, command, timeoutSeconds }) => {
    const config = await store.read();
    const hostConfig = config.hosts[host];
    if (!hostConfig) throwInvalid(new Error(`Unknown host alias: ${host}`));
    try {
      assertSudoAllowed(hostConfig, command);
      const { request, file } = await loadApprovalRequest(requestId);
      const commandHash = hashCommand(command);
      if (request.hostAlias !== host || request.command !== command || request.commandHash !== commandHash) {
        throw new Error("Host or command differs from the reviewed sudo request");
      }
      let result: ExecutionResult;
      if (hostConfig.sudo.mode === "reviewed-password") {
        result = await brokerSudoExecute({
          settings: config.settings,
          hostAlias: host,
          host: hostConfig,
          requestId,
          commandHash,
          command,
          timeoutSeconds,
        });
      } else if (hostConfig.sudo.mode === "reviewed-nopasswd") {
        await brokerConsumeApproval({ settings: config.settings, requestId, hostAlias: host, commandHash });
        const wrapped = `sudo -n -- sh -lc ${shellQuote(command)}`;
        result = await executeRemote({
          tool: "sudo_execute",
          hostAlias: host,
          command: wrapped,
          timeoutSeconds,
          operation: command,
        });
      } else {
        throw new Error("sudo is disabled for this host");
      }
      await removeApprovalRequest(file);
      return textResult(result);
    } catch (error) { throwInvalid(error); }
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

  server.tool("compose_exec", "Execute a command in a Docker Compose service.", {
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
        command: buildEnvironmentProbeScript(hostConfig),
        timeoutSeconds,
        operation: "read-only environment discovery",
      });
      return textResult({ ...result, probe: result.ok ? parseEnvironmentProbe(result.stdout) : null });
    } catch (error) { throwInvalid(error); }
  });

  return server;
}
