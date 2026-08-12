import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

describe("bounded process execution", () => {
  it("captures stdout and exit code", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  it("terminates output beyond the configured limit", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], {
      timeoutMs: 5000,
      maxOutputBytes: 128,
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
  });

  it("terminates timed out commands", async () => {
    const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      timeoutMs: 50,
      maxOutputBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("passes input to the child stdin", async () => {
    const script = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log('GOT:'+d)})";
    const result = await runProcess(process.execPath, ["-e", script], {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      input: "hello",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("GOT:hello");
  });
});
