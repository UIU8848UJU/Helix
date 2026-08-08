import { describe, expect, it } from "vitest";
import {
  assertRemotePathAllowed,
  assertSudoAllowed,
  buildDockerExecCommand,
  buildRemoteScript,
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
