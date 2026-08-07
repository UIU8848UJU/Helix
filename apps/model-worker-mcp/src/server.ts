import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hashPrompt, writeAudit } from "./audit.js";
import { resolveWorkingDirectory } from "./config.js";
import { getModelWorkerStatus, runWorker } from "./providers.js";
import { Semaphore, runProcess } from "./process.js";
import type {
  ModelWorkerConfig,
  ProcessRunner,
  WorkerMode,
  WorkerProvider,
} from "./types.js";

const INSTRUCTIONS = [
  "Helix Model Worker bridges MCP clients to the locally installed Claude Code and Codex CLIs.",
  "From GPT/Codex use claude_run. From Claude use gpt_run.",
  "Call model_worker_status before the first invocation when authentication is uncertain.",
  "Use answer mode for analysis and workspace mode only when file changes are intended.",
  "Nested workers run without this MCP configuration to prevent model-to-model recursion.",
].join("\n");

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Internals = { server: { _instructions?: string } };

export function createServer(
  config: ModelWorkerConfig,
  configPath: string,
  runner: ProcessRunner = runProcess,
): McpServer {
  const server = new McpServer({ name: "helix-model-worker", version: "0.1.0" });
  (server as unknown as Internals).server._instructions = INSTRUCTIONS;
  const limiter = new Semaphore(config.settings.maxConcurrentWorkers);

  server.tool(
    "model_worker_status",
    "Check whether the local Claude Code and Codex CLIs are installed and authenticated without returning credentials.",
    {},
    async () => {
      try {
        return textResult(await getModelWorkerStatus(config, runner));
      } catch (error) {
        return textResult({ error: message(error) }, true);
      }
    },
  );

  const schema = {
    prompt: z.string().min(1).max(config.settings.maxPromptChars),
    cwd: z.string().min(1).optional(),
    mode: z.enum(["answer", "workspace"]).default("answer"),
    model: z.string().min(1).max(200).optional(),
    timeoutSeconds: z.number().int().min(1).max(config.settings.maxTimeoutSeconds).optional(),
  };

  const invoke = async (provider: WorkerProvider, input: {
    prompt: string;
    cwd?: string;
    mode?: WorkerMode;
    model?: string;
    timeoutSeconds?: number;
  }) => {
    const requestId = randomUUID();
    let cwd = "";
    try {
      cwd = await resolveWorkingDirectory(input.cwd, config);
      const mode = input.mode ?? "answer";
      const timeoutSeconds = input.timeoutSeconds ?? config.settings.defaultTimeoutSeconds;
      const result = await limiter.use(async () => await runWorker({
        provider,
        prompt: input.prompt,
        cwd,
        mode,
        model: input.model,
        timeoutSeconds,
      }, config, runner));
      await writeAudit(config, configPath, {
        timestamp: new Date().toISOString(),
        requestId,
        provider,
        mode,
        cwd,
        promptHash: hashPrompt(input.prompt),
        model: input.model,
        success: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: result.truncated,
        error: result.error,
      });
      return textResult({ requestId, ...result }, !result.ok);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, message(error));
    }
  };

  server.tool(
    "claude_run",
    "Invoke the currently installed and authenticated Claude Code CLI as a bounded worker. Intended for GPT/Codex clients.",
    schema,
    async (input) => await invoke("claude", input),
  );

  server.tool(
    "gpt_run",
    "Invoke the currently installed and authenticated Codex CLI as a bounded GPT worker. Intended for Claude clients.",
    schema,
    async (input) => await invoke("gpt", input),
  );

  return server;
}
