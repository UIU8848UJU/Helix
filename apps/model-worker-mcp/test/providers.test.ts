import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config.js";
import {
  buildClaudeInvocation,
  buildGptInvocation,
  getModelWorkerStatus,
  parseClaudeResult,
  parseGptResult,
  resolveGptExecutable,
  runWorker,
} from "../src/providers.js";
import type {
  ExecutionResult,
  ProcessRunner,
  WorkerRequest,
} from "../src/types.js";

const cwd = path.resolve(".");
const config = getDefaultConfig();
config.settings.defaultWorkingDirectory = cwd;
config.settings.allowedWorkingDirectories = [cwd];

function request(provider: "claude" | "gpt", mode: "answer" | "workspace" = "answer"): WorkerRequest {
  return {
    provider,
    prompt: "Inspect this project",
    cwd,
    mode,
    timeoutSeconds: 30,
  };
}

function execution(patch: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 12,
    ...patch,
  };
}

describe("provider command construction", () => {
  it("invokes Claude in stateless JSON mode with nested MCP disabled", () => {
    const invocation = buildClaudeInvocation(request("claude"), config);
    expect(invocation.executable).toBe("claude");
    expect(invocation.args).toContain("--no-session-persistence");
    expect(invocation.args).toContain("--strict-mcp-config");
    expect(invocation.args).toContain("plan");
    expect(invocation.args.join(" ")).not.toContain("Inspect this project");
    expect(invocation.stdin).toContain("Inspect this project");
    expect(invocation.stdin).toContain("do not delegate back");
  });

  it("invokes Codex with ignored user MCP config and read-only sandbox", () => {
    const invocation = buildGptInvocation(request("gpt"), config);
    expect(path.basename(invocation.executable).toLowerCase()).toMatch(/^codex(?:\.exe)?$/);
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain("--ephemeral");
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("never");
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.args.join(" ")).not.toContain("Inspect this project");
  });

  it("uses bounded write modes only when workspace mode is explicit", () => {
    expect(buildClaudeInvocation(request("claude", "workspace"), config).args).toContain("acceptEdits");
    expect(buildGptInvocation(request("gpt", "workspace"), config).args).toContain("workspace-write");
  });

  it("resolves the npm Codex native executable on Windows without a command shell", () => {
    if (process.platform !== "win32") return;
    const npmBin = "C:\\Users\\tester\\AppData\\Roaming\\npm";
    const expected = path.join(
      npmBin,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    const resolved = resolveGptExecutable("codex", npmBin, (candidate) => candidate === expected);
    expect(resolved).toBe(expected);
  });
});

describe("provider result parsing", () => {
  it("parses Claude JSON output", () => {
    const result = parseClaudeResult(execution({
      stdout: JSON.stringify({ result: "Claude answer", session_id: "session-1", usage: { input_tokens: 2 } }),
    }));
    expect(result.ok).toBe(true);
    expect(result.response).toBe("Claude answer");
    expect(result.sessionId).toBe("session-1");
  });

  it("rejects successful non-JSON Claude output", () => {
    const result = parseClaudeResult(execution({ stdout: "plain output" }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Claude returned invalid JSON");
  });

  it("extracts the final Codex agent message and usage", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "GPT answer" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3 } }),
    ].join("\n");
    const result = parseGptResult(execution({ stdout }));
    expect(result.ok).toBe(true);
    expect(result.response).toBe("GPT answer");
    expect(result.sessionId).toBe("thread-1");
    expect(result.usage).toEqual({ input_tokens: 3 });
  });

  it("reports bounded-output termination", () => {
    const result = parseGptResult(execution({ ok: false, truncated: true, stdout: "" }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Worker output exceeded maxOutputBytes");
  });
});

describe("worker execution", () => {
  it("passes prompts over stdin and never through argv", async () => {
    let capturedArgs: string[] = [];
    let capturedInput = "";
    const runner: ProcessRunner = async (_executable, args, options) => {
      capturedArgs = args;
      capturedInput = options.stdin;
      return execution({ stdout: JSON.stringify({ result: "done" }) });
    };
    const result = await runWorker(request("claude"), config, runner);
    expect(result.response).toBe("done");
    expect(capturedArgs.join(" ")).not.toContain("Inspect this project");
    expect(capturedInput).toContain("Inspect this project");
  });

  it("reports installed and authenticated providers without secrets", async () => {
    const runner: ProcessRunner = async (executable, args) => {
      if (args[0] === "--version") {
        return execution({ stdout: executable === "claude" ? "2.1.84\n" : "codex-cli 0.146.1\n" });
      }
      if (executable === "claude") {
        return execution({ stdout: JSON.stringify({ loggedIn: true, apiKeySource: "hidden" }) });
      }
      return execution({ stdout: "Logged in using ChatGPT\n" });
    };
    const status = await getModelWorkerStatus(config, runner);
    expect(status.claude).toMatchObject({ installed: true, authenticated: true, version: "2.1.84" });
    expect(status.gpt).toMatchObject({ installed: true, authenticated: true, version: "codex-cli 0.146.1" });
    expect(JSON.stringify(status)).not.toContain("apiKeySource");
  });

  it("reports a present but logged-out Codex CLI", async () => {
    const runner: ProcessRunner = async (executable, args) => {
      if (args[0] === "--version") return execution({ stdout: "version\n" });
      if (executable === "claude") return execution({ stdout: JSON.stringify({ loggedIn: true }) });
      return execution({ ok: false, exitCode: 1, stdout: "Not logged in\n" });
    };
    const status = await getModelWorkerStatus(config, runner);
    expect(status.gpt.installed).toBe(true);
    expect(status.gpt.authenticated).toBe(false);
  });
});
