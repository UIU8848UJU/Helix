import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, defaultConfig, validateConfig, validateHost } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await fs.rm(directory, { recursive: true, force: true });
  }));
});

describe("configuration", () => {
  it("creates a default config when the file is absent", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "helix-config-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "ssh-mcp.json");
    const store = new ConfigStore(file);

    const config = await store.read();
    expect(config).toEqual(defaultConfig);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(defaultConfig);
  });

  it("persists a validated host", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "helix-config-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(path.join(directory, "ssh-mcp.json"));

    const host = validateHost("build-dev", {
      hostname: "10.0.0.20",
      username: "developer",
      allowedRemotePaths: ["/workspace"],
      sudo: {
        enabled: true,
        allow: ["^systemctl status [a-zA-Z0-9_.@-]+$"],
      },
    });

    await store.mutate((config) => {
      config.hosts["build-dev"] = host;
    });

    expect((await store.getHost("build-dev")).hostname).toBe("10.0.0.20");
  });

  it("rejects unanchored sudo regular expressions", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {},
      hosts: {
        bad: {
          hostname: "127.0.0.1",
          allowedRemotePaths: ["/tmp"],
          sudo: { enabled: true, allow: ["systemctl.*"] },
        },
      },
    })).toThrow("must start with ^ and end with $");
  });
});
