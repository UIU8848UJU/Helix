import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildJobCancelCommand,
  buildJobLogsCommand,
  buildJobStartCommand,
  buildJobStatusCommand,
  parseJobLogs,
  parseJobStatus,
} from "../src/jobs.js";
import type { HostConfig } from "../src/types.js";

const execFileAsync = promisify(execFile);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// The remote job engine targets Unix SSH hosts and relies on sh, /tmp, nohup,
// setsid, and POSIX signals. Keep its local end-to-end test on Unix runners;
// Windows still runs all platform-independent builders and parsers above.
const itWithUnixShell = process.platform === "win32" ? it.skip : it;

const host: HostConfig = {
  hostname: "127.0.0.1",
  port: 22,
  username: "tester",
  tags: [],
  allowedRemotePaths: ["/"],
  auth: { type: "openssh" },
  sudo: {
    mode: "reviewed-nopasswd",
    allow: ["^.*$"],
    approvalTtlSeconds: 300,
  },
};

function decodeRunnerBase64(command: string): string {
  const match = command.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/);
  if (!match) throw new Error("runner base64 payload not found");
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("persistent remote jobs", () => {
  it("builds a detached start command with persistent metadata", () => {
    const command = buildJobStartCommand({
      jobId: "job-test-123",
      type: "compose-build",
      name: "QuantX dev image",
      command: "docker compose build dev",
      host,
      cwd: "/home/tester/QuantX",
      env: { DOCKER_BUILDKIT: "1" },
      sourceScripts: ["/opt/ros/humble/setup.bash"],
      privileged: false,
    });
    expect(command).toContain("/tmp/helix/jobs/job-test-123");
    expect(command).toContain("nohup setsid");
    expect(command).toContain("output.log");
    expect(command).toContain("HELIX_JOB_START_V1");
    expect(command).not.toContain("docker compose build dev");
  });

  it("builds status, cursor logs, and process-group cancellation", () => {
    expect(buildJobStatusCommand("job-test-123")).toContain("HELIX_JOB_STATUS_V1");
    expect(buildJobLogsCommand({ jobId: "job-test-123", lines: 50, cursor: 200, maxBytes: 4096 }))
      .toContain("next_cursor");
    const cancel = buildJobCancelCommand("job-test-123", 5);
    expect(cancel).toContain("kill -TERM");
    expect(cancel).toContain("kill -KILL");
    expect(cancel).toContain("cancel_requested");
  });

  it("parses persisted status metadata", () => {
    const name = Buffer.from("QuantX dev image").toString("base64");
    const command = Buffer.from("docker compose build dev").toString("base64");
    const status = parseJobStatus(`noise\nHELIX_JOB_STATUS_V1\njob_id=job-test-123\ntype=compose-build\nname_b64=${name}\ncommand_b64=${command}\nstate=running\npid=4242\nexit_code=\nprivileged=0\ncreated_at=2026-08-05T14:00:00Z\nstarted_at=2026-08-05T14:00:01Z\nfinished_at=\nlog_path=/tmp/helix/jobs/job-test-123/output.log\nlog_size=8192\n`);
    expect(status.name).toBe("QuantX dev image");
    expect(status.command).toBe("docker compose build dev");
    expect(status.state).toBe("running");
    expect(status.pid).toBe(4242);
    expect(status.logSizeBytes).toBe(8192);
  });

  it("parses incremental log chunks", () => {
    const content = Buffer.from("step 1\nstep 2\n").toString("base64");
    const logs = parseJobLogs(`HELIX_JOB_LOGS_V1\njob_id=job-test-123\nsize=14\nnext_cursor=14\neof=1\ncontent_b64=${content}\n`);
    expect(logs.content).toBe("step 1\nstep 2\n");
    expect(logs.nextCursor).toBe(14);
    expect(logs.eof).toBe(true);
  });

  itWithUnixShell("executes a detached job and reads its final status and logs", async () => {
    const jobId = `job-test-${process.pid}-${Date.now()}`;
    const directory = `/tmp/helix/jobs/${jobId}`;
    try {
      const startCommand = buildJobStartCommand({
        jobId,
        type: "test",
        name: "job integration test",
        command: "printf 'hello-job\\n'; sleep 0.2; printf 'done-job\\n'",
        host,
        cwd: "/tmp",
        privileged: false,
      });
      const started = await execFileAsync("sh", ["-lc", startCommand], { maxBuffer: 1024 * 1024 });
      expect(started.stdout).toContain("HELIX_JOB_START_V1");

      let status = parseJobStatus((await execFileAsync("sh", ["-lc", buildJobStatusCommand(jobId)])).stdout);
      for (let attempt = 0; attempt < 30 && ["queued", "running"].includes(status.state); attempt += 1) {
        await sleep(100);
        status = parseJobStatus((await execFileAsync("sh", ["-lc", buildJobStatusCommand(jobId)])).stdout);
      }

      expect(status.state).toBe("succeeded");
      expect(status.exitCode).toBe(0);
      const logsResult = await execFileAsync("sh", ["-lc", buildJobLogsCommand({
        jobId,
        lines: 20,
        maxBytes: 16 * 1024,
      })]);
      const logs = parseJobLogs(logsResult.stdout);
      expect(logs.content).toContain("hello-job");
      expect(logs.content).toContain("done-job");
      expect(logs.eof).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("rejects unsafe job ids", () => {
    expect(() => buildJobStatusCommand("../../etc/passwd")).toThrow("Invalid Helix job id");
  });

  it("falls back to host.defaultWorkingDir when cwd is omitted", () => {
    const command = buildJobStartCommand({
      jobId: "job-test-456",
      type: "test",
      name: "default cwd job",
      command: "make test",
      host: { ...host, defaultWorkingDir: "/home/tester/project" },
      privileged: false,
    });
    expect(decodeRunnerBase64(command)).toContain("/home/tester/project");
  });

  it("prefers an explicit cwd over host.defaultWorkingDir", () => {
    const command = buildJobStartCommand({
      jobId: "job-test-789",
      type: "test",
      name: "explicit cwd job",
      command: "make test",
      host: { ...host, defaultWorkingDir: "/home/tester/project" },
      cwd: "/home/tester/other",
      privileged: false,
    });
    const runner = decodeRunnerBase64(command);
    expect(runner).toContain("/home/tester/other");
    expect(runner).not.toContain("/home/tester/project");
  });
});
