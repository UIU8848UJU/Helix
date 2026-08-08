import { spawn } from "node:child_process";
import type { ExecutionResult, ProcessOptions } from "./types.js";

// Semaphore lives in the shared @helix/jobs Task Runtime package. ssh-mcp
// re-exports it so existing importers (server, ssh, jobs) keep their surface.
export { Semaphore } from "@helix/jobs";

export async function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<ExecutionResult> {
  const startedAt = Date.now();

  return await new Promise<ExecutionResult>((resolve) => {
    const spawnOptions: Parameters<typeof spawn>[2] = {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    if (options.cwd) {
      spawnOptions.cwd = options.cwd;
    }
    if (options.env) {
      spawnOptions.env = options.env;
    }

    const child = spawn(executable, args, spawnOptions);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    let processError: Error | null = null;

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 1500).unref();
    };

    const capture = (target: Buffer[], data: Buffer): void => {
      if (capturedBytes >= options.maxOutputBytes) {
        if (!truncated) {
          truncated = true;
          terminate();
        }
        return;
      }

      const remaining = options.maxOutputBytes - capturedBytes;
      const slice = data.subarray(0, remaining);
      target.push(slice);
      capturedBytes += slice.byteLength;
      if (slice.byteLength < data.byteLength) {
        truncated = true;
        terminate();
      }
    };

    child.stdout?.on("data", (data: Buffer) => capture(stdoutChunks, data));
    child.stderr?.on("data", (data: Buffer) => capture(stderrChunks, data));

    child.on("error", (error) => {
      processError = error;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
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
}
