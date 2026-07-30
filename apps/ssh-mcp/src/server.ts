import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { newRequestId, writeAudit } from "./audit.js";
import {
  ConfigStore,
  hostMutationAllowed,
  redactHost,
  validateHost,
} from "./config.js";
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
import { probeEnvironment, runScp, runSsh } from "./ssh.js";
import type {
  ExecutionResult,
  GlobalSettings,
  HelixConfig,
  HostConfig,
} from "./types.js";

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwInvalid(error: unknown): never {
  if (error instanceof McpError) {
    throw error;
  }
  throw new McpError(ErrorCode.InvalidParams, errorMessage(error));
}

function publicHostConfig(host: HostConfig): Record<string, unknown> {
  return redactHost(host);
}

function mergeOptional<T extends Record<string, unknown>>(
  target: T,
  patch: Record<string, unknown>,
): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      target[key as keyof T] = value as T[keyof T];
    }
  }
  return target;
}

export function createServer(store = new ConfigStore()): McpServer {
  const server = new McpServer({
    name: "helix-ssh",
    version: "0.1.0",
  });

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
    if (!host) {
      throw new Error(`Unknown host alias: ${input.hostAlias}`);
    }
    const requestId = newRequestId();
    try {
      const result = await runSsh({
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

  server.tool(
    "host_list",
    "List configured SSH host aliases and redacted host settings.",
    {},
    async () => {
      const config = await store.read();
      return textResult({
        configPath: store.filePath,
        allowHostMutation: hostMutationAllowed(config),
        hosts: Object.fromEntries(
          Object.entries(config.hosts).map(([alias, host]) => [alias, publicHostConfig(host)]),
        ),
      });
    },
  );

  server.tool(
    "host_get",
    "Read one configured SSH host. Private key paths are redacted.",
    { host: z.string() },
    async ({ host }) => {
      try {
        return textResult({ alias: host, host: publicHostConfig(await store.getHost(host)) });
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "host_add",
    "Add a host to the Helix SSH configuration. Host mutation must be explicitly enabled.",
    {
      alias: z.string(),
      hostname: z.string(),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().optional(),
      identityFile: z.string().optional(),
      proxyJump: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      allowedRemotePaths: z.array(z.string()).optional(),
      sudoEnabled: z.boolean().optional(),
      sudoAllow: z.array(z.string()).optional(),
    },
    async (input) => {
      const requestId = newRequestId();
      const current = await store.read();
      try {
        if (!hostMutationAllowed(current)) {
          throw new Error("Host mutation is disabled. Set HELIX_ALLOW_HOST_MUTATION=1 or settings.allowHostMutation=true");
        }
        if (current.hosts[input.alias]) {
          throw new Error(`Host alias already exists: ${input.alias}`);
        }
        const candidate: Record<string, unknown> = {
          hostname: input.hostname,
          port: input.port ?? 22,
          tags: input.tags ?? [],
          allowedRemotePaths: input.allowedRemotePaths ?? ["/tmp/helix"],
          sudo: {
            enabled: input.sudoEnabled ?? false,
            allow: input.sudoAllow ?? [],
          },
        };
        mergeOptional(candidate, {
          username: input.username,
          identityFile: input.identityFile,
          proxyJump: input.proxyJump,
        });
        const host = validateHost(input.alias, candidate);
        await store.mutate((config) => {
          config.hosts[input.alias] = host;
        });
        await auditExecution({
          config: current,
          requestId,
          tool: "host_add",
          host: input.alias,
          operation: `add ${input.hostname}`,
          success: true,
        });
        return textResult({ alias: input.alias, host: publicHostConfig(host) });
      } catch (error) {
        await auditExecution({
          config: current,
          requestId,
          tool: "host_add",
          host: input.alias,
          success: false,
          error: errorMessage(error),
        });
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "host_update",
    "Update a configured host. Pass null for username, identityFile or proxyJump to clear it.",
    {
      alias: z.string(),
      hostname: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().nullable().optional(),
      identityFile: z.string().nullable().optional(),
      proxyJump: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      allowedRemotePaths: z.array(z.string()).optional(),
      sudoEnabled: z.boolean().optional(),
      sudoAllow: z.array(z.string()).optional(),
    },
    async (input) => {
      const requestId = newRequestId();
      const current = await store.read();
      try {
        if (!hostMutationAllowed(current)) {
          throw new Error("Host mutation is disabled. Set HELIX_ALLOW_HOST_MUTATION=1 or settings.allowHostMutation=true");
        }
        const existing = current.hosts[input.alias];
        if (!existing) {
          throw new Error(`Unknown host alias: ${input.alias}`);
        }
        const candidate: Record<string, unknown> = structuredClone(existing) as unknown as Record<string, unknown>;
        mergeOptional(candidate, {
          hostname: input.hostname,
          port: input.port,
          tags: input.tags,
          allowedRemotePaths: input.allowedRemotePaths,
        });
        for (const field of ["username", "identityFile", "proxyJump"] as const) {
          const value = input[field];
          if (value === null) {
            delete candidate[field];
          } else if (value !== undefined) {
            candidate[field] = value;
          }
        }
        const sudo = { ...existing.sudo };
        if (input.sudoEnabled !== undefined) sudo.enabled = input.sudoEnabled;
        if (input.sudoAllow !== undefined) sudo.allow = input.sudoAllow;
        candidate.sudo = sudo;
        const host = validateHost(input.alias, candidate);
        await store.mutate((config) => {
          config.hosts[input.alias] = host;
        });
        await auditExecution({
          config: current,
          requestId,
          tool: "host_update",
          host: input.alias,
          operation: "update host configuration",
          success: true,
        });
        return textResult({ alias: input.alias, host: publicHostConfig(host) });
      } catch (error) {
        await auditExecution({
          config: current,
          requestId,
          tool: "host_update",
          host: input.alias,
          success: false,
          error: errorMessage(error),
        });
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "host_remove",
    "Remove a configured host. Host mutation must be explicitly enabled.",
    { host: z.string() },
    async ({ host }) => {
      const requestId = newRequestId();
      const current = await store.read();
      try {
        if (!hostMutationAllowed(current)) {
          throw new Error("Host mutation is disabled. Set HELIX_ALLOW_HOST_MUTATION=1 or settings.allowHostMutation=true");
        }
        if (!current.hosts[host]) {
          throw new Error(`Unknown host alias: ${host}`);
        }
        await store.mutate((config) => {
          delete config.hosts[host];
        });
        await auditExecution({
          config: current,
          requestId,
          tool: "host_remove",
          host,
          operation: "remove host configuration",
          success: true,
        });
        return textResult({ removed: host });
      } catch (error) {
        await auditExecution({
          config: current,
          requestId,
          tool: "host_remove",
          host,
          success: false,
          error: errorMessage(error),
        });
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "ssh_check",
    "Check SSH connectivity using non-interactive BatchMode authentication.",
    {
      host: z.string(),
      timeoutSeconds: z.number().int().min(1).max(120).optional(),
    },
    async ({ host, timeoutSeconds }) => {
      try {
        const result = await executeRemote({
          tool: "ssh_check",
          hostAlias: host,
          command: "printf 'helix-ssh-ok\\n'",
          timeoutSeconds,
          operation: "connectivity check",
        });
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "ssh_exec",
    "Execute a remote command with optional cwd, environment variables and source scripts.",
    {
      host: z.string(),
      command: z.string(),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      sourceScripts: z.array(z.string()).optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    },
    async ({ host, command, cwd, env, sourceScripts, timeoutSeconds }) => {
      try {
        const hostConfig = await store.getHost(host);
        const wrapped = buildRemoteScript(hostConfig, command, { cwd, env, sourceScripts });
        const result = await executeRemote({
          tool: "ssh_exec",
          hostAlias: host,
          command: wrapped,
          timeoutSeconds,
          operation: command,
        });
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "ssh_upload",
    "Upload a local file or directory to an allowed remote path using scp.",
    {
      host: z.string(),
      localPath: z.string(),
      remotePath: z.string(),
      recursive: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    },
    async ({ host, localPath, remotePath, recursive, timeoutSeconds }) => {
      const config = await store.read();
      const hostConfig = config.hosts[host];
      if (!hostConfig) throwInvalid(new Error(`Unknown host alias: ${host}`));
      const requestId = newRequestId();
      try {
        const safeLocal = assertLocalPathAllowed(localPath, getLocalPathRoots());
        const safeRemote = assertRemotePathAllowed(hostConfig, remotePath);
        const result = await runScp({
          direction: "upload",
          host: hostConfig,
          settings: config.settings,
          localPath: safeLocal,
          remotePath: safeRemote,
          recursive: recursive ?? false,
          timeoutSeconds,
          limiter: getLimiter(config.settings),
        });
        await auditExecution({
          config,
          requestId,
          tool: "ssh_upload",
          host,
          operation: `${safeLocal} -> ${safeRemote}`,
          result,
          success: result.ok,
        });
        return textResult(result);
      } catch (error) {
        await auditExecution({
          config,
          requestId,
          tool: "ssh_upload",
          host,
          success: false,
          error: errorMessage(error),
        });
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "ssh_download",
    "Download a remote file or directory from an allowed path using scp.",
    {
      host: z.string(),
      remotePath: z.string(),
      localPath: z.string(),
      recursive: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    },
    async ({ host, remotePath, localPath, recursive, timeoutSeconds }) => {
      const config = await store.read();
      const hostConfig = config.hosts[host];
      if (!hostConfig) throwInvalid(new Error(`Unknown host alias: ${host}`));
      const requestId = newRequestId();
      try {
        const safeRemote = assertRemotePathAllowed(hostConfig, remotePath);
        const safeLocal = assertLocalPathAllowed(localPath, getLocalPathRoots());
        const result = await runScp({
          direction: "download",
          host: hostConfig,
          settings: config.settings,
          localPath: safeLocal,
          remotePath: safeRemote,
          recursive: recursive ?? false,
          timeoutSeconds,
          limiter: getLimiter(config.settings),
        });
        await auditExecution({
          config,
          requestId,
          tool: "ssh_download",
          host,
          operation: `${safeRemote} -> ${safeLocal}`,
          result,
          success: result.ok,
        });
        return textResult(result);
      } catch (error) {
        await auditExecution({
          config,
          requestId,
          tool: "ssh_download",
          host,
          success: false,
          error: errorMessage(error),
        });
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "sudo_exec",
    "Execute a sudo command that completely matches the host allowlist. Uses sudo -n only.",
    {
      host: z.string(),
      command: z.string(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    },
    async ({ host, command, timeoutSeconds }) => {
      try {
        const hostConfig = await store.getHost(host);
        assertSudoAllowed(hostConfig, command);
        const wrapped = `sudo -n -- sh -lc ${shellQuote(command)}`;
        const result = await executeRemote({
          tool: "sudo_exec",
          hostAlias: host,
          command: wrapped,
          timeoutSeconds,
          operation: command,
        });
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "docker_list",
    "List Docker containers on a configured host.",
    {
      host: z.string(),
      all: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
    },
    async ({ host, all, timeoutSeconds }) => {
      try {
        const command = `docker ps ${all ? "-a " : ""}--format '{{json .}}'`;
        const result = await executeRemote({
          tool: "docker_list",
          hostAlias: host,
          command,
          timeoutSeconds,
          operation: "list Docker containers",
        });
        const containers = result.ok
          ? result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
              try { return JSON.parse(line) as unknown; } catch { return { raw: line }; }
            })
          : [];
        return textResult({ ...result, containers });
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "docker_exec",
    "Execute a command inside an existing Docker container, with cwd/env/source support.",
    {
      host: z.string(),
      container: z.string(),
      command: z.string(),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      sourceScripts: z.array(z.string()).optional(),
      user: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    },
    async ({ host, container, command, cwd, env, sourceScripts, user, timeoutSeconds }) => {
      try {
        const hostConfig = await store.getHost(host);
        assertContainerName(container);
        const wrapped = buildDockerExecCommand({
          host: hostConfig,
          container,
          command,
          cwd,
          env,
          sourceScripts,
          user,
        });
        const result = await executeRemote({
          tool: "docker_exec",
          hostAlias: host,
          command: wrapped,
          timeoutSeconds,
          operation: `${container}: ${command}`,
        });
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "compose_ps",
    "List Docker Compose services from an allowed remote project directory.",
    {
      host: z.string(),
      projectDir: z.string(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
    },
    async ({ host, projectDir, timeoutSeconds }) => {
      try {
        const hostConfig = await store.getHost(host);
        const safeProject = assertRemotePathAllowed(hostConfig, projectDir);
        const command = `cd ${shellQuote(safeProject)} && docker compose ps --format json`;
        const result = await executeRemote({
          tool: "compose_ps",
          hostAlias: host,
          command,
          timeoutSeconds,
          operation: `compose ps in ${safeProject}`,
        });
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "compose_exec",
    "Execute a command in a Docker Compose service with cwd/env/source support.",
    {
      host: z.string(),
      projectDir: z.string(),
      service: z.string(),
      command: z.string(),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      sourceScripts: z.array(z.string()).optional(),
      user: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    },
    async ({ host, projectDir, service, command, cwd, env, sourceScripts, user, timeoutSeconds }) => {
      try {
        const hostConfig = await store.getHost(host);
        assertComposeService(service);
        const wrapped = buildComposeExecCommand({
          host: hostConfig,
          projectDir,
          service,
          command,
          cwd,
          env,
          sourceScripts,
          user,
        });
        const result = await executeRemote({
          tool: "compose_exec",
          hostAlias: host,
          command: wrapped,
          timeoutSeconds,
          operation: `${service}: ${command}`,
        });
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "environment_probe",
    "Probe OS, architecture, shell, toolchains, Docker containers and candidate source scripts.",
    {
      host: z.string(),
      timeoutSeconds: z.number().int().min(1).max(600).optional(),
    },
    async ({ host, timeoutSeconds }) => {
      const config = await store.read();
      const hostConfig = config.hosts[host];
      if (!hostConfig) throwInvalid(new Error(`Unknown host alias: ${host}`));
      const requestId = newRequestId();
      try {
        const { result, probe } = await probeEnvironment({
          host: hostConfig,
          settings: config.settings,
          timeoutSeconds,
          limiter: getLimiter(config.settings),
        });
        await auditExecution({
          config,
          requestId,
          tool: "environment_probe",
          host,
          operation: "read-only environment discovery",
          result,
          success: result.ok,
        });
        return textResult({ ...result, probe });
      } catch (error) {
        await auditExecution({
          config,
          requestId,
          tool: "environment_probe",
          host,
          success: false,
          error: errorMessage(error),
        });
        throwInvalid(error);
      }
    },
  );

  return server;
}
