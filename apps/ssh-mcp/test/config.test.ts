import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigStore,
  defaultConfig,
  redactHost,
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
  it("creates an unrestricted Harness config when absent", async () => {
    const store = await temporaryStore();
    expect(await store.read()).toEqual(defaultConfig);
    expect(defaultConfig.settings.allowHostMutation).toBe(true);
    expect(defaultConfig.settings.allowPolicyMutation).toBe(true);
    expect(defaultConfig.settings.strictHostKeyChecking).toBe(false);
    expect(defaultConfig.settings.allowPersistentTerminal).toBe(false);
    expect(safeLifecycleRemotePaths("developer")).toEqual(["/"]);
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
    config.settings.strictHostKeyChecking = true;
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

  it("defaults sshBackend to auto and preserves an explicit OpenSSH backend", () => {
    const automatic = validateHost("auto", {
      hostname: "10.0.0.20",
      allowedRemotePaths: ["/"],
      auth: { type: "openssh" },
      sudo: { mode: "disabled" },
    });
    expect(automatic.sshBackend).toBe("auto");

    const fallback = validateHost("fallback", {
      hostname: "10.0.0.21",
      identityFile: "~/.ssh/id_ed25519",
      sshBackend: "openssh",
      allowedRemotePaths: ["/"],
      auth: { type: "windows-credential", credentialRef: "Helix/ssh/fallback/login" },
      sudo: { mode: "disabled" },
    });
    expect(fallback.sshBackend).toBe("openssh");
    expect(redactHost(fallback).sshBackend).toBe("openssh");
  });

  it("rejects an explicit OpenSSH backend without a key path for password auth", () => {
    expect(() => validateHost("unsafe", {
      hostname: "10.0.0.22",
      sshBackend: "openssh",
      allowedRemotePaths: ["/"],
      auth: { type: "windows-credential", credentialRef: "Helix/ssh/unsafe/login" },
      sudo: { mode: "disabled" },
    })).toThrow("identityFile");
  });

  it("rejects unanchored legacy sudo regex", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {},
      hosts: {
        bad: {
          hostname: "127.0.0.1",
          allowedRemotePaths: ["/"],
          auth: { type: "openssh" },
          sudo: { mode: "reviewed-nopasswd", allow: ["systemctl.*"], approvalTtlSeconds: 300 },
        },
      },
    })).toThrow("must start with ^ and end with $");
  });

  it("requires password sudo to use the credential broker", () => {
    expect(() => validateHost("bad", {
      hostname: "127.0.0.1",
      allowedRemotePaths: ["/"],
      auth: { type: "openssh" },
      sudo: {
        mode: "reviewed-password",
        credentialRef: "Helix/ssh/bad/sudo",
        allow: ["^.*$"],
        approvalTtlSeconds: 300,
      },
    })).toThrow("requires windows-credential");
  });

  it("accepts a defaultWorkingDir inside the host allowlist", () => {
    const host = validateHost("dev", {
      hostname: "10.0.0.20",
      allowedRemotePaths: ["/srv/project", "/opt/tools"],
      defaultWorkingDir: "/srv/project/quantx",
      auth: { type: "openssh" },
      sudo: { mode: "disabled" },
    });
    expect(host.defaultWorkingDir).toBe("/srv/project/quantx");
  });

  it("rejects a defaultWorkingDir outside the host allowlist", () => {
    expect(() => validateHost("dev", {
      hostname: "10.0.0.20",
      allowedRemotePaths: ["/srv/project"],
      defaultWorkingDir: "/etc/ssl",
      auth: { type: "openssh" },
      sudo: { mode: "disabled" },
    })).toThrow("invalid defaultWorkingDir");
  });

  it("rejects a relative defaultWorkingDir", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {},
      hosts: {
        dev: {
          hostname: "10.0.0.20",
          allowedRemotePaths: ["/srv/project"],
          defaultWorkingDir: "srv/project",
          auth: { type: "openssh" },
          sudo: { mode: "disabled" },
        },
      },
    })).toThrow("invalid defaultWorkingDir");
  });

  it("persists and redacts defaultWorkingDir", async () => {
    const store = await temporaryStore();
    await store.mutate((config) => {
      config.hosts["dev"] = validateHost("dev", {
        hostname: "10.0.0.20",
        allowedRemotePaths: ["/srv/project"],
        defaultWorkingDir: "/srv/project/quantx",
        auth: { type: "openssh" },
        sudo: { mode: "disabled" },
      });
    });
    const host = await store.getHost("dev");
    expect(host.defaultWorkingDir).toBe("/srv/project/quantx");
    expect(redactHost(host).defaultWorkingDir).toBe("/srv/project/quantx");
  });
});

describe("transfer backend configuration", () => {
  function keyHostInput(extra: Record<string, unknown> = {}) {
    return {
      hostname: "192.168.33.128",
      username: "developer",
      identityFile: "/home/developer/.ssh/id_ed25519",
      allowedRemotePaths: ["/"],
      auth: { type: "openssh" },
      sudo: { mode: "disabled", allow: ["^.*$"], approvalTtlSeconds: 300 },
      ...extra,
    };
  }

  it("defaults transferBackend to auto", () => {
    expect(harnessHost().transferBackend).toBe("auto");
  });

  it("preserves an explicit broker transfer backend for a key host", () => {
    const host = validateHost("key", keyHostInput({ transferBackend: "broker" }));
    expect(host.transferBackend).toBe("broker");
  });

  it("rejects broker transfer without an identity file for OpenSSH auth", () => {
    expect(() =>
      validateHost("key", keyHostInput({ transferBackend: "broker", identityFile: undefined })),
    ).toThrow(/transferBackend=broker requires identityFile/);
  });

  it("rejects scp transfer for a password-backed host", () => {
    expect(() => validateHost("build-dev", {
      ...harnessHost(),
      transferBackend: "scp",
    })).toThrow(/transferBackend=scp requires openssh auth/);
  });

  it("redacts transferBackend", () => {
    const host = validateHost("key", keyHostInput({ transferBackend: "broker" }));
    expect(redactHost(host).transferBackend).toBe("broker");
  });
});
