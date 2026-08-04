import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import {
  HELIX_SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTIONS,
  getHelixHelp,
  registerGuidance,
} from "../src/guidance.js";

type TestInternals = {
  _registeredTools?: Record<string, { description?: string }>;
  server: { _instructions?: string };
};

describe("Helix MCP guidance", () => {
  it("describes direct sudo without approval or expiry", () => {
    const help = getHelixHelp("sudo") as { workflow: string[] };
    const workflow = help.workflow.join(" ");
    expect(workflow).toContain("sudo_exec");
    expect(workflow).toContain("No sudo_request");
    expect(workflow).toContain("expiry");
  });

  it("describes Harness defaults and credential popup", () => {
    const help = getHelixHelp("configuration") as {
      defaultProfile: string;
      behavior: string[];
    };
    expect(help.defaultProfile).toBe("Harness");
    expect(help.behavior.join(" ")).toContain("allowPolicyMutation=true");
    expect(help.behavior.join(" ")).toContain("credential window");
  });

  it("installs direct-sudo tool descriptions and helix_help", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.tool("ssh_exec", "old description", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    server.tool("sudo_exec", "old description", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    registerGuidance(server);

    const internals = server as unknown as TestInternals;
    expect(internals.server._instructions).toBe(HELIX_SERVER_INSTRUCTIONS);
    expect(internals._registeredTools?.ssh_exec.description).toBe(TOOL_DESCRIPTIONS.ssh_exec);
    expect(internals._registeredTools?.sudo_exec.description).toContain("No approval flow");
    expect(internals._registeredTools?.helix_help).toBeDefined();
  });
});
