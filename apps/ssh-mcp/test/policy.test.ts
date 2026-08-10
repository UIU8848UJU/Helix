import { describe, expect, it } from "vitest";
import {
  assertRemotePathAllowed,
  assertSudoAllowed,
  buildDockerExecCommand,
  buildRemoteScript,
  buildWindowsCommand,
  buildWindowsRemoteScript,
  encodePowerShellCommand,
  normalizeWindowsRemotePath,
  quotePowerShell,
  shellQuote,
} from "../src/policy.js";
import type { HostConfig } from "../src/types.js";

const host: HostConfig = {
  hostname: "127.0.0.1",
  port: 22,
  username: "tester",
  tags: [],
  allowedRemotePaths: ["/workspace", "/opt/ros"],
  auth: { type: "openssh" },
  sudo: {
    mode: "reviewed-nopasswd",
    allow: ["^systemctl status [a-zA-Z0-9_.@-]+$"],
    approvalTtlSeconds: 300,
  },
};

describe("shell and path policy", () => {
  it("quotes single quotes safely", () => {
    expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
  });
  it("accepts configured remote paths", () => {
    expect(assertRemotePathAllowed(host, "/workspace/project")).toBe("/workspace/project");
  });
  it("rejects path escape", () => {
    expect(() => assertRemotePathAllowed(host, "/workspace/../etc/passwd")).toThrow("outside the configured allowlist");
  });
  it("builds cwd, env and source workflow in order", () => {
    const script = buildRemoteScript(host, "cmake --build build", {
      cwd: "/workspace/project",
      env: { BUILD_TYPE: "Debug" },
      sourceScripts: ["/opt/ros/humble/setup.bash"],
    });
    expect(script).toContain("cd '/workspace/project'");
    expect(script).toContain("export BUILD_TYPE='Debug'");
    expect(script).toContain(". '/opt/ros/humble/setup.bash'");
    expect(script.endsWith("cmake --build build")).toBe(true);
  });

  it("falls back to host.defaultWorkingDir when cwd is omitted", () => {
    const script = buildRemoteScript(
      { ...host, defaultWorkingDir: "/workspace/project" },
      "cmake --build build",
    );
    expect(script).toContain("cd '/workspace/project'");
  });

  it("prefers an explicit cwd over host.defaultWorkingDir", () => {
    const script = buildRemoteScript(
      { ...host, defaultWorkingDir: "/workspace/project" },
      "cmake --build build",
      { cwd: "/workspace/other" },
    );
    expect(script).toContain("cd '/workspace/other'");
    expect(script).not.toContain("cd '/workspace/project'");
  });
});

describe("sudo policy", () => {
  it("allows a complete regex match", () => {
    expect(() => assertSudoAllowed(host, "systemctl status demo.service")).not.toThrow();
  });
  it("rejects commands outside allowlist", () => {
    expect(() => assertSudoAllowed(host, "systemctl restart demo.service")).toThrow("does not match");
  });
});

describe("Docker command builder", () => {
  it("supports bash, cwd, env and source", () => {
    const command = buildDockerExecCommand({
      host,
      container: "build-env",
      command: "ninja -C build",
      cwd: "/workspace/project",
      env: { CC: "gcc" },
      sourceScripts: ["/opt/ros/humble/setup.bash"],
      user: "developer",
      shell: "bash",
    });
    expect(command).toContain("docker exec");
    expect(command).toContain("bash -lc");
    expect(command).toContain("ninja -C build");
  });
});

const windowsHost: HostConfig = {
  hostname: "192.168.1.50",
  os: "windows",
  port: 22,
  username: "admin",
  tags: [],
  allowedRemotePaths: ["C:\\helix", "\\\\server\\share"],
  auth: { type: "openssh" },
  sudo: { mode: "disabled", allow: [], approvalTtlSeconds: 300 },
};

function decodeEncodedCommand(command: string): string {
  const match = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/);
  if (!match?.[1]) throw new Error("no EncodedCommand found");
  return Buffer.from(match[1], "base64").toString("utf16le");
}

describe("Windows path policy", () => {
  it("normalizes forward slashes to backslashes", () => {
    expect(normalizeWindowsRemotePath("C:/helix/project")).toBe("C:\\helix\\project");
  });

  it("accepts drive and UNC absolute paths", () => {
    expect(normalizeWindowsRemotePath("C:\\helix")).toBe("C:\\helix");
    expect(normalizeWindowsRemotePath("\\\\server\\share\\dir")).toBe("\\\\server\\share\\dir");
  });

  it("rejects relative Windows paths", () => {
    expect(() => normalizeWindowsRemotePath("helix\\project")).toThrow("absolute");
    expect(() => normalizeWindowsRemotePath("C:helix")).toThrow("absolute");
  });

  it("accepts paths inside the allowlist case-insensitively", () => {
    expect(assertRemotePathAllowed(windowsHost, "c:\\HELIX\\project")).toBe("c:\\HELIX\\project");
    expect(assertRemotePathAllowed(windowsHost, "C:\\helix\\..\\helix\\ok")).toBe("C:\\helix\\ok");
    expect(assertRemotePathAllowed(windowsHost, "\\\\server\\share\\file.txt")).toBe("\\\\server\\share\\file.txt");
  });

  it("rejects Windows path escape through dot-dot", () => {
    expect(() => assertRemotePathAllowed(windowsHost, "C:\\helix\\..\\Windows")).toThrow("outside the configured allowlist");
  });
});

describe("Windows command builder", () => {
  it("quotes PowerShell strings with doubled single quotes", () => {
    expect(quotePowerShell("C:\\helix\\project")).toBe("'C:\\helix\\project'");
    expect(quotePowerShell("it's")).toBe("'it''s'");
  });

  it("builds a PowerShell script with cwd, env and source in order", () => {
    const script = buildWindowsRemoteScript(windowsHost, "npm run build", {
      cwd: "C:/helix/project",
      env: { CI: "true" },
      sourceScripts: ["C:/helix/scripts/env.ps1"],
    });
    expect(script).toContain("Set-Location -LiteralPath 'C:\\helix\\project'");
    expect(script).toContain("$env:CI = 'true'");
    expect(script).toContain(". 'C:\\helix\\scripts\\env.ps1'");
    expect(script).toContain("npm run build");
    expect(script).toContain("if ($LASTEXITCODE) { exit $LASTEXITCODE }");
  });

  it("round-trips through a UTF-16LE EncodedCommand", () => {
    const script = buildWindowsRemoteScript(windowsHost, "Write-Output \"hello '$HOME'\"");
    const command = encodePowerShellCommand(script);
    expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand /);
    expect(decodeEncodedCommand(command)).toBe(script);
  });

  it("passes user commands verbatim inside the encoded script", () => {
    const command = buildWindowsCommand(windowsHost, "echo \"a b\" & echo 'c d'");
    expect(decodeEncodedCommand(command)).toContain("echo \"a b\" & echo 'c d'");
  });
});
