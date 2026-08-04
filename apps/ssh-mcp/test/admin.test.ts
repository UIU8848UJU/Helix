import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import {
  buildCredentialAdminCommand,
  credentialRefsForHost,
  registerAdminTools,
} from "../src/admin.js";
import { ConfigStore, safeLifecycleRemotePaths } from "../src/config.js";
import type { HostConfig } from "../src/types.js";

type TestInternals = {
  _registeredTools?: Record<string, { description?: string }>;
};

const passwordHost: HostConfig = {
  hostname: "192.168.0.110",
  port: 22,
  username: "developer",
  allowedRemotePaths: safeLifecycleRemotePaths("developer"),
  auth: {
    type: "windows-credential",
    credentialRef: "Helix/ssh/jetson-dev/login",
  },
  sudo: {
    mode: "reviewed-password",
    credentialRef: "Helix/ssh/jetson-dev/sudo",
    allow: [],
    approvalTtlSeconds: 300,
  },
};

describe("Helix administration tools", () => {
  it("derives login and sudo credential references", () => {
    expect(credentialRefsForHost(passwordHost)).toEqual({
      login: "Helix/ssh/jetson-dev/login",
      sudo: "Helix/ssh/jetson-dev/sudo",
    });
  });

  it("builds a one-prompt local enrollment command", () => {
    const command = buildCredentialAdminCommand({
      scriptPath: "C:\\Users\\123\\AppData\\Roaming\\Helix\\helix-admin.ps1",
      configPath: "C:\\Users\\123\\AppData\\Roaming\\Helix\\ssh-mcp.json",
      action: "set",
      host: "jetson-dev",
      kind: "all",
    });

    expect(command).toContain("credential set");
    expect(command).toContain("-Host 'jetson-dev'");
    expect(command).not.toContain("-SeparatePasswords");
  });

  it("registers tiered host and credential tools", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerAdminTools(server, new ConfigStore("/tmp/helix-admin-test.json"));

    const tools = (server as unknown as TestInternals)._registeredTools ?? {};
    expect(tools.mutation_capabilities?.description).toContain("enabled by default");
    expect(tools.host_onboard?.description).toContain("Preferred");
    expect(tools.host_offboard).toBeDefined();
    expect(tools.credential_enroll_request?.description).toContain("STOP");
    expect(tools.credential_delete_request).toBeDefined();
  });
});
