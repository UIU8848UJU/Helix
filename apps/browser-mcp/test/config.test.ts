import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, defaultConfig, validateConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<ConfigStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-mcp-config-"));
  temporaryDirectories.push(directory);
  return new ConfigStore(path.join(directory, "browser-mcp.json"));
}

describe("browser MCP configuration (TDD-104)", () => {
  it("creates a safe default config when absent", async () => {
    const store = await temporaryStore();
    const config = await store.read();
    expect(config).toEqual(defaultConfig);
    expect(config.settings.headless).toBe(true);
    expect(config.settings.defaultTimeoutSeconds).toBe(20);
    expect(config.settings.maxReadBytes).toBe(204800);
    expect(config.settings.auditEnabled).toBe(true);
    expect(config.allowedDomains).toEqual([]);
    expect(config.storageStates).toEqual([]);
    expect(JSON.parse(await fs.readFile(store.filePath, "utf8"))).toEqual(defaultConfig);
  });

  it("parses a valid config with domains and storage states", () => {
    const config = validateConfig({
      version: 1,
      settings: { headless: false, defaultTimeoutSeconds: 30, maxReadBytes: 4096, auditEnabled: false },
      allowedDomains: ["example.com", "internal.corp"],
      storageStates: [{ domain: "internal.corp", path: "/home/u/.helix/states/internal.json" }],
    });
    expect(config.allowedDomains).toContain("example.com");
    expect(config.storageStates[0]?.domain).toBe("internal.corp");
  });

  it("rejects a relative storageState path", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {},
      allowedDomains: ["internal.corp"],
      storageStates: [{ domain: "internal.corp", path: "states/internal.json" }],
    })).toThrow();
  });

  it("rejects duplicate storageState domains", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {},
      allowedDomains: [],
      storageStates: [
        { domain: "internal.corp", path: "/a/one.json" },
        { domain: "internal.corp", path: "/a/two.json" },
      ],
    })).toThrow("duplicate");
  });

  it("rejects an empty storageState domain", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {},
      allowedDomains: [],
      storageStates: [{ domain: "", path: "/a/one.json" }],
    })).toThrow();
  });

  it("rejects empty allowedDomains entries", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {},
      allowedDomains: ["  "],
      storageStates: [],
    })).toThrow();
  });

  it("persists config through the store", async () => {
    const store = await temporaryStore();
    await store.write(validateConfig({
      version: 1,
      settings: {},
      allowedDomains: ["example.com"],
      storageStates: [],
    }));
    const read = await store.read();
    expect(read.allowedDomains).toEqual(["example.com"]);
  });
});