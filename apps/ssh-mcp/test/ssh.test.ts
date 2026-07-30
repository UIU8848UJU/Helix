import { describe, expect, it } from "vitest";
import { parseEnvironmentProbe } from "../src/ssh.js";

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
