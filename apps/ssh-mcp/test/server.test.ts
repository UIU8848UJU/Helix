import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigStore } from "../src/config.js";
import { createServer } from "../src/server.js";
import * as broker from "../src/broker.js";
import * as ssh from "../src/ssh.js";

vi.mock("../src/broker.js", { spy: true });
vi.mock("../src/ssh.js", { spy: true });

const executionResult = {
  ok: true,
  exitCode: 0,
  signal: null,
  stdout: "PTY_OK",
  stderr: "",
  timedOut: false,
  truncated: false,
  durationMs: 5,
};

const winCredHost = {
  hostname: "192.168.110.128",
  os: "unix",
  port: 22,
  username: "xxx",
  tags: [],
  allowedRemotePaths: ["/"],
  auth: { type: "windows-credential", credentialRef: "Helix/ssh/u/login" },
  sudo: { mode: "reviewed-password", credentialRef: "Helix/ssh/u/sudo", allow: ["^.*$"], approvalTtlSeconds: 300 },
};

const openSshHost = {
  hostname: "192.0.2.10",
  os: "unix",
  port: 22,
  username: "dev",
  tags: [],
  allowedRemotePaths: ["/"],
  auth: { type: "openssh" },
  sudo: { mode: "reviewed-nopasswd", allow: ["^.*$"], approvalTtlSeconds: 300 },
};

describe("ssh_pty tool registration and routing (TDD PTY-001)", () => {
  let dir: string;
  let client: Client;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(broker.brokerSshPty).mockResolvedValue(executionResult);
    vi.mocked(ssh.runSshPty).mockResolvedValue(executionResult);

    dir = mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-pty-"));
    const store = new ConfigStore(path.join(dir, "config.json"));
    await store.write({
      version: 1,
      settings: {},
      hosts: { win: winCredHost, key: openSshHost },
    });
    server = createServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "pty-test", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers the ssh_pty tool", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("ssh_pty");
  });

  it("routes windows-credential hosts to brokerSshPty", async () => {
    const result = await client.callTool({
      name: "ssh_pty",
      arguments: { host: "win", command: "top", input: "hello", cols: 120, rows: 40 },
    });
    expect(result.isError).toBeFalsy();
    expect(broker.brokerSshPty).toHaveBeenCalledTimes(1);
    expect(ssh.runSshPty).not.toHaveBeenCalled();
  });

  it("routes openssh hosts to runSshPty", async () => {
    await client.callTool({ name: "ssh_pty", arguments: { host: "key", command: "top" } });
    expect(ssh.runSshPty).toHaveBeenCalledTimes(1);
    expect(broker.brokerSshPty).not.toHaveBeenCalled();
  });
});