import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installRuntime, parseCliArgs, stopDaemon } from "../src/cli.js";

describe("cli argument parsing", () => {
  it("keeps the stdio server as the default", () => {
    expect(parseCliArgs(["node", "bundle"])).toEqual({ kind: "server" });
    expect(parseCliArgs(["node", "bundle", "--unknown"])).toEqual({ kind: "server" });
  });

  it("parses help, stop, install and uninstall", () => {
    expect(parseCliArgs(["node", "bundle", "help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["node", "bundle", "--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["node", "bundle", "stop"])).toEqual({ kind: "stop" });
    expect(parseCliArgs(["node", "bundle", "install"])).toEqual({ kind: "install" });
    expect(parseCliArgs(["node", "bundle", "uninstall"])).toEqual({ kind: "uninstall", purge: false });
    expect(parseCliArgs(["node", "bundle", "uninstall", "--purge"])).toEqual({ kind: "uninstall", purge: true });
  });
});

describe("installRuntime", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) fs.rmSync(temp, { recursive: true, force: true });
  });
  const makeTemp = () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-cli-install-"));
    temps.push(temp);
    return temp;
  };

  it("creates config, installs the guide and registers user-scope MCP", () => {
    const temp = makeTemp();
    const configPath = path.join(temp, "config", "ssh-mcp.json");
    const guideDestination = path.join(temp, "config", "HELIX_AI_GUIDE.md");
    const guideSource = path.join(temp, "source-guide.md");
    fs.writeFileSync(guideSource, "# Helix guide\n");
    const calls: string[][] = [];

    const result = installRuntime({
      configPath,
      guideDestination,
      guideSource,
      runClaude: (args) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ version: 1, settings: {}, hosts: {} });
    expect(fs.readFileSync(guideDestination, "utf8")).toBe("# Helix guide\n");
    expect(result).toMatchObject({ configCreated: true, registered: true, guidePath: guideDestination });
    expect(calls[0]).toEqual(["mcp", "remove", "--scope", "user", "helix-ssh"]);
    expect(calls[1]).toEqual([
      "mcp", "add", "helix-ssh", "--scope", "user",
      "--env", `HELIX_SSH_CONFIG=${configPath}`,
      "--env", `HELIX_AI_GUIDE=${guideDestination}`,
      "--", "helix-ssh-mcp",
    ]);
  });

  it("keeps an existing config file", () => {
    const temp = makeTemp();
    const configPath = path.join(temp, "ssh-mcp.json");
    const guideSource = path.join(temp, "guide.md");
    fs.writeFileSync(guideSource, "# g\n");
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, settings: { maxConcurrentCommands: 2 }, hosts: {} }));

    const result = installRuntime({
      configPath,
      guideDestination: path.join(temp, "HELIX_AI_GUIDE.md"),
      guideSource,
      runClaude: () => ({ status: 0 }),
    });

    expect(result.configCreated).toBe(false);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).settings).toEqual({ maxConcurrentCommands: 2 });
  });

  it("reports a missing Claude CLI without failing the runtime install", () => {
    const temp = makeTemp();
    const guideSource = path.join(temp, "guide.md");
    fs.writeFileSync(guideSource, "# g\n");

    const result = installRuntime({
      configPath: path.join(temp, "ssh-mcp.json"),
      guideDestination: path.join(temp, "HELIX_AI_GUIDE.md"),
      guideSource,
      runClaude: () => ({ status: null, error: new Error("spawn claude ENOENT") }),
    });

    expect(result.registered).toBe(false);
    expect(result.claudeError).toContain("ENOENT");
  });
});

const endpoints: string[] = [];
afterEach(() => {
  for (const endpoint of endpoints.splice(0)) {
    if (process.platform !== "win32") {
      try { fs.rmSync(endpoint, { force: true }); } catch { /* ignore */ }
    }
  }
});

function endpointFor(name: string): string {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\helix-cli-${name}-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `helix-cli-${name}-${process.pid}-${Date.now()}.sock`);
  endpoints.push(endpoint);
  return endpoint;
}

describe("stopDaemon", () => {
  it("reports not-running for a missing endpoint", async () => {
    expect(await stopDaemon(endpointFor("missing"), 500)).toBe("not-running");
  });

  it("asks a live daemon to shut down", async () => {
    const endpoint = endpointFor("live");
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        received.push(chunk);
        socket.end('{"ok":true}\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    try {
      expect(await stopDaemon(endpoint, 2000)).toBe("stopped");
      expect(received.join("")).toContain('"op":"shutdown"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
