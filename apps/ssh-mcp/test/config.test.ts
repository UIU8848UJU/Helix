import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigStore,
  defaultConfig,
  safeLifecycleRemotePaths,
  validateConfig,
  validateHost,
} from "../src/config.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<ConfigStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "helix-config-"));
  temporaryDirectories.push(directory);
  return new ConfigStore(path.join(directory, "ssh-mcp.json"));
}

function harnessHost(alias = "build-dev") {
  return validateHost(alias, {
    hostname: "10.0.0.20",
    username: "developer",
    allowedRemotePaths: safeLifecycleRemotePaths("developer"),
    auth: { type: "windows-credential", credentialRef: `Helix/ssh/${alias}/login` },
    sudo: {
      mode: "reviewed-password",
      credentialRef: `Helix/ssh/${alias}/sudo`,
      allow: ["^.*$"],
      approvalTtlSeconds: 300,
    },
  });
}

describe("configuration", () => {
  it("creates a fully usable Harness config when absent", async () => {
    const store = await temporaryStore();
    expect(await store.read()).toEqual(defaultConfig);
    expect(defaultConfig.settings.allowHostMutation).toBe(true);
    expect(defaultConfig.settings.allowPolicyMutation).toBe(true);
    expect(JSON.parse(await fs.readFile(store.filePath, "utf8"))).toEqual(defaultConfig);
  });

  it("allows lifecycle and policy changes by default", async () => {
    const store = await temporaryStore();
    await store.mutate((config) => { config.hosts["build-dev"] = harnessHost(); });
    await store.mutate((config) => {
      config.hosts["build-dev"]!.hostname = "10.0.0.21";
      config.hosts["build-dev"]!.allowedRemotePaths.push("/srv/project");
      config.hosts["build-dev"]!.tags = ["updated"];
    });
    const host = await store.getHost("build-dev");
    expect(host.hostname).toBe("10.0.0.21");
    expect(host.allowedRemotePaths).toContain("/srv/project");
  });

  it("still supports an EnterpriseLocked policy boundary", async () => {
    const store = await temporaryStore();
    const config = await store.read();
    config.hosts["build-dev"] = harnessHost();
    config.settings.allowPolicyMutation = false;
    await store.write(config);

    await expect(store.mutate((next) => {
      next.hosts["build-dev"]!.allowedRemotePaths.push("/etc");
    })).rejects.toThrow("Policy mutation is disabled");
  });

  it("persists a Windows credential host", async () => {
    const store = await temporaryStore();
    await store.mutate((next) => { next.hosts["build-dev"] = harnessHost(); });
    expect((await store.getHost("build-dev")).auth.type).toBe("windows-credential");
  });

  it("rejects unanchored legacy sudo regex", () => {
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
        allow: ["^.*$"],
        approvalTtlSeconds: 300,
      },
    })).toThrow("requires windows-credential");
  });
});
