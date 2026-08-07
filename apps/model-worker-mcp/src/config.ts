import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ModelWorkerConfig } from "./types.js";

const settingsSchema = z.object({
  claudeCommand: z.string().min(1).default("claude"),
  gptCommand: z.string().min(1).default("codex"),
  allowedWorkingDirectories: z.array(z.string().min(1)).min(1),
  defaultWorkingDirectory: z.string().min(1),
  defaultTimeoutSeconds: z.number().int().min(1).max(3600).default(300),
  maxTimeoutSeconds: z.number().int().min(1).max(7200).default(1800),
  maxOutputBytes: z.number().int().min(4096).max(16 * 1024 * 1024).default(1024 * 1024),
  maxPromptChars: z.number().int().min(1).max(1_000_000).default(200_000),
  maxConcurrentWorkers: z.number().int().min(1).max(16).default(2),
  auditEnabled: z.boolean().default(true),
  auditPath: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (value.defaultTimeoutSeconds > value.maxTimeoutSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultTimeoutSeconds"],
      message: "defaultTimeoutSeconds must not exceed maxTimeoutSeconds",
    });
  }
  for (const [index, directory] of value.allowedWorkingDirectories.entries()) {
    if (!path.isAbsolute(directory)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedWorkingDirectories", index],
        message: "working directory roots must be absolute",
      });
    }
  }
  if (!path.isAbsolute(value.defaultWorkingDirectory)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultWorkingDirectory"],
      message: "defaultWorkingDirectory must be absolute",
    });
  }
  if (value.auditPath && !path.isAbsolute(value.auditPath)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["auditPath"],
      message: "auditPath must be absolute",
    });
  }
});

const configSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema,
});

function configuredRoots(): string[] {
  const value = process.env.HELIX_MODEL_WORKER_ROOTS;
  if (!value) return [process.cwd()];
  const roots = value.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  return roots.length > 0 ? roots : [process.cwd()];
}

export function getDefaultConfig(): ModelWorkerConfig {
  const roots = configuredRoots().map((root) => path.resolve(root));
  return {
    version: 1,
    settings: {
      claudeCommand: process.env.HELIX_CLAUDE_COMMAND || "claude",
      gptCommand: process.env.HELIX_GPT_COMMAND || "codex",
      allowedWorkingDirectories: roots,
      defaultWorkingDirectory: roots[0]!,
      defaultTimeoutSeconds: 300,
      maxTimeoutSeconds: 1800,
      maxOutputBytes: 1024 * 1024,
      maxPromptChars: 200_000,
      maxConcurrentWorkers: 2,
      auditEnabled: true,
    },
  };
}

export function validateConfig(value: unknown): ModelWorkerConfig {
  return configSchema.parse(value) as ModelWorkerConfig;
}

export function getConfigPath(): string {
  if (process.env.HELIX_MODEL_WORKER_CONFIG) {
    return path.resolve(process.env.HELIX_MODEL_WORKER_CONFIG);
  }
  const base = process.platform === "win32"
    ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Helix", "model-worker-mcp.json");
}

export class ConfigStore {
  constructor(public readonly filePath = getConfigPath()) {}

  async read(): Promise<ModelWorkerConfig> {
    try {
      return validateConfig(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const config = getDefaultConfig();
      await this.write(config);
      return config;
    }
  }

  async write(config: ModelWorkerConfig): Promise<void> {
    const validated = validateConfig(config);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") await fs.chmod(this.filePath, 0o600);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveWorkingDirectory(
  requested: string | undefined,
  config: ModelWorkerConfig,
): Promise<string> {
  const selected = path.resolve(requested || config.settings.defaultWorkingDirectory);
  let resolved: string;
  try {
    resolved = await fs.realpath(selected);
  } catch (error) {
    throw new Error(`Working directory is unavailable: ${selected}; ${String(error)}`);
  }

  for (const configuredRoot of config.settings.allowedWorkingDirectories) {
    let root: string;
    try {
      root = await fs.realpath(path.resolve(configuredRoot));
    } catch {
      continue;
    }
    if (isWithin(root, resolved)) return resolved;
  }
  throw new Error(`Working directory is outside allowedWorkingDirectories: ${resolved}`);
}
