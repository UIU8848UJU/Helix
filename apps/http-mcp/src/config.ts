import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { HttpConfig } from "./types.js";

const configSchema = z.object({
  version: z.literal(1).default(1), allowedDomains: z.array(z.string().min(1)).default([]),
  allowPrivateNetworks: z.boolean().default(false), allowHttp: z.boolean().default(true),
  allowHttps: z.boolean().default(true), maxResponseBytes: z.number().int().min(1).max(100 * 1024 * 1024).default(1024 * 1024),
  defaultTimeoutSeconds: z.number().min(0.1).max(300).default(15), maxRedirects: z.number().int().min(0).max(20).default(3), auditEnabled: z.boolean().default(true),
});
export const defaultConfig: HttpConfig = configSchema.parse({});
export function validateConfig(value: unknown): HttpConfig {
  const parsed = configSchema.parse(value) as HttpConfig;
  return { ...parsed, allowedDomains: parsed.allowedDomains.map((domain) => domain.toLowerCase().replace(/\.$/, "")) };
}
function defaultConfigPath(): string {
  const root = process.env.HELIX_HTTP_CONFIG_HOME ?? (process.platform === "win32" ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  return path.join(root, "Helix", "http-mcp.json");
}
export class ConfigStore {
  readonly filePath: string;
  constructor(filePath = process.env.HELIX_HTTP_CONFIG ?? defaultConfigPath()) { this.filePath = filePath; }
  async read(): Promise<HttpConfig> {
    try { return validateConfig(JSON.parse(await fs.readFile(this.filePath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaultConfig); throw error; }
  }
}
