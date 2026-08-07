import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExecutionResult, ProcessOptions, ProcessRunner } from "./types.js";

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be positive");
  }

  async use<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export const runProcess: ProcessRunner = async (executable, args, options) => {
  const startedAt = Date.now();
  return await new Promise<ExecutionResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let truncated = false;
    let processError: Error | null = null;

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1500).unref();
    };

    const capture = (target: Buffer[], data: Buffer): void => {
      const remaining = options.maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        terminate();
        return;
      }
      const slice = data.subarray(0, remaining);
      target.push(slice);
      capturedBytes += slice.byteLength;
      if (slice.byteLength < data.byteLength) {
        truncated = true;
        terminate();
      }
    };

    child.stdout.on("data", (data: Buffer) => capture(stdoutChunks, data));
    child.stderr.on("data", (data: Buffer) => capture(stderrChunks, data));
    child.on("error", (error) => { processError = error; });

    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin, "utf8");

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({
        ok: exitCode === 0 && !timedOut && !truncated && !processError,
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: processError ? `${stderr}${stderr ? "\n" : ""}${processError.message}` : stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
};
