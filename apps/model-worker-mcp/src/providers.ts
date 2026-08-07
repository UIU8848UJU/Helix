import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ExecutionResult,
  ModelWorkerConfig,
  ModelWorkerStatus,
  ProcessRunner,
  ProviderInvocation,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";

const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
const WORKER_PREAMBLE = [
  "You are running as a bounded worker through Helix Model Worker MCP.",
  "Complete the requested task directly.",
  "Do not invoke Helix Model Worker MCP and do not delegate back to another model.",
  "Respect the selected access mode and the repository instructions in the working directory.",
].join(" ");

type Exists = (candidate: string) => boolean;

export function resolveGptExecutable(
  configured: string,
  searchPath = process.env.PATH || "",
  exists: Exists = existsSync,
): string {
  if (process.platform !== "win32" || path.isAbsolute(configured) || configured.toLowerCase() !== "codex") {
    return configured;
  }

  const nativePackages = [
    ["codex-win32-x64", "x86_64-pc-windows-msvc"],
    ["codex-win32-arm64", "aarch64-pc-windows-msvc"],
  ];
  for (const entry of searchPath.split(path.delimiter).map((item) => item.trim()).filter(Boolean)) {
    for (const [packageName, target] of nativePackages) {
      const candidate = path.join(
        entry,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        packageName!,
        "vendor",
        target!,
        "bin",
        "codex.exe",
      );
      if (exists(candidate)) return candidate;
    }
  }
  return configured;
}

export function workerPrompt(prompt: string): string {
  return `${WORKER_PREAMBLE}\n\nUser task:\n${prompt}`;
}

export function buildClaudeInvocation(
  request: WorkerRequest,
  config: ModelWorkerConfig,
): ProviderInvocation {
  const args = [
    "--print",
    "--input-format", "text",
    "--output-format", "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config", EMPTY_MCP_CONFIG,
    "--disable-slash-commands",
    "--permission-mode", request.mode === "workspace" ? "acceptEdits" : "plan",
  ];
  if (request.model) args.push("--model", request.model);
  return {
    executable: config.settings.claudeCommand,
    args,
    stdin: workerPrompt(request.prompt),
  };
}

export function buildGptInvocation(
  request: WorkerRequest,
  config: ModelWorkerConfig,
): ProviderInvocation {
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "--color", "never",
    "--sandbox", request.mode === "workspace" ? "workspace-write" : "read-only",
    "--ask-for-approval", "never",
    "--cd", request.cwd,
  ];
  if (request.model) args.push("--model", request.model);
  args.push("-");
  return {
    executable: resolveGptExecutable(config.settings.gptCommand),
    args,
    stdin: workerPrompt(request.prompt),
  };
}

function outputError(result: ExecutionResult): string | undefined {
  if (result.timedOut) return "Worker timed out";
  if (result.truncated) return "Worker output exceeded maxOutputBytes";
  if (!result.ok) return result.stderr.trim() || `Worker exited with code ${String(result.exitCode)}`;
  return undefined;
}

export function parseClaudeResult(result: ExecutionResult): WorkerResponse {
  const error = outputError(result);
  let response = result.stdout.trim();
  let sessionId: string | undefined;
  let usage: unknown;
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof value.result === "string") response = value.result;
    if (typeof value.session_id === "string") sessionId = value.session_id;
    usage = value.usage;
  } catch {
    if (result.ok) {
      return {
        provider: "claude",
        ok: false,
        response,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: result.truncated,
        error: "Claude returned invalid JSON",
      };
    }
  }
  return {
    provider: "claude",
    ok: result.ok && !error,
    response,
    sessionId,
    usage,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    truncated: result.truncated,
    error,
  };
}

export function parseGptResult(result: ExecutionResult): WorkerResponse {
  const error = outputError(result);
  let sessionId: string | undefined;
  let response = "";
  let usage: unknown;
  const invalidLines: string[] = [];

  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
      }
      if (event.type === "item.completed" && event.item && typeof event.item === "object") {
        const item = event.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string") response = item.text;
      }
      if (event.type === "turn.completed") usage = event.usage;
    } catch {
      invalidLines.push(line);
    }
  }

  if (result.ok && !response) {
    return {
      provider: "gpt",
      ok: false,
      response: invalidLines.join("\n"),
      sessionId,
      usage,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
      error: "Codex returned no final agent message",
    };
  }

  return {
    provider: "gpt",
    ok: result.ok && !error,
    response,
    sessionId,
    usage,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    truncated: result.truncated,
    error,
  };
}

function workerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HELIX_MODEL_WORKER_ACTIVE: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

export async function runWorker(
  request: WorkerRequest,
  config: ModelWorkerConfig,
  runner: ProcessRunner,
): Promise<WorkerResponse> {
  const invocation = request.provider === "claude"
    ? buildClaudeInvocation(request, config)
    : buildGptInvocation(request, config);
  const result = await runner(invocation.executable, invocation.args, {
    cwd: request.cwd,
    env: workerEnvironment(),
    stdin: invocation.stdin,
    timeoutMs: request.timeoutSeconds * 1000,
    maxOutputBytes: config.settings.maxOutputBytes,
  });
  return request.provider === "claude" ? parseClaudeResult(result) : parseGptResult(result);
}

async function command(
  runner: ProcessRunner,
  executable: string,
  args: string[],
  config: ModelWorkerConfig,
): Promise<ExecutionResult> {
  return await runner(executable, args, {
    cwd: config.settings.defaultWorkingDirectory,
    env: workerEnvironment(),
    stdin: "",
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
}

export async function getModelWorkerStatus(
  config: ModelWorkerConfig,
  runner: ProcessRunner,
): Promise<ModelWorkerStatus> {
  const gptCommand = resolveGptExecutable(config.settings.gptCommand);
  const [claudeVersion, claudeAuth, gptVersion, gptAuth] = await Promise.all([
    command(runner, config.settings.claudeCommand, ["--version"], config),
    command(runner, config.settings.claudeCommand, ["auth", "status"], config),
    command(runner, gptCommand, ["--version"], config),
    command(runner, gptCommand, ["login", "status"], config),
  ]);

  let claudeAuthenticated: boolean | null = null;
  if (claudeAuth.stdout.trim()) {
    try {
      claudeAuthenticated = Boolean((JSON.parse(claudeAuth.stdout) as Record<string, unknown>).loggedIn);
    } catch {
      claudeAuthenticated = /logged.?in/i.test(claudeAuth.stdout);
    }
  }
  const gptAuthText = `${gptAuth.stdout}\n${gptAuth.stderr}`.trim();
  const gptAuthenticated = gptVersion.ok
    ? !/not logged in/i.test(gptAuthText) && /logged in/i.test(gptAuthText)
    : null;

  return {
    claude: {
      installed: claudeVersion.ok,
      authenticated: claudeVersion.ok ? claudeAuthenticated : null,
      version: claudeVersion.ok ? claudeVersion.stdout.trim() : undefined,
      detail: claudeVersion.ok ? claudeAuth.stderr.trim() || undefined : claudeVersion.stderr.trim(),
    },
    gpt: {
      installed: gptVersion.ok,
      authenticated: gptAuthenticated,
      version: gptVersion.ok ? gptVersion.stdout.trim() : undefined,
      detail: gptAuthText || undefined,
    },
    config: {
      allowedWorkingDirectories: config.settings.allowedWorkingDirectories,
      defaultWorkingDirectory: config.settings.defaultWorkingDirectory,
      defaultTimeoutSeconds: config.settings.defaultTimeoutSeconds,
      maxTimeoutSeconds: config.settings.maxTimeoutSeconds,
      maxConcurrentWorkers: config.settings.maxConcurrentWorkers,
    },
  };
}
