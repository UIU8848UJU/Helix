import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfigPath } from "./paths.js";
import type { BrowserConfig } from "./types.js";

const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

const settingsSchema = z.object({
  headless: z.boolean().default(true),
  defaultTimeoutSeconds: z.number().int().min(1).max(60).default(20),
  maxReadBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(204800),
  auditEnabled: z.boolean().default(true),
});

const storageStateSchema = z.object({
  domain: z.string().min(1).regex(domainPattern),
  path: z.string().min(1),
});

const configSchema = z.object({
  version: z.literal(1).default(1),
  settings: settingsSchema.default({}),
  allowedDomains: z.array(z.string().min(1).regex(domainPattern)).default([]),
  storageStates: z.array(storageStateSchema).default([]),
});

export const defaultConfig: BrowserConfig = configSchema.parse({
  version: 1,
  settings: {},
  allowedDomains: [],
  storageStates: [],
});

export function validateConfig(input: unknown): BrowserConfig {
  const parsed = configSchema.parse(input) as BrowserConfig;
  for (const mapping of parsed.storageStates) {
    if (!path.posix.isAbsolute(mapping.path) && !path.win32.isAbsolute(mapping.path)) {
      throw new Error(`storageState path must be absolute: ${mapping.path}`);
    }
  }
  const seen = new Set<string>();
  for (const mapping of parsed.storageStates) {
    const key = mapping.domain.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate storageState domain: ${mapping.domain}`);
    seen.add(key);
  }
  return parsed;
}

export class ConfigStore {
  readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath = getConfigPath()) { this.filePath = filePath; }

  async read(): Promise<BrowserConfig> {
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

  async write(config: BrowserConfig): Promise<void> {
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
}