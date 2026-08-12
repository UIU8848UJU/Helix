import { describe, expect, it, vi } from "vitest";
import { isCredentialError, withCredentialAutoEnroll } from "../src/broker.js";
import type { GlobalSettings, HostConfig } from "../src/types.js";

const settings: GlobalSettings = {
  defaultTimeoutSeconds: 60,
  maxOutputBytes: 1024 * 1024,
  maxConcurrentCommands: 4,
  strictHostKeyChecking: false,
  auditEnabled: false,
};

const passwordHost: HostConfig = {
  hostname: "192.0.2.10",
  port: 22,
  username: "developer",
  allowedRemotePaths: ["/"],
  auth: { type: "windows-credential", credentialRef: "Helix/ssh/test/login" },
  sudo: {
    mode: "reviewed-password",
    credentialRef: "Helix/ssh/test/sudo",
    allow: ["^.*$"],
    approvalTtlSeconds: 300,
  },
};

function stubPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(process, "platform", original);
    else Reflect.deleteProperty(process, "platform");
  };
}

describe("broker credential auto-enrollment", () => {
  it("classifies missing and rejected credential errors", () => {
    expect(isCredentialError(new Error("credential not found: Helix/ssh/test/login"))).toBe(true);
    expect(isCredentialError(new Error("SSH password authentication failed"))).toBe(true);
    expect(isCredentialError(new Error("SSH server rejected the credential"))).toBe(true);
    expect(isCredentialError(new Error("connection refused"))).toBe(false);
    expect(isCredentialError("boom")).toBe(false);
  });

  it("retries the operation once after a successful auto-enrollment", async () => {
    const restore = stubPlatform("win32");
    try {
      const enroll = vi.fn(async (_refs: string[]) => true);
      let calls = 0;
      const result = await withCredentialAutoEnroll(
        { settings, host: passwordHost, hostAlias: "test", enroll },
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("credential not found: Helix/ssh/test/login");
          return "ok";
        },
      );
      expect(result).toBe("ok");
      expect(calls).toBe(2);
      expect(enroll).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("does not enroll for non-credential errors", async () => {
    const restore = stubPlatform("win32");
    try {
      const enroll = vi.fn(async (_refs: string[]) => true);
      await expect(
        withCredentialAutoEnroll(
          { settings, host: passwordHost, hostAlias: "test", enroll },
          async () => {
            throw new Error("connection refused");
          },
        ),
      ).rejects.toThrow("connection refused");
      expect(enroll).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("does not auto-enroll on non-Windows hosts", async () => {
    const restore = stubPlatform("linux");
    try {
      const enroll = vi.fn(async (_refs: string[]) => true);
      await expect(
        withCredentialAutoEnroll(
          { settings, host: passwordHost, hostAlias: "test", enroll },
          async () => {
            throw new Error("credential not found: Helix/ssh/test/login");
          },
        ),
      ).rejects.toThrow("credential not found");
      expect(enroll).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("does not auto-enroll for OpenSSH-authenticated hosts", async () => {
    const restore = stubPlatform("win32");
    try {
      const enroll = vi.fn(async (_refs: string[]) => true);
      const opensshHost: HostConfig = {
        ...passwordHost,
        auth: { type: "openssh" },
        sudo: { mode: "reviewed-nopasswd", allow: ["^.*$"], approvalTtlSeconds: 300 },
      };
      await expect(
        withCredentialAutoEnroll(
          { settings, host: opensshHost, hostAlias: "test", enroll },
          async () => {
            throw new Error("credential not found: Helix/ssh/test/login");
          },
        ),
      ).rejects.toThrow("credential not found");
      expect(enroll).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("rethrows with a hint when enrollment does not complete", async () => {
    const restore = stubPlatform("win32");
    try {
      const enroll = vi.fn(async (_refs: string[]) => false);
      await expect(
        withCredentialAutoEnroll(
          { settings, host: passwordHost, hostAlias: "test", enroll },
          async () => {
            throw new Error("credential not found: Helix/ssh/test/login");
          },
        ),
      ).rejects.toThrow(/auto-enrollment did not complete/);
      expect(enroll).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("only enrolls the credential reference named by the error", async () => {
    const restore = stubPlatform("win32");
    try {
      const enroll = vi.fn(async (_refs: string[]) => true);
      let calls = 0;
      await withCredentialAutoEnroll(
        { settings, host: passwordHost, hostAlias: "test", enroll },
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("credential not found: Helix/ssh/test/sudo");
          return "ok";
        },
      );
      expect(enroll).toHaveBeenCalledWith(["Helix/ssh/test/sudo"]);
    } finally {
      restore();
    }
  });

  it("parses the credential reference when the broker appends an OS error suffix", async () => {
    const restore = stubPlatform("win32");
    try {
      const enroll = vi.fn(async (_refs: string[]) => true);
      let calls = 0;
      await withCredentialAutoEnroll(
        { settings, host: passwordHost, hostAlias: "test", enroll },
        async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("credential not found: Helix/ssh/test/login: element not found (os error 1168)");
          }
          return "ok";
        },
      );
      expect(enroll).toHaveBeenCalledWith(["Helix/ssh/test/login"]);
    } finally {
      restore();
    }
  });

  it("enrolls only the login reference for authentication failures", async () => {
    const restore = stubPlatform("win32");
    try {
      const enroll = vi.fn(async (_refs: string[]) => true);
      let calls = 0;
      await withCredentialAutoEnroll(
        { settings, host: passwordHost, hostAlias: "test", enroll },
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("SSH password authentication failed");
          return "ok";
        },
      );
      expect(enroll).toHaveBeenCalledWith(["Helix/ssh/test/login"]);
    } finally {
      restore();
    }
  });
});
