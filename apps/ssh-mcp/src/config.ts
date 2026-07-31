import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfigPath } from "./paths.js";
import type { HelixConfig, HostConfig } from "./types.js";

const aliasPattern = /^[a-zA-Z0-9._-]+$/;

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("openssh") }),
  z.object({
    type: z.literal("windows-credential"),
    credentialRef: z.string().min(1),
  }),
]);

const sudoPolicySchema = z.object({
  mode: z.enum(["disabled", "reviewed-nopasswd", "reviewed-password"]).default("disabled"),
  credentialRef: z.string().min(1).optional(),
  allow: z.array(z.string()).default([]),
  approvalTtlSeconds: z.number().int().min(30).max(3600).default(300),
});

const hostSchema = z.object({
  hostname: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).optional(),
  identityFile: z.string().min(1).optional(),
  proxyJump: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)).default([]),
  allowedRemotePaths: z.array(z.string().min(1)).min(1).default(["/tmp/helix"]),
  auth: authSchema.default({ type: "openssh" }),
  sudo: sudoPolicySchema.default({ mode: "disabled", allow: [], approvalTtlSeconds: 300 }),
});

const settingsSchema = z.object({
  allowHostMutation: z.boolean().default(false),
  defaultTimeoutSeconds: z.number().int().min(1).max(3600).default(60),
  maxOutputBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(1024 * 1024),
  maxConcurrentCommands: z.number().int().min(1).max(64).default(4),
  strictHostKeyChecking: z.boolean().default(true),
  auditEnabled: z.boolean().default(true),
  auditCommandMode: z.enum(["plain", "hash"]).default("plain"),
  credentialBrokerPath: z.string().min(1).nullable().optional(),
});

const configSchema = z.object({
  version: z.literal(1).default(1),
  settings: settingsSchema.default({}),
  hosts: z.record(hostSchema).default({}),
});

export const defaultConfig: HelixConfig = configSchema.parse({ version: 1, settings: {}, hosts: {} });

function validateSudoPatterns(hostAlias: string, host: HostConfig): void {
  for (const pattern of host.sudo.allow) {
    if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
      throw new Error(`Host ${hostAlias}: sudo allow pattern must start with ^ and end with $: ${pattern}`);
    }
    try { void new RegExp(pattern); } catch (error) {
      throw new Error(`Host ${hostAlias}: invalid sudo regular expression ${pattern}: ${String(error)}`);
    }
  }
  if (host.sudo.mode === "reviewed-password") {
    if (host.auth.type !== "windows-credential") {
      throw new Error(`Host ${hostAlias}: reviewed-password sudo requires windows-credential SSH auth`);
    }
    if (!host.sudo.credentialRef) {
      throw new Error(`Host ${hostAlias}: reviewed-password sudo requires sudo.credentialRef`);
    }
  }
}

export function validateConfig(input: unknown): HelixConfig {
  const parsed = configSchema.parse(input) as HelixConfig;
  for (const [alias, host] of Object.entries(parsed.hosts)) {
    if (!aliasPattern.test(alias)) throw new Error(`Invalid host alias: ${alias}`);
    validateSudoPatterns(alias, host);
  }
  return parsed;
}

export function validateHostAlias(alias: string): void {
  if (!aliasPattern.test(alias)) {
    throw new Error("Host alias may only contain letters, digits, dot, underscore and dash");
  }
}

export function validateHost(hostAlias: string, input: unknown): HostConfig {
  validateHostAlias(hostAlias);
  const parsed = hostSchema.parse(input) as HostConfig;
  validateSudoPatterns(hostAlias, parsed);
  return parsed;
}

export class ConfigStore {
  readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath = getConfigPath()) { this.filePath = filePath; }

  async read(): Promise<HelixConfig> {
    try {
      return validateConfig(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.write(defaultConfig);
        return structuredClone(defaultConfig);
      }
      throw error;
    }
  }

  async write(config: HelixConfig): Promise<void> {
    const validated = validateConfig(config);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      if (process.platform !== "win32") await fs.chmod(this.filePath, 0o600);
    });
    return this.writeChain;
  }

  async getHost(alias: string): Promise<HostConfig> {
    validateHostAlias(alias);
    const host = (await this.read()).hosts[alias];
    if (!host) throw new Error(`Unknown host alias: ${alias}`);
    return host;
  }

  async mutate(mutator: (config: HelixConfig) => void): Promise<HelixConfig> {
    const config = await this.read();
    mutator(config);
    const validated = validateConfig(config);
    await this.write(validated);
    return validated;
  }
}

export function hostMutationAllowed(config: HelixConfig): boolean {
  return config.settings.allowHostMutation || process.env.HELIX_ALLOW_HOST_MUTATION === "1";
}

export function redactHost(host: HostConfig): Record<string, unknown> {
  return {
    hostname: host.hostname,
    port: host.port ?? 22,
    username: host.username ?? null,
    identityFile: host.identityFile ? "configured" : null,
    proxyJump: host.proxyJump ?? null,
    tags: host.tags ?? [],
    allowedRemotePaths: host.allowedRemotePaths,
    auth: host.auth,
    sudo: host.sudo,
  };
}
