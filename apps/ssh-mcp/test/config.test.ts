import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, defaultConfig, validateConfig, validateHost } from "../src/config.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("configuration", () => {
  it("creates a default config when absent", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "helix-config-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "ssh-mcp.json");
    const store = new ConfigStore(file);
    expect(await store.read()).toEqual(defaultConfig);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(defaultConfig);
  });

  it("persists a Windows credential host", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "helix-config-"));
    temporaryDirectories.push(directory);
    const store = new ConfigStore(path.join(directory, "ssh-mcp.json"));
    const host = validateHost("build-dev", {
      hostname: "10.0.0.20",
      username: "developer",
      allowedRemotePaths: ["/workspace"],
      auth: { type: "windows-credential", credentialRef: "Helix/ssh/build-dev/login" },
      sudo: {
        mode: "reviewed-password",
        credentialRef: "Helix/ssh/build-dev/sudo",
        allow: ["^systemctl status [a-zA-Z0-9_.@-]+$"],
        approvalTtlSeconds: 300,
      },
    });
    await store.mutate((config) => { config.hosts["build-dev"] = host; });
    expect((await store.getHost("build-dev")).auth.type).toBe("windows-credential");
  });

  it("rejects unanchored sudo regex", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {},
      hosts: {
        bad: {
          hostname: "127.0.0.1",
          allowedRemotePaths: ["/tmp"],
          auth: { type: "openssh" },
          sudo: { mode: "reviewed-nopasswd", allow: ["systemctl.*"], approvalTtlSeconds: 300 },
        },
      },
    })).toThrow("must start with ^ and end with $");
  });

  it("requires password sudo to use the credential broker", () => {
    expect(() => validateHost("bad", {
      hostname: "127.0.0.1",
      allowedRemotePaths: ["/tmp"],
      auth: { type: "openssh" },
      sudo: {
        mode: "reviewed-password",
        credentialRef: "Helix/ssh/bad/sudo",
        allow: ["^id$"],
        approvalTtlSeconds: 300,
      },
    })).toThrow("requires windows-credential");
  });
});
