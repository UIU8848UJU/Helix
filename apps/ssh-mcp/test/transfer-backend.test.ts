import { describe, expect, it } from "vitest";
import { resolveTransferBackend } from "../src/transfer-backend.js";
import type { HostConfig } from "../src/types.js";

function host(overrides: Partial<HostConfig>): HostConfig {
  return {
    hostname: "192.0.2.10",
    port: 22,
    username: "developer",
    allowedRemotePaths: ["/"],
    auth: { type: "windows-credential", credentialRef: "Helix/ssh/test/login" },
    sudo: { mode: "disabled", allow: ["^.*$"], approvalTtlSeconds: 300 },
    ...overrides,
  };
}

describe("resolveTransferBackend", () => {
  it("auto keeps scp for openssh hosts", () => {
    expect(resolveTransferBackend(host({ auth: { type: "openssh" }, identityFile: "/k" }))).toBe("scp");
  });

  it("auto uses broker for password hosts", () => {
    expect(resolveTransferBackend(host({}))).toBe("broker");
  });

  it("explicit broker uses broker for a key host", () => {
    expect(
      resolveTransferBackend(host({ auth: { type: "openssh" }, identityFile: "/k", transferBackend: "broker" })),
    ).toBe("broker");
  });

  it("explicit scp uses scp even for a password host", () => {
    expect(resolveTransferBackend(host({ transferBackend: "scp" }))).toBe("scp");
  });
});
