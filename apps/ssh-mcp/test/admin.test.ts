import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import {
  buildBrokerCredentialUiArgs,
  buildCredentialAdminArgs,
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
  hostname: "192.0.2.10",
  port: 22,
  username: "developer",
  allowedRemotePaths: safeLifecycleRemotePaths("developer"),
  auth: {
    type: "windows-credential",
    credentialRef: "Helix/ssh/test-dev/login",
  },
  sudo: {
    mode: "reviewed-password",
    credentialRef: "Helix/ssh/test-dev/sudo",
    allow: ["^.*$"],
    approvalTtlSeconds: 300,
  },
};

describe("Helix administration tools", () => {
  it("derives login and sudo credential references", () => {
    expect(credentialRefsForHost(passwordHost)).toEqual({
      login: "Helix/ssh/test-dev/login",
      sudo: "Helix/ssh/test-dev/sudo",
    });
  });

  it("builds safe PowerShell argument arrays for one-prompt enrollment", () => {
    const args = buildCredentialAdminArgs({
      scriptPath: "C:\\Users\\tester\\AppData\\Roaming\\Helix\\helix-admin.ps1",
      configPath: "C:\\Users\\tester\\AppData\\Roaming\\Helix\\ssh-mcp.json",
      action: "set",
      host: "test-host",
      kind: "all",
    });
    expect(args).toContain("test-host");
    expect(args).not.toContain("-SeparatePasswords");

    const command = buildCredentialAdminCommand({
      scriptPath: "C:\\Users\\tester\\AppData\\Roaming\\Helix\\helix-admin.ps1",
      configPath: "C:\\Users\\tester\\AppData\\Roaming\\Helix\\ssh-mcp.json",
      action: "set",
      host: "test-host",
      kind: "all",
    });
    expect(command).toContain("credential");
    expect(command).toContain("test-host");
  });

  it("builds broker credential UI argument arrays", () => {
    const args = buildBrokerCredentialUiArgs({
      username: "developer",
      credentialRefs: ["Helix/ssh/test-dev/login", "Helix/ssh/test-dev/sudo"],
      separatePasswords: true,
    });
    expect(args).toEqual([
      "credential-ui",
      "--username",
      "developer",
      "--target",
      "Helix/ssh/test-dev/login",
      "--target",
      "Helix/ssh/test-dev/sudo",
      "--separate-passwords",
    ]);

    const single = buildBrokerCredentialUiArgs({
      username: "developer",
      credentialRefs: ["Helix/ssh/test-dev/login"],
    });
    expect(single).toEqual([
      "credential-ui",
      "--username",
      "developer",
      "--target",
      "Helix/ssh/test-dev/login",
    ]);
  });

  it("registers one-stop onboarding and credential launch tools", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerAdminTools(server, new ConfigStore("/tmp/helix-admin-test.json"));

    const tools = (server as unknown as TestInternals)._registeredTools ?? {};
    expect(tools.mutation_capabilities?.description).toContain("Personal/Harness");
    expect(tools.host_onboard?.description).toContain("one-stop");
    expect(tools.credential_enroll_launch?.description).toContain("credential dialog");
    expect(tools.credential_enroll_request).toBeDefined();
    expect(tools.credential_delete_request).toBeDefined();
  });
});
