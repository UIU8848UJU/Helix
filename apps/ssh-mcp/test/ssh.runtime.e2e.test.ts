import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { brokerDaemonStatus } from "../src/broker.js";
import { ConfigStore } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { GlobalSettings } from "../src/types.js";

const enabled = process.env.HELIX_SSH_E2E === "1";
const suite = enabled ? describe.sequential : describe.skip;
const sshHost = process.env.HELIX_SSH_HOST ?? "127.0.0.1";
const sshPort = Number(process.env.HELIX_SSH_PORT ?? "2222");
const sshUser = process.env.HELIX_SSH_USER ?? "helix";
const credentialRef = process.env.HELIX_TEST_CREDENTIAL_TARGET ?? "Helix/ssh/ci/login";
const brokerPath = process.env.HELIX_CREDENTIAL_BROKER ?? "";

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(500);
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });
    if (connected) return;
    await delay(200);
  }
  throw new Error(`SSH server ${host}:${port} did not become ready within ${timeoutMs}ms`);
}

suite("Helix real SSH runtime E2E", () => {
  let dir: string;
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let settings: GlobalSettings;
  let terminalId: string | null = null;

  async function call<T extends Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = await client.callTool({ name, arguments: args }) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = result.content?.find((item) => item.type === "text")?.text ?? "";
    if (result.isError) {
      throw new Error(`${name} failed: ${text}`);
    }
    return JSON.parse(text) as T;
  }

  async function execTerminal(command: string): Promise<Record<string, unknown>> {
    if (!terminalId) throw new Error("terminal is not open");
    const submitted = await call<{ taskId: string; state: string }>("terminal_exec", {
      terminalId,
      command,
    });
    const completed = await call<Record<string, unknown>>("task_wait", {
      taskId: submitted.taskId,
      timeoutSeconds: 15,
    });
    expect(completed.state).toBe("succeeded");
    return completed;
  }

  beforeAll(async () => {
    if (!brokerPath) throw new Error("HELIX_CREDENTIAL_BROKER is required for SSH E2E");
    await waitForPort(sshHost, sshPort);
    dir = mkdtempSync(path.join(os.tmpdir(), "helix-ssh-e2e-"));
    process.env.HELIX_LOCAL_PATH_ROOTS = dir;

    settings = {
      allowHostMutation: false,
      allowPolicyMutation: false,
      defaultTimeoutSeconds: 30,
      maxOutputBytes: 1024 * 1024,
      maxConcurrentCommands: 4,
      strictHostKeyChecking: false,
      allowPersistentTerminal: true,
      auditEnabled: false,
      auditCommandMode: "plain",
      credentialBrokerPath: brokerPath,
    };

    const store = new ConfigStore(path.join(dir, "ssh-mcp.json"));
    await store.write({
      version: 1,
      settings,
      hosts: {
        ci: {
          hostname: sshHost,
          os: "unix",
          port: sshPort,
          username: sshUser,
          tags: ["ci", "e2e"],
          allowedRemotePaths: ["/"],
          auth: { type: "windows-credential", credentialRef },
          sudo: { mode: "disabled", allow: [], approvalTtlSeconds: 300 },
        },
      },
    });

    server = createServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "helix-ssh-e2e", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 60_000);

  afterAll(async () => {
    if (terminalId) {
      await call("terminal_close", { terminalId }).catch(() => undefined);
    }
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (brokerPath) {
      try {
        execFileSync(brokerPath, ["daemon-stop"], { stdio: "ignore" });
      } catch {
        // The detached daemon may already have exited; CI cleanup can continue.
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("executes commands and preserves the remote exit code", async () => {
    const ok = await call<{ ok: boolean; exitCode: number; stdout: string }>("ssh_exec", {
      host: "ci",
      command: "printf 'HELIX_EXEC_OK\\n'",
    });
    expect(ok.ok).toBe(true);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("HELIX_EXEC_OK");

    const nonzero = await call<{ ok: boolean; exitCode: number }>("ssh_exec", {
      host: "ci",
      command: "exit 23",
    });
    expect(nonzero.ok).toBe(false);
    expect(nonzero.exitCode).toBe(23);
  });

  it("keeps a persistent PTY, cwd and task lifecycle across MCP calls", async () => {
    const opened = await call<{ terminalId: string; state: string }>("terminal_open", {
      host: "ci",
      command: "bash --noprofile --norc -i",
      idleSeconds: 120,
    });
    terminalId = opened.terminalId;
    expect(opened.state).toBe("running");

    await execTerminal("tty");
    await execTerminal("mkdir -p /tmp/helix-e2e && cd /tmp/helix-e2e");
    await execTerminal("pwd");

    const delayed = await call<{ taskId: string }>("terminal_exec", {
      terminalId,
      command: "sleep 1; printf 'TASK_WAIT_DONE\\n'",
    });
    const waited = await call<{ state: string }>("task_wait", {
      taskId: delayed.taskId,
      timeoutSeconds: 10,
    });
    expect(waited.state).toBe("succeeded");

    const tail = await call<{ content: string }>("terminal_tail", {
      terminalId,
      maxBytes: 32 * 1024,
    });
    expect(tail.content).toMatch(/\/dev\/pts\/\d+/);
    expect(tail.content).toContain("/tmp/helix-e2e");
    expect(tail.content).toContain("TASK_WAIT_DONE");

    await call("terminal_close", { terminalId });
    terminalId = null;
  }, 30_000);

  it("uploads and downloads the same bytes over broker SFTP", async () => {
    const source = path.join(dir, "upload.bin");
    const downloaded = path.join(dir, "download.bin");
    writeFileSync(source, randomBytes(64 * 1024));

    await call("ssh_upload", {
      host: "ci",
      localPath: source,
      remotePath: "/tmp/helix-e2e/upload.bin",
    });
    await call("ssh_download", {
      host: "ci",
      remotePath: "/tmp/helix-e2e/upload.bin",
      localPath: downloaded,
    });

    expect(sha256(downloaded)).toBe(sha256(source));
  });

  it("reuses pooled sessions and reconnects after the SSH server restarts", async () => {
    await call("ssh_exec", { host: "ci", command: "printf 'POOL_A\\n'" });
    await call("ssh_exec", { host: "ci", command: "printf 'POOL_B\\n'" });

    const status = await brokerDaemonStatus(settings);
    expect(status.pooledSessions ?? 0).toBeGreaterThanOrEqual(1);

    execFileSync("docker", ["restart", "helix-sshd-e2e"], { stdio: "inherit" });
    await waitForPort(sshHost, sshPort);

    const reconnected = await call<{ ok: boolean; stdout: string }>("ssh_exec", {
      host: "ci",
      command: "printf 'RECONNECTED\\n'",
      timeoutSeconds: 30,
    });
    expect(reconnected.ok).toBe(true);
    expect(reconnected.stdout).toContain("RECONNECTED");
  }, 45_000);
});
