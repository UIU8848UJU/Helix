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
  allow: z.array(z.string()).default(["^.*$"]),
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
  sudo: sudoPolicySchema.default({ mode: "disabled", allow: ["^.*$"], approvalTtlSeconds: 300 }),
});

const settingsSchema = z.object({
  allowHostMutation: z.boolean().default(true),
  allowPolicyMutation: z.boolean().default(true),
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
      throw new Error(`Host ${hostAlias}: password sudo requires windows-credential SSH auth`);
    }
    if (!host.sudo.credentialRef) {
      throw new Error(`Host ${hostAlias}: password sudo requires sudo.credentialRef`);
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

function booleanOverride(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === "1" || value?.toLowerCase() === "true") return true;
  if (value === "0" || value?.toLowerCase() === "false") return false;
  return fallback;
}

export function hostMutationAllowed(config: HelixConfig): boolean {
  return booleanOverride("HELIX_ALLOW_HOST_MUTATION", config.settings.allowHostMutation);
}

export function policyMutationAllowed(config: HelixConfig): boolean {
  return booleanOverride("HELIX_ALLOW_POLICY_MUTATION", config.settings.allowPolicyMutation);
}

export function safeLifecycleRemotePaths(username?: string): string[] {
  const paths = ["/workspace", "/tmp/helix", "/opt/ros"];
  if (username) paths.unshift(`/home/${username}`);
  return paths;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addedValues(before: string[], after: string[]): string[] {
  const existing = new Set(before);
  return after.filter((value) => !existing.has(value));
}

function collectHostPolicyExpansions(
  alias: string,
  before: HostConfig | undefined,
  after: HostConfig | undefined,
): string[] {
  if (!after) return [];

  const changes: string[] = [];
  const safePaths = new Set(safeLifecycleRemotePaths(after.username));
  const standardLoginRef = `Helix/ssh/${alias}/login`;
  const standardSudoRef = `Helix/ssh/${alias}/sudo`;

  if (!before) {
    const unsafePaths = after.allowedRemotePaths.filter((value) => !safePaths.has(value));
    if (unsafePaths.length) changes.push(`${alias}.allowedRemotePaths(+${unsafePaths.join(",")})`);
    if (after.auth.type === "windows-credential" && after.auth.credentialRef !== standardLoginRef) {
      changes.push(`${alias}.auth.credentialRef`);
    }
    if (after.sudo.credentialRef && after.sudo.credentialRef !== standardSudoRef) {
      changes.push(`${alias}.sudo.credentialRef`);
    }
    if (after.sudo.allow.length) changes.push(`${alias}.sudo.allow`);
    if (after.sudo.approvalTtlSeconds > 300) changes.push(`${alias}.sudo.approvalTtlSeconds`);
    return changes;
  }

  const newPaths = addedValues(before.allowedRemotePaths, after.allowedRemotePaths)
    .filter((value) => !safePaths.has(value));
  if (newPaths.length) changes.push(`${alias}.allowedRemotePaths(+${newPaths.join(",")})`);

  if (!sameValue(before.auth, after.auth)) changes.push(`${alias}.auth`);

  const addedSudoRules = addedValues(before.sudo.allow, after.sudo.allow);
  if (addedSudoRules.length) changes.push(`${alias}.sudo.allow`);

  if (after.sudo.credentialRef !== before.sudo.credentialRef) {
    changes.push(`${alias}.sudo.credentialRef`);
  }

  if (after.sudo.approvalTtlSeconds > before.sudo.approvalTtlSeconds) {
    changes.push(`${alias}.sudo.approvalTtlSeconds`);
  }

  const modeExpansion = before.sudo.mode === "disabled" && after.sudo.mode !== "disabled" && after.sudo.allow.length > 0;
  const nopasswdExpansion = before.sudo.mode === "reviewed-password" && after.sudo.mode === "reviewed-nopasswd" && after.sudo.allow.length > 0;
  if (modeExpansion || nopasswdExpansion) changes.push(`${alias}.sudo.mode`);

  return changes;
}

export function collectPolicyExpansions(before: HelixConfig, after: HelixConfig): string[] {
  const changes: string[] = [];
  const aliases = new Set([...Object.keys(before.hosts), ...Object.keys(after.hosts)]);
  for (const alias of aliases) {
    changes.push(...collectHostPolicyExpansions(alias, before.hosts[alias], after.hosts[alias]));
  }

  if (before.settings.strictHostKeyChecking && !after.settings.strictHostKeyChecking) {
    changes.push("settings.strictHostKeyChecking");
  }
  if (before.settings.auditEnabled && !after.settings.auditEnabled) {
    changes.push("settings.auditEnabled");
  }
  return [...new Set(changes)];
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
    const before = await this.read();
    const config = structuredClone(before);
    mutator(config);
    const validated = validateConfig(config);
    const policyExpansions = collectPolicyExpansions(before, validated);
    if (policyExpansions.length && !policyMutationAllowed(before)) {
      throw new Error(
        `Policy mutation is disabled by the deployment profile. `
        + `Requested policy expansion: ${policyExpansions.join(", ")}.`,
      );
    }
    await this.write(validated);
    return validated;
  }
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
