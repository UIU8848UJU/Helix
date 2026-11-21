import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs, stopDaemon } from "../src/cli.js";

describe("cli argument parsing", () => {
  it("keeps the stdio server as the default", () => {
    expect(parseCliArgs(["node", "bundle"])).toEqual({ kind: "server" });
    expect(parseCliArgs(["node", "bundle", "--unknown"])).toEqual({ kind: "server" });
  });

  it("parses help, stop and uninstall", () => {
    expect(parseCliArgs(["node", "bundle", "help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["node", "bundle", "--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["node", "bundle", "stop"])).toEqual({ kind: "stop" });
    expect(parseCliArgs(["node", "bundle", "uninstall"])).toEqual({ kind: "uninstall", purge: false });
    expect(parseCliArgs(["node", "bundle", "uninstall", "--purge"])).toEqual({ kind: "uninstall", purge: true });
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
