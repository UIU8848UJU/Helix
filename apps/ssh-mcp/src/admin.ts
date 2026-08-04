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

export function buildCredentialAdminCommand(input: {
  scriptPath: string;
  configPath: string;
  action: "set" | "status" | "delete";
  host?: string;
  kind?: "all" | "login" | "sudo";
  credentialRefs?: string[];
  separatePasswords?: boolean;
}): string {
  const args = [
    "powershell",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    powershellQuote(input.scriptPath),
    "credential",
    input.action,
    "-ConfigPath",
    powershellQuote(input.configPath),
  ];
  if (input.host) args.push("-Host", powershellQuote(input.host));
  if (input.kind) args.push("-Kind", input.kind);
  if (input.credentialRefs?.length) {
    args.push("-CredentialRef", input.credentialRefs.map(powershellQuote).join(","));
  }
  if (input.separatePasswords) args.push("-SeparatePasswords");
  return args.join(" ");
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

export function registerAdminTools(server: McpServer, store: ConfigStore): void {
  server.tool(
    "mutation_capabilities",
    "Report the two mutation tiers. Normal host lifecycle is enabled by default; security-policy expansion is separately locked by default.",
    {},
    async () => {
      const config = await store.read();
      return textResult({
        hostLifecycle: {
          allowed: hostMutationAllowed(config),
          operations: [
            "host_onboard and host_offboard",
            "change hostname, port, username, identityFile, proxyJump, and tags",
            "use standard per-host credential references",
            "use lifecycle-safe paths under the user home, /workspace, /tmp/helix, and /opt/ros",
            "enroll, check, and request deletion of credentials",
          ],
        },
        policyMutation: {
          allowed: policyMutationAllowed(config),
          protectedChanges: [
            "add remote paths outside lifecycle-safe defaults",
            "add sudo allowlist rules",
            "replace authentication or credential references on an existing host",
            "increase sudo approval TTL",
            "disable strict host-key checking or auditing",
          ],
        },
        guidance: "Use host_onboard for new hosts. Safe lifecycle operations should not ask the user to edit JSON. Only request policy authorization when the exact protected change is necessary.",
      });
    },
  );

  server.tool(
    "host_onboard",
    "Preferred host creation workflow. Normal lifecycle onboarding is enabled by default, generates standard credential references, and uses useful safe paths. Only custom policy expansion requires allowPolicyMutation.",
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
      sudoMode: z.enum(["disabled", "reviewed-nopasswd", "reviewed-password"]).optional(),
      sudoAllow: z.array(z.string()).optional(),
      sudoApprovalTtlSeconds: z.number().int().min(30).max(3600).optional(),
    },
    async (input) => {
      try {
        const current = await store.read();
        if (!hostMutationAllowed(current)) {
          throw new Error("Host lifecycle mutation is disabled by the deployment profile");
        }
        if (current.hosts[input.alias]) throw new Error(`Host alias already exists: ${input.alias}`);

        const defaultAuthType = process.platform === "win32" ? "windows-credential" : "openssh";
        const authType = input.authType ?? defaultAuthType;
        const sudoMode = input.sudoMode
          ?? (authType === "windows-credential" ? "reviewed-password" : "disabled");
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
          auth: authType === "windows-credential"
            ? { type: "windows-credential" as const, credentialRef: loginCredentialRef }
            : { type: "openssh" as const },
          sudo: {
            mode: sudoMode,
            credentialRef: sudoMode === "reviewed-password" ? sudoCredentialRef : undefined,
            allow: input.sudoAllow ?? [],
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
          mutationTier: "host-lifecycle",
          credentialRefs: refs,
          credentialsStored: false,
        };
        if (scriptPath) {
          result.nextStep = "Call credential_enroll_request, show the returned enrollmentCommand to the user, and stop until local enrollment is complete.";
          result.enrollmentCommand = buildCredentialAdminCommand({
            scriptPath,
            configPath: store.filePath,
            action: "set",
            host: input.alias,
            kind: "all",
          });
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
    "Normal lifecycle host removal. Removes only non-secret host configuration and returns a separate local cleanup command for orphaned credentials; credentials are never deleted automatically.",
    {
      host: z.string(),
    },
    async ({ host }) => {
      try {
        const current = await store.read();
        if (!hostMutationAllowed(current)) {
          throw new Error("Host lifecycle mutation is disabled by the deployment profile");
        }
        const existing = current.hosts[host];
        if (!existing) throw new Error(`Unknown host alias: ${host}`);
        const refs = Object.values(credentialRefsForHost(existing)).filter((value): value is string => Boolean(value));
        const scriptPath = refs.length ? await requireAdminScript(store) : null;
        await store.mutate((config) => { delete config.hosts[host]; });

        const result: Record<string, unknown> = {
          removed: host,
          mutationTier: "host-lifecycle",
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
          result.nextStep = "Ask the user whether to run cleanupCommand locally. Do not infer permission to delete stored credentials.";
        }
        return textResult(result);
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "credential_enroll_request",
    "Create a local, interactive credential enrollment command. The AI must show enrollmentCommand and STOP; passwords are entered once in the local Broker terminal and never pass through MCP or chat.",
    {
      host: z.string(),
      kind: z.enum(["all", "login", "sudo"]).optional(),
      separatePasswords: z.boolean().optional(),
    },
    async ({ host, kind, separatePasswords }) => {
      try {
        const hostConfig = await store.getHost(host);
        const refs = credentialRefsForHost(hostConfig);
        const selectedKind = kind ?? "all";
        if (selectedKind === "login" && !refs.login) throw new Error(`Host ${host} does not use a managed login credential`);
        if (selectedKind === "sudo" && !refs.sudo) throw new Error(`Host ${host} has no managed sudo credential`);
        if (selectedKind === "all" && !refs.login && !refs.sudo) throw new Error(`Host ${host} has no managed credentials`);
        const scriptPath = await requireAdminScript(store);
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
          nextStep: "Show enrollmentCommand to the user and STOP. After the user confirms completion, call credential_status and then ssh_check.",
        });
      } catch (error) {
        throwInvalid(error);
      }
    },
  );

  server.tool(
    "credential_delete_request",
    "Create a local credential deletion command. The AI must show cleanupCommand and wait for explicit user approval; secret deletion is not performed through MCP.",
    {
      host: z.string(),
      kind: z.enum(["all", "login", "sudo"]).optional(),
    },
    async ({ host, kind }) => {
      try {
        const hostConfig = await store.getHost(host);
        const refs = credentialRefsForHost(hostConfig);
        const selectedKind = kind ?? "all";
        if (selectedKind === "login" && !refs.login) throw new Error(`Host ${host} does not use a managed login credential`);
        if (selectedKind === "sudo" && !refs.sudo) throw new Error(`Host ${host} has no managed sudo credential`);
        if (selectedKind === "all" && !refs.login && !refs.sudo) throw new Error(`Host ${host} has no managed credentials`);
        const scriptPath = await requireAdminScript(store);
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
          nextStep: "Show cleanupCommand and wait for explicit user confirmation before they run it locally.",
        });
      } catch (error) {
        throwInvalid(error);
      }
    },
  );
}
