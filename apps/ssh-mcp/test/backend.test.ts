import { describe, expect, it } from "vitest";
import {
  isSshHandshakeCompatibilityError,
  resolveSshBackend,
  runWithSshBackend,
} from "../src/backend.js";
import type { HostConfig } from "../src/types.js";

function host(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    hostname: "kylin.example.test",
    os: "unix",
    port: 22,
    username: "developer",
    tags: [],
    allowedRemotePaths: ["/"],
    auth: { type: "openssh" },
    sudo: { mode: "disabled", allow: ["^.*$"], approvalTtlSeconds: 300 },
    ...overrides,
  };
}

describe("SSH backend selection", () => {
  it("keeps legacy auth routing under auto", () => {
    expect(resolveSshBackend(host())).toBe("openssh");
    expect(resolveSshBackend(host({
      auth: { type: "windows-credential", credentialRef: "Helix/ssh/kylin/login" },
    }))).toBe("libssh2");
  });

  it("allows an explicit OpenSSH backend with a configured identity file", () => {
    expect(resolveSshBackend(host({
      sshBackend: "openssh",
      auth: { type: "windows-credential", credentialRef: "Helix/ssh/kylin/login" },
      identityFile: "~/.ssh/id_ed25519",
    }))).toBe("openssh");
  });

  it("routes an explicit OpenSSH backend without touching libssh2", async () => {
    const calls: string[] = [];
    const result = await runWithSshBackend({
      host: host({ sshBackend: "openssh" }),
      runLibssh2: async () => { calls.push("libssh2"); return "libssh2"; },
      runOpenSsh: async () => { calls.push("openssh"); return "openssh"; },
    });
    expect(result).toBe("openssh");
    expect(calls).toEqual(["openssh"]);
  });

  it("rejects unsafe backend and auth combinations", () => {
    expect(() => resolveSshBackend(host({ sshBackend: "libssh2" }))).toThrow("requires windows-credential");
    expect(() => resolveSshBackend(host({
      sshBackend: "openssh",
      auth: { type: "windows-credential", credentialRef: "Helix/ssh/kylin/login" },
    }))).toThrow("identityFile");
  });

  it("classifies only handshake compatibility failures for fallback", () => {
    expect(isSshHandshakeCompatibilityError(new Error("SSH handshake failed: Unable to exchange encryption keys"))).toBe(true);
    expect(isSshHandshakeCompatibilityError(new Error("SSH handshake failed: algorithm unsupported"))).toBe(true);
    expect(isSshHandshakeCompatibilityError(new Error("SSH password authentication failed"))).toBe(false);
    expect(isSshHandshakeCompatibilityError(new Error("failed to connect to host"))).toBe(false);
  });
});
