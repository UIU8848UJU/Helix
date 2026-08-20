import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Shared helpers for the Helix verification scripts under tests/.
// Binary/config overrides:
//   HELIX_HELIXD=<path>   daemon binary (default target/release/helixd(.exe))
//   HELIX_BUNDLE=<path>   MCP bundle (default dist/helix-ssh-mcp.bundle.mjs)

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function helixdPath() {
  return process.env.HELIX_HELIXD
    ?? path.join(root, "target", "release", process.platform === "win32" ? "helixd.exe" : "helixd");
}

export function bundlePath() {
  return process.env.HELIX_BUNDLE ?? path.join(root, "dist", "helix-ssh-mcp.bundle.mjs");
}

export function tempEndpoint(tag) {
  const unique = `${process.pid}-${Date.now()}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\helix-${tag}-${unique}`
    : `/tmp/helix-${tag}-${unique}.sock`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    avg: sum / (sorted.length || 1),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function row(label, value) {
  console.log(`${label.padEnd(42)} ${value}`);
}

export function rowStats(label, s, unit = "ms") {
  console.log(
    `${label.padEnd(42)} n=${String(s.n).padStart(4)}  min=${s.min.toFixed(2)} avg=${s.avg.toFixed(2)} p50=${s.p50.toFixed(2)} p95=${s.p95.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)} ${unit}`,
  );
}

export function makeRpc(endpoint, defaultTimeoutMs = 5000) {
  return (request, timeoutMs = defaultTimeoutMs) => new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const done = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`IPC timeout for ${String(request.op)}`))),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const payload = buffer.slice(0, newline).trim();
      done(() => {
        try {
          resolve(JSON.parse(payload));
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.on("error", (error) => done(() => reject(error)));
  });
}

export function startDaemon(endpoint, options = {}) {
  const {
    workers = 4,
    queueCapacity = 64,
    retentionSeconds = 600,
    sessionIdleSeconds = 120,
    maxIdleSessions = 2,
    mode = "harness",
  } = options;
  const daemon = spawn(helixdPath(), [
    "serve-daemon",
    "--endpoint", endpoint,
    "--workers", String(workers),
    "--queue-capacity", String(queueCapacity),
    "--task-retention-seconds", String(retentionSeconds),
    "--session-idle-seconds", String(sessionIdleSeconds),
    "--max-idle-sessions-per-key", String(maxIdleSessions),
    "--mode", mode,
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  daemon.stderr.setEncoding("utf8");
  daemon.stderr.on("data", (chunk) => { stderr += chunk; });
  const rpc = makeRpc(endpoint);

  async function waitForReady() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await rpc({ op: "ping" }, 500);
        if (response.ok && response.protocolVersion) return response;
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    throw new Error(`daemon did not start: ${stderr}`);
  }

  async function stop() {
    try { await rpc({ op: "shutdown" }, 2000); } catch { /* already gone */ }
    await Promise.race([
      new Promise((resolve) => daemon.once("exit", resolve)),
      sleep(2000),
    ]);
    if (daemon.exitCode === null) daemon.kill();
  }

  return { daemon, rpc, waitForReady, stop, stderr: () => stderr };
}

export async function rssOf(pid) {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const child = spawn("tasklist", ["/FO", "CSV", "/FI", `PID eq ${pid}`], { windowsHide: true });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.on("close", () => {
        for (const line of output.split(/\r?\n/)) {
          const columns = line.split('","').map((value) => value.replace(/^"|"$/g, ""));
          if (columns[1] === String(pid) && columns[4]) {
            resolve(Number(columns[4].replace(/[^\d]/g, "")) * 1024);
            return;
          }
        }
        resolve(0);
      });
      child.on("error", () => resolve(0));
    });
  }
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function openSlowClients(endpoint, count, partial = '{"op":"pi') {
  const clients = Array.from({ length: count }, () => createConnection(endpoint));
  return Promise.all(clients.map((socket) => new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.on("error", () => {});
      socket.write(partial);
      resolve(socket);
    });
    socket.once("error", reject);
  })));
}

export function destroyClients(clients) {
  for (const socket of clients) socket.destroy();
}