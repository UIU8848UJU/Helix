import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertProtocolCompatible, buildBrokerPtyRequest, isCredentialError, resolveSpoolRefsWithReader, withCredentialAutoEnroll } from "../src/broker.js";
import type { GlobalSettings, HostConfig, SpoolReadResult } from "../src/types.js";

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

describe("broker pty request builder (TDD PTY-001)", () => {
  it("builds the pty request with defaults from settings", () => {
    const request = buildBrokerPtyRequest({
      credentialRef: "Helix/ssh/test/login",
      host: passwordHost,
      command: "top",
      settings,
    });
    expect(request).toMatchObject({
      op: "pty",
      credential_ref: "Helix/ssh/test/login",
      host: "192.0.2.10",
      port: 22,
      username: "developer",
      command: "top",
      timeout_seconds: 60,
      max_output_bytes: 1024 * 1024,
      strict_host_key_checking: false,
    });
    expect(request.cols).toBeUndefined();
    expect(request.rows).toBeUndefined();
    expect(request.input).toBeUndefined();
  });

  it("honors overrides and optional fields", () => {
    const request = buildBrokerPtyRequest({
      credentialRef: "Helix/ssh/test/login",
      host: passwordHost,
      command: "read x; echo got:$x",
      timeoutSeconds: 15,
      cols: 120,
      rows: 40,
      input: "hello",
      settings,
    });
    expect(request.timeout_seconds).toBe(15);
    expect(request.cols).toBe(120);
    expect(request.rows).toBe(40);
    expect(request.input).toBe("hello");
  });
});

describe("broker daemon v4 capability contract", () => {
  it("accepts the v4 capability set", () => {
    expect(() => assertProtocolCompatible({
      ok: true,
      protocolVersion: 4,
      capabilities: ["task_pool_v2", "bounded_ipc", "owner_only_ipc", "pty_v1", "spool_v1"],
    })).not.toThrow();
  });

  it("rejects a same-version daemon without pty_v1", () => {
    expect(() => assertProtocolCompatible({
      ok: true,
      protocolVersion: 4,
      capabilities: ["task_pool_v2", "bounded_ipc", "owner_only_ipc"],
    })).toThrow(/missing required capabilities: pty_v1/);
  });

  it("rejects a same-version daemon without spool_v1", () => {
    expect(() => assertProtocolCompatible({
      ok: true,
      protocolVersion: 4,
      capabilities: ["task_pool_v2", "bounded_ipc", "owner_only_ipc", "pty_v1"],
    })).toThrow(/missing required capabilities: spool_v1/);
  });
});


describe("broker spool resolution (large outputs)", () => {
  const stdoutRef = "spool://broker-1-1/stdout";
  const stderrRef = "spool://broker-1-1/stderr";

  function fakeReader(contents: Record<string, string>) {
    return vi.fn(async (_settings: GlobalSettings, resultRef: string, cursor = 0, maxBytes = 32 * 1024): Promise<SpoolReadResult> => {
      const data = contents[resultRef] ?? "";
      const start = Math.min(cursor, data.length);
      const end = Math.min(start + maxBytes, data.length);
      return {
        content: data.slice(start, end),
        nextCursor: end,
        eof: end >= data.length,
        size: data.length,
      };
    });
  }

  it("returns the response unchanged when no spool refs are present", async () => {
    const reader = fakeReader({});
    const response = { ok: true, stdout: "inline" };
    await expect(resolveSpoolRefsWithReader(settings, response, reader)).resolves.toEqual(response);
    expect(reader).not.toHaveBeenCalled();
  });

  it("pulls a large spooled stdout across multiple bounded reads", async () => {
    const content = "y".repeat(600 * 1024);
    const reader = fakeReader({ [stdoutRef]: content });
    const resolved = await resolveSpoolRefsWithReader(settings, {
      ok: true,
      stdoutRef,
      stdoutSize: content.length,
    }, reader);
    expect(resolved.stdout).toBe(content);
    expect(resolved.truncated).toBe(false);
    expect(reader).toHaveBeenCalledTimes(3);
    expect(reader).toHaveBeenCalledWith(settings, stdoutRef, 0, 256 * 1024);
    expect(reader).toHaveBeenLastCalledWith(settings, stdoutRef, 512 * 1024, 256 * 1024);
  });

  it("caps resolution at maxOutputBytes and flags truncation", async () => {
    const content = "z".repeat(3 * 1024 * 1024);
    const reader = fakeReader({ [stdoutRef]: content });
    const resolved = await resolveSpoolRefsWithReader(settings, {
      ok: true,
      stdoutRef,
      stdoutSize: content.length,
    }, reader);
    expect(resolved.stdout?.length).toBe(settings.maxOutputBytes);
    expect(resolved.truncated).toBe(true);
  });

  it("resolves stderr refs as well and keeps an existing truncated flag", async () => {
    const reader = fakeReader({ [stdoutRef]: "ok", [stderrRef]: "warn" });
    const resolved = await resolveSpoolRefsWithReader(settings, {
      ok: true,
      stdoutRef,
      stderrRef,
      truncated: true,
    }, reader);
    expect(resolved.stdout).toBe("ok");
    expect(resolved.stderr).toBe("warn");
    expect(resolved.truncated).toBe(true);
  });
});

