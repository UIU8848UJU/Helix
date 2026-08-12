import { describe, expect, it } from "vitest";
import { runSshPty } from "../src/ssh.js";
import { Semaphore } from "../src/process.js";
import type { GlobalSettings, HostConfig } from "../src/types.js";

const integrationEnabled = process.env.HELIX_PTY_INTEGRATION === "1";
const sshHost = process.env.HELIX_SSH_HOST;
const sshUser = process.env.HELIX_SSH_USER;
const identityFile = process.env.HELIX_SSH_IDENTITY_FILE;
const sshPort = Number(process.env.HELIX_SSH_PORT ?? "22");

const suite = integrationEnabled && sshHost && sshUser && identityFile ? describe : describe.skip;

function buildHost(): HostConfig {
  return {
    hostname: sshHost!,
    os: "unix",
    port: sshPort,
    username: sshUser!,
    identityFile,
    tags: [],
    allowedRemotePaths: ["/"],
    auth: { type: "openssh" },
    sudo: { mode: "disabled", allow: [], approvalTtlSeconds: 300 },
  };
}

function buildSettings(): GlobalSettings {
  return {
    allowHostMutation: false,
    allowPolicyMutation: false,
    defaultTimeoutSeconds: 30,
    maxOutputBytes: 1024 * 1024,
    maxConcurrentCommands: 4,
    strictHostKeyChecking: false,
    auditEnabled: false,
    auditCommandMode: "plain",
  };
}

suite("openssh -tt real-machine PTY (BEH-011)", () => {
  const limiter = new Semaphore(1);

  it("allocates a real TTY via ssh -tt", async () => {
    const result = await runSshPty({
      host: buildHost(),
      settings: buildSettings(),
      command: "test -t 0 && echo PTY_OK && tty",
      limiter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PTY_OK");
    expect(result.stdout).toContain("/dev/pts/");
  });

  it("delivers stdin input to an interactive remote prompt", async () => {
    const result = await runSshPty({
      host: buildHost(),
      settings: buildSettings(),
      command: "read -r line && echo GOT:$line",
      input: "hello",
      limiter,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("GOT:hello");
  });

  it("propagates the remote exit code under a PTY", async () => {
    const result = await runSshPty({
      host: buildHost(),
      settings: buildSettings(),
      command: "exit 7",
      limiter,
    });
    expect(result.exitCode).toBe(7);
    expect(result.ok).toBe(false);
  });
});