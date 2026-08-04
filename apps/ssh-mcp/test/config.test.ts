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

function lifecycleHost(alias = "build-dev") {
  return validateHost(alias, {
    hostname: "10.0.0.20",
    username: "developer",
    allowedRemotePaths: safeLifecycleRemotePaths("developer"),
    auth: { type: "windows-credential", credentialRef: `Helix/ssh/${alias}/login` },
    sudo: {
      mode: "reviewed-password",
      credentialRef: `Helix/ssh/${alias}/sudo`,
      allow: [],
      approvalTtlSeconds: 300,
    },
  });
}

describe("configuration", () => {
  it("creates a usable default config when absent", async () => {
    const store = await temporaryStore();
    expect(await store.read()).toEqual(defaultConfig);
    expect(defaultConfig.settings.allowHostMutation).toBe(true);
    expect(defaultConfig.settings.allowPolicyMutation).toBe(false);
    expect(JSON.parse(await fs.readFile(store.filePath, "utf8"))).toEqual(defaultConfig);
  });

  it("allows normal lifecycle onboarding and connection changes by default", async () => {
    const store = await temporaryStore();
    const host = lifecycleHost();
    await store.mutate((config) => { config.hosts["build-dev"] = host; });
    await store.mutate((config) => {
      config.hosts["build-dev"]!.hostname = "10.0.0.21";
      config.hosts["build-dev"]!.username = "developer2";
      config.hosts["build-dev"]!.tags = ["updated"];
    });
    expect((await store.getHost("build-dev")).hostname).toBe("10.0.0.21");
  });

  it("blocks real policy expansion while lifecycle changes remain enabled", async () => {
    const store = await temporaryStore();
    await store.mutate((config) => { config.hosts["build-dev"] = lifecycleHost(); });

    await expect(store.mutate((config) => {
      config.hosts["build-dev"]!.allowedRemotePaths.push("/etc");
      config.hosts["build-dev"]!.sudo.allow.push("^systemctl restart production$" );
    })).rejects.toThrow("Policy mutation is disabled");

    expect((await store.getHost("build-dev")).allowedRemotePaths).not.toContain("/etc");
  });

  it("permits an explicitly enabled policy expansion", async () => {
    const store = await temporaryStore();
    await store.mutate((config) => { config.hosts["build-dev"] = lifecycleHost(); });
    const config = await store.read();
    config.settings.allowPolicyMutation = true;
    await store.write(config);

    await store.mutate((next) => {
      next.hosts["build-dev"]!.allowedRemotePaths.push("/srv/project");
      next.hosts["build-dev"]!.sudo.allow.push("^systemctl status project$" );
    });

    expect((await store.getHost("build-dev")).allowedRemotePaths).toContain("/srv/project");
  });

  it("persists a Windows credential host", async () => {
    const store = await temporaryStore();
    const config = await store.read();
    config.settings.allowPolicyMutation = true;
    await store.write(config);
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
    await store.mutate((next) => { next.hosts["build-dev"] = host; });
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
