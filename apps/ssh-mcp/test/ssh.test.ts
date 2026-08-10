import { describe, expect, it } from "vitest";
import { buildWindowsEnvironmentProbeScript, parseEnvironmentProbe } from "../src/ssh.js";
import type { HostConfig } from "../src/types.js";

describe("environment probe parser", () => {
  it("parses metadata, tools, containers and source scripts", () => {
    const probe = parseEnvironmentProbe([
      "HELIX_META\tos.name\tUbuntu",
      "HELIX_META\tos.version\t22.04",
      "HELIX_META\tarch\tx86_64",
      "HELIX_META\tshell\t/bin/bash",
      "HELIX_TOOL\tgit\tgit version 2.43.0",
      "HELIX_CONTAINER\tabc123\tbuild-env\tubuntu:22.04\tUp 5 minutes",
      "HELIX_SOURCE\t/opt/ros/humble/setup.bash",
    ].join("\n"));

    expect(probe.os.name).toBe("Ubuntu");
    expect(probe.arch).toBe("x86_64");
    expect(probe.tools.git).toContain("2.43.0");
    expect(probe.containers[0]?.name).toBe("build-env");
    expect(probe.candidateSourceScripts).toEqual(["/opt/ros/humble/setup.bash"]);
  });
});

function decodeEncodedCommand(command: string): string {
  const match = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/);
  if (!match?.[1]) throw new Error("no EncodedCommand found");
  return Buffer.from(match[1], "base64").toString("utf16le");
}

describe("windows environment probe script", () => {
  it("embeds allowed remote paths and probes Windows metadata", () => {
    const host: HostConfig = {
      hostname: "192.168.1.50",
      os: "windows",
      username: "admin",
      tags: [],
      allowedRemotePaths: ["C:\\helix"],
      auth: { type: "openssh" },
      sudo: { mode: "disabled", allow: [], approvalTtlSeconds: 300 },
    };
    const decoded = decodeEncodedCommand(buildWindowsEnvironmentProbeScript(host));
    expect(decoded).toContain("HELIX_META");
    expect(decoded).toContain("$env:PROCESSOR_ARCHITECTURE");
    expect(decoded).toContain("'C:\\helix'");
    expect(decoded).toContain("Get-Command docker");
    expect(decoded).not.toContain("PLACEHOLDER_ROOTS");
  });
});
