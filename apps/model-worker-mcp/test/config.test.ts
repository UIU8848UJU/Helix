import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultConfig, validateConfig } from "../src/config.js";

describe("model worker configuration", () => {
  it("builds a safe default rooted at the current directory", () => {
    const config = getDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.settings.allowedWorkingDirectories).toEqual([path.resolve(process.cwd())]);
    expect(config.settings.defaultWorkingDirectory).toBe(path.resolve(process.cwd()));
    expect(config.settings.maxConcurrentWorkers).toBe(2);
    expect(config.settings.auditEnabled).toBe(true);
  });

  it("rejects relative working directory roots", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {
        allowedWorkingDirectories: ["relative"],
        defaultWorkingDirectory: path.resolve("."),
      },
    })).toThrow("working directory roots must be absolute");
  });

  it("rejects a default timeout above the configured maximum", () => {
    expect(() => validateConfig({
      version: 1,
      settings: {
        allowedWorkingDirectories: [path.resolve(".")],
        defaultWorkingDirectory: path.resolve("."),
        defaultTimeoutSeconds: 31,
        maxTimeoutSeconds: 30,
      },
    })).toThrow("defaultTimeoutSeconds must not exceed maxTimeoutSeconds");
  });
});
