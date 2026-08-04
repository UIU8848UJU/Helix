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
  it("describes the reviewed sudo stop point", () => {
    const help = getHelixHelp("sudo") as {
      workflow: string[];
      rejectionHandling: string[];
    };

    expect(help.workflow.join(" ")).toContain("Stop");
    expect(help.workflow.join(" ")).toContain("explicit user confirmation");
    expect(help.rejectionHandling.join(" ")).toContain("policy-tier operation");
  });

  it("describes lifecycle usability and separate policy authorization", () => {
    const help = getHelixHelp("configuration") as {
      rule: string;
      lifecycleTier: string[];
      policyTier: string[];
    };

    expect(help.rule).toContain("available by default");
    expect(help.lifecycleTier.join(" ")).toContain("host_onboard");
    expect(help.policyTier.join(" ")).toContain("sudo allowlist");
  });

  it("installs server instructions, stronger tool descriptions, and helix_help", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.tool("ssh_exec", "old description", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    server.tool("sudo_request", "old description", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    registerGuidance(server);

    const internals = server as unknown as TestInternals;
    expect(internals.server._instructions).toBe(HELIX_SERVER_INSTRUCTIONS);
    expect(internals._registeredTools?.ssh_exec.description).toBe(TOOL_DESCRIPTIONS.ssh_exec);
    expect(internals._registeredTools?.sudo_request.description).toContain("STOP");
    expect(internals._registeredTools?.helix_help).toBeDefined();
  });
});
