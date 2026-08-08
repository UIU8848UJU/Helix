import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ConfigStore,
  hostMutationAllowed,
  policyMutationAllowed,
  redactHost,
  safeLifecycleRemotePaths,
  validateHost,
} from "./config.js";
import type { HostConfig } from "./types.js";

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

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function resolveAdminScriptPath(store: ConfigStore): string {
  return process.env.HELIX_ADMIN_SCRIPT
    ?? path.join(path.dirname(store.filePath), "helix-admin.ps1");
}

export function credentialRefsForHost(host: HostConfig): { login: string | null; sudo: string | null } {
  return {
    login: host.auth.type === "windows-credential" ? host.auth.credentialRef : null,
    sudo: host.sudo.credentialRef ?? null,
  };
}

export function buildCredentialAdminArgs(input: {
  scriptPath: string;
  configPath: string;
  action: "set" | "status" | "delete";
  host?: string;
  kind?: "all" | "login" | "sudo";
  credentialRefs?: string[];
  separatePasswords?: boolean;
}): string[] {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    input.scriptPath,
    "credential",
    input.action,
    "-ConfigPath",
    input.configPath,
  ];
  if (input.host) args.push("-Host", input.host);
  if (input.kind) args.push("-Kind", input.kind);
  if (input.credentialRefs?.length) args.push("-CredentialRef", input.credentialRefs.join(","));
  if (input.separatePasswords) args.push("-SeparatePasswords");
  return args;
}

export function buildCredentialAdminCommand(input: Parameters<typeof buildCredentialAdminArgs>[0]): string {
  const args = buildCredentialAdminArgs(input);
  return ["powershell", ...args.map((value, index) => {
    const previous = args[index - 1];
    return previous?.startsWith("-") && !value.includes(" ") ? value : powershellQuote(value);
  })].join(" ");
}

export function launchCredentialWindow(input: Parameters<typeof buildCredentialAdminArgs>[0]): { pid: number | null } {
  if (process.platform !== "win32") {
    throw new Error("Interactive credential windows are only available on Windows");
  }
  const executable = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(executable, buildCredentialAdminArgs(input), {
    shell: false,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return { pid: child.pid ?? null };
}

async function requireAdminScript(store: ConfigStore): Promise<string> {
  const scriptPath = resolveAdminScriptPath(store);
  try {
    await fs.access(scriptPath);
  } catch {
    throw new Error(`Helix admin script was not found: ${scriptPath}. Re-run scripts\\install.ps1.`);
  }
  return scriptPath;
}

async function enrollmentContext(store: ConfigStore, host: string, kind: "all" | "login" | "sudo") {
  const hostConfig = await store.getHost(host);
  const refs = credentialRefsForHost(hostConfig);
  if (kind === "login" && !refs.login) throw new Error(`Host ${host} does not use a managed login credential`);
  if (kind === "sudo" && !refs.sudo) throw new Error(`Host ${host} has no managed sudo credential`);
  if (kind === "all" && !refs.login && !refs.sudo) throw new Error(`Host ${host} has no managed credentials`);
  return { refs, scriptPath: await requireAdminScript(store) };
}

export function registerAdminTools(server: McpServer, store: ConfigStore): void {
  server.tool(
    "mutation_capabilities",
    "Report the active deployment profile. Personal/Harness mode enables host and policy changes by default; EnterpriseLocked can disable them.",
    {},
    async () => {
      const config = await store.read();
      return textResult({
        hostMutation: hostMutationAllowed(config),
        policyMutation: policyMutationAllowed(config),
        sudoExecution: "direct through sudo_exec; no allowlist approval, token, confirmation, or expiry",
        commandGuard: "blocks a small built-in set of destructive commands such as rm, filesystem formatting, block-device writes, reboot, and fork bombs",
        credentialEnrollment: process.platform === "win32"
          ? "host_onboard opens a local PowerShell credential window automatically"
          : "use credential_enroll_request on non-Windows hosts",
      });
    },
  );

  server.tool(
    "host_onboard",
    "Preferred one-stop host creation. Creates standard credentials and opens a local Windows password-entry window automatically by default.",
    {
      alias: z.string(),
      hostname: z.string(),
      username: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional(),
      authType: z.enum(["openssh", "windows-credential"]).optional(),
      identityFile: z.string().optional(),
      proxyJump: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      allowedRemotePaths: z.array(z.string()).min(1).optional(),
      defaultWorkingDir: z.string().optional(),
      sudoMode: z.enum(["disabled", "reviewed-nopasswd", "reviewed-password"]).optional(),
      sudoAllow: z.array(z.string()).optional(),
      sudoApprovalTtlSeconds: z.number().int().min(30).max(3600).optional(),
      launchCredentialWindow: z.boolean().optional(),
      separatePasswords: z.boolean().optional(),
    },
    async (input) => {
      try {
        const current = await store.read();
        if (!hostMutationAllowed(current)) {
          throw new Error("Host mutation is disabled by the deployment profile");
        }
        if (current.hosts[input.alias]) throw new Error(`Host alias already exists: ${input.alias}`);

        const defaultAuthType = process.platform === "win32" ? "windows-credential" : "openssh";
        const authType = input.authType ?? defaultAuthType;
        const sudoMode = input.sudoMode
          ?? (authType === "windows-credential" ? "reviewed-password" : "reviewed-nopasswd");
        const loginCredentialRef = `Helix/ssh/${input.alias}/login`;
        const sudoCredentialRef = `Helix/ssh/${input.alias}/sudo`;

        const candidate = {
          hostname: input.hostname,
          port: input.port ?? 22,
          username: input.username,
          identityFile: input.identityFile,
          proxyJump: input.proxyJump,
          tags: input.tags ?? [],
          allowedRemotePaths: input.allowedRemotePaths ?? safeLifecycleRemotePaths(input.username),
          defaultWorkingDir: input.defaultWorkingDir,
          auth: authType === "windows-credential"
            ? { type: "windows-credential" as const, credentialRef: loginCredentialRef }
            : { type: "openssh" as const },
          sudo: {
            mode: sudoMode,
            credentialRef: sudoMode === "reviewed-password" ? sudoCredentialRef : undefined,
            allow: input.sudoAllow ?? ["^.*$"],
            approvalTtlSeconds: input.sudoApprovalTtlSeconds ?? 300,
          },
        };

        const host = validateHost(input.alias, candidate);
        const refs = credentialRefsForHost(host);
        const scriptPath = refs.login || refs.sudo ? await requireAdminScript(store) : null;
        await store.mutate((config) => { config.hosts[input.alias] = host; });

        const result: Record<string, unknown> = {
          alias: input.alias,
          host: redactHost(host),
          credentialRefs: refs,
          credentialsStored: false,
        };
        if (scriptPath) {
          const enrollmentInput = {
            scriptPath,
            configPath: store.filePath,
            action: "set" as const,
            host: input.alias,
            kind: "all" as const,
            separatePasswords: input.separatePasswords ?? false,
          };
          const shouldLaunch = process.platform === "win32" && (input.launchCredentialWindow ?? true);
          if (shouldLaunch) {
            const launched = launchCredentialWindow(enrollmentInput);
            result.credentialWindowLaunched = true;
            result.windowProcessId = launched.pid;
            result.nextStep = "Tell the user to enter the password in the opened local PowerShell window. After they confirm completion, call credential_status and ssh_check.";
          } else {
            result.credentialWindowLaunched = false;
            result.enrollmentCommand = buildCredentialAdminCommand(enrollmentInput);
            result.nextStep = "Run credential_enroll_launch on Windows, or show enrollmentCommand on a headless/non-Windows environment.";
          }
        } else {
          result.nextStep = "Call ssh_check. OpenSSH authentication uses the configured local SSH agent or identity file.";
        }
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "host_offboard",
    "Remove non-secret host configuration and return optional credential cleanup information.",
    { host: z.string() },
    async ({ host }) => {
      try {
        const current = await store.read();
        if (!hostMutationAllowed(current)) throw new Error("Host mutation is disabled by the deployment profile");
        const existing = current.hosts[host];
        if (!existing) throw new Error(`Unknown host alias: ${host}`);
        const refs = Object.values(credentialRefsForHost(existing)).filter((value): value is string => Boolean(value));
        const scriptPath = refs.length ? await requireAdminScript(store) : null;
        await store.mutate((config) => { delete config.hosts[host]; });

        const result: Record<string, unknown> = {
          removed: host,
          credentialsDeleted: false,
          orphanedCredentials: refs,
        };
        if (scriptPath) {
          result.cleanupCommand = buildCredentialAdminCommand({
            scriptPath,
            configPath: store.filePath,
            action: "delete",
            credentialRefs: refs,
          });
        }
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "credential_enroll_launch",
    "Open a visible local PowerShell window for credential input. The password remains outside MCP and chat.",
    {
      host: z.string(),
      kind: z.enum(["all", "login", "sudo"]).optional(),
      separatePasswords: z.boolean().optional(),
    },
    async ({ host, kind, separatePasswords }) => {
      try {
        const selectedKind = kind ?? "all";
        const { refs, scriptPath } = await enrollmentContext(store, host, selectedKind);
        const launched = launchCredentialWindow({
          scriptPath,
          configPath: store.filePath,
          action: "set",
          host,
          kind: selectedKind,
          separatePasswords: separatePasswords ?? false,
        });
        return textResult({
          launched: true,
          host,
          kind: selectedKind,
          credentialRefs: refs,
          windowProcessId: launched.pid,
          nextStep: "The local password window is open. After the user confirms completion, call credential_status and ssh_check.",
        });
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "credential_enroll_request",
    "Return a fallback credential enrollment command for headless or non-Windows environments.",
    {
      host: z.string(),
      kind: z.enum(["all", "login", "sudo"]).optional(),
      separatePasswords: z.boolean().optional(),
    },
    async ({ host, kind, separatePasswords }) => {
      try {
        const selectedKind = kind ?? "all";
        const { refs, scriptPath } = await enrollmentContext(store, host, selectedKind);
        return textResult({
          host,
          kind: selectedKind,
          credentialRefs: refs,
          enrollmentCommand: buildCredentialAdminCommand({
            scriptPath,
            configPath: store.filePath,
            action: "set",
            host,
            kind: selectedKind,
            separatePasswords: separatePasswords ?? false,
          }),
          passwordPrompts: separatePasswords ? "one prompt per selected credential" : "one prompt reused for all selected credentials",
        });
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "credential_delete_request",
    "Return a local credential deletion command. Secret values are never exposed.",
    {
      host: z.string(),
      kind: z.enum(["all", "login", "sudo"]).optional(),
    },
    async ({ host, kind }) => {
      try {
        const selectedKind = kind ?? "all";
        const { scriptPath } = await enrollmentContext(store, host, selectedKind);
        return textResult({
          host,
          kind: selectedKind,
          cleanupCommand: buildCredentialAdminCommand({
            scriptPath,
            configPath: store.filePath,
            action: "delete",
            host,
            kind: selectedKind,
          }),
        });
      } catch (error) {
        throwInvalid(error);
      }
    },
  );
}
