import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  root, helixdPath, bundlePath, tempEndpoint, sleep, stats, row, rowStats,
  makeRpc, startDaemon, rssOf, formatBytes,
} from "./helpers.mjs";

// Baseline benchmark: MCP startup, daemon IPC latency/throughput, task RTT,
// daemon RSS, and (optional) SSH cold/warm/large-output metrics.
//   node tests/bench.mjs
//   node tests/bench.mjs --ssh   (requires a reachable SSH host, see below)
// SSH env:
//   HELIX_BENCH_SSH_HOST=<hostname or IP>  (required for --ssh)
//   HELIX_BENCH_SSH_PORT=22
//   HELIX_BENCH_SSH_USER=<user>
//   HELIX_BENCH_SSH_IDENTITY=<path to key> (defaults to ~/.ssh/id_ed25519)
//   HELIX_BENCH_SSH_ROUNDS=20
// Overrides: --bundle <path>, --helixd <path>, --workers <n>

const args = process.argv.slice(2);
const wantSsh = args.includes("--ssh");
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const bundle = argValue("--bundle", bundlePath());
const helixd = argValue("--helixd", helixdPath());
const workers = Number(argValue("--workers", "4"));
const endpoint = tempEndpoint("bench");

function rpc(request, timeoutMs = 5000) {
  return makeRpc(endpoint)(request, timeoutMs);
}

// --- Phase A: MCP bundle startup latency ---------------------------------
async function benchMcpStartup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "helix-bench-"));
  const configPath = path.join(configDir, "ssh-mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    settings: {
      allowHostMutation: true,
      allowPolicyMutation: true,
      defaultTimeoutSeconds: 60,
      maxOutputBytes: 1048576,
      maxConcurrentCommands: 4,
      strictHostKeyChecking: false,
      auditEnabled: true,
      auditCommandMode: "plain",
    },
    hosts: {},
  }));
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const child = spawn(process.execPath, [bundle], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, HELIX_SSH_CONFIG: configPath },
      windowsHide: true,
    });
    const started = performance.now();
    const elapsed = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("initialize timeout")), 10000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            clearTimeout(timer);
            resolve(performance.now() - started);
          }
        } catch {
          // handshake preamble
        }
      });
      child.on("error", reject);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0.0.0" } },
      }) + "\n");
    });
    samples.push(elapsed);
    child.kill();
    await sleep(50);
  }
  fs.rmSync(configDir, { recursive: true, force: true });
  return stats(samples);
}

// --- Phase B/C/D: daemon IPC ---------------------------------------------
async function benchDaemon() {
  const { daemon, waitForReady, stop } = startDaemon(endpoint, { workers });
  try {
    const hello = await waitForReady();
    row("daemon protocolVersion", String(hello.protocolVersion));
    row("daemon capabilities", (hello.capabilities ?? []).join(", "));

    const pings = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      await rpc({ op: "ping" }, 2000);
      pings.push(performance.now() - started);
    }
    rowStats("B. daemon IPC ping RTT", stats(pings));

    const concurrent = 64;
    const rounds = 20;
    const wallStart = performance.now();
    let completed = 0;
    await Promise.all(Array.from({ length: concurrent }, async () => {
      for (let r = 0; r < rounds; r += 1) {
        await rpc({ op: "ping" }, 2000);
        completed += 1;
      }
    }));
    const wallMs = performance.now() - wallStart;
    row(`C. concurrent ping (${concurrent} clients x ${rounds})`, `${completed} pings in ${wallMs.toFixed(0)}ms -> ${(completed / (wallMs / 1000)).toFixed(0)} req/s`);

    const tasks = [];
    for (let i = 0; i < 50; i += 1) {
      const started = performance.now();
      const submitted = await rpc({ op: "submit", request: { op: "ping" } }, 2000);
      let status = submitted;
      for (let attempt = 0; attempt < 100 && !["succeeded", "failed", "cancelled"].includes(status.state); attempt += 1) {
        status = await rpc({ op: "task_status", task_id: submitted.taskId }, 2000);
      }
      tasks.push(performance.now() - started);
    }
    rowStats("D. task submit->succeeded RTT", stats(tasks));
  } finally {
    await stop();
  }
}

// --- Phase E: daemon idle RSS --------------------------------------------
async function benchDaemonRss() {
  const rssEndpoint = `${endpoint}-rss`;
  const { daemon, stop } = startDaemon(rssEndpoint, { workers });
  await sleep(1200);
  const rss = await rssOf(daemon.pid);
  await stop();
  return rss;
}

// --- Phase F (optional): SSH metrics via MCP ssh_exec ---------------------
async function benchSsh() {
  const host = process.env.HELIX_BENCH_SSH_HOST;
  if (!host) throw new Error("--ssh requires HELIX_BENCH_SSH_HOST");
  const port = Number(process.env.HELIX_BENCH_SSH_PORT ?? "22");
  const user = process.env.HELIX_BENCH_SSH_USER ?? "root";
  const identity = process.env.HELIX_BENCH_SSH_IDENTITY ?? path.join(os.homedir(), ".ssh", "id_ed25519");
  const rounds = Number(process.env.HELIX_BENCH_SSH_ROUNDS ?? "20");

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "helix-bench-ssh-"));
  const configPath = path.join(configDir, "ssh-mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    settings: {
      allowHostMutation: true,
      allowPolicyMutation: true,
      defaultTimeoutSeconds: 60,
      maxOutputBytes: 1048576,
      maxConcurrentCommands: 4,
      strictHostKeyChecking: false,
      auditEnabled: true,
      auditCommandMode: "plain",
    },
    hosts: {
      bench: {
        hostname: host,
        port,
        username: user,
        identityFile: identity,
        tags: ["benchmark"],
        allowedRemotePaths: ["/tmp"],
        auth: { type: "openssh" },
        sudo: { mode: "disabled" },
      },
    },
  }));

  const child = spawn(process.execPath, [bundle], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HELIX_SSH_CONFIG: configPath },
    windowsHide: true,
  });
  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id && pending.has(message.id)) {
          const { resolve, timer } = pending.get(message.id);
          clearTimeout(timer);
          pending.delete(message.id);
          resolve(message);
        }
      } catch {
        // handshake line
      }
    }
  });
  child.stdin.on("error", () => {});
  function call(tool, arguments_) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`tool timeout: ${tool}`));
      }, 120000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: arguments_ } }) + "\n");
    });
  }
  await new Promise((resolve) => {
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline).trim());
        if (message.id === 1) {
          child.stdout.off("data", onData);
          resolve();
        }
      } catch { /* keep waiting */ }
    };
    child.stdout.on("data", onData);
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench-ssh", version: "0.0.0" } },
    }) + "\n");
  });

  console.log(`SSH target: ${user}@${host}:${port} (identity=${identity})`);
  const cold = [];
  const warm = [];
  for (let i = 0; i < rounds; i += 1) {
    const started = performance.now();
    const response = await call("ssh_exec", { host: "bench", command: "echo helix-bench" });
    const elapsed = performance.now() - started;
    if (i === 0) cold.push(elapsed);
    else warm.push(elapsed);
    const result = response.result?.content?.[0]?.text ?? "{}";
    if (!String(result).includes("helix-bench")) console.warn(`round ${i} unexpected result: ${result}`);
  }
  rowStats("F. SSH cold connect+exec", stats(cold));
  rowStats("F. SSH warm exec (system ssh)", stats(warm));

  const started = performance.now();
  const large = await call("ssh_exec", { host: "bench", command: "seq 1 200000", timeoutSeconds: 60 });
  row("F. large output 200k lines", `${(performance.now() - started).toFixed(0)}ms`);

  child.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
}

// --- main -----------------------------------------------------------------
console.log("== Helix benchmark ==");
console.log(`platform: ${process.platform} node: ${process.version}`);
console.log(`bundle: ${bundle}`);
console.log(`helixd: ${helixd}`);
console.log(`endpoint: ${endpoint}`);
console.log("");

const started = performance.now();
rowStats("A. MCP bundle startup->initialize", await benchMcpStartup());
console.log("");
await benchDaemon();
console.log("");

row("E. daemon idle RSS", formatBytes(await benchDaemonRss()));
console.log("");

if (wantSsh) {
  await benchSsh();
  console.log("");
}

console.log(`== total bench time: ${((performance.now() - started) / 1000).toFixed(1)}s ==`);