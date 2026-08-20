import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";

// Helix benchmark: local daemon/IPC/MCP metrics plus an optional SSH phase.
//   node scripts/bench.mjs
//   node scripts/bench.mjs --ssh   (requires a reachable SSH host, see below)
// SSH phase env:
//   HELIX_BENCH_SSH_HOST=<hostname or IP>  (required for --ssh)
//   HELIX_BENCH_SSH_PORT=22
//   HELIX_BENCH_SSH_USER=<user>
//   HELIX_BENCH_SSH_IDENTITY=<path to key> (defaults to ~/.ssh/id_ed25519)
//   HELIX_BENCH_SSH_ROUNDS=20              (command round trips per phase)
// Optional overrides:
//   --bundle <path>   MCP bundle (default dist/helix-ssh-mcp.bundle.mjs)
//   --helixd <path>   daemon binary (default target/release/helixd(.exe))
//   --workers <n>     daemon workers (default 4)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const wantSsh = args.includes("--ssh");
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}
const bundlePath = argValue("--bundle", path.join(root, "dist", "helix-ssh-mcp.bundle.mjs"));
const helixdPath = argValue("--helixd", path.join(root, "target", "release", process.platform === "win32" ? "helixd.exe" : "helixd"));
const workers = Number(argValue("--workers", "4"));

const unique = `${process.pid}-${Date.now()}`;
const endpoint = process.platform === "win32"
  ? `\\\\.\\pipe\\helix-bench-${unique}`
  : `/tmp/helix-bench-${unique}.sock`;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}
function stats(samples) {
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
function row(label, value) {
  console.log(`${label.padEnd(42)} ${value}`);
}
function rowStats(label, s, unit = "ms") {
  console.log(
    `${label.padEnd(42)} n=${String(s.n).padStart(4)}  min=${s.min.toFixed(2)} avg=${s.avg.toFixed(2)} p50=${s.p50.toFixed(2)} p95=${s.p95.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)} ${unit}`,
  );
}

function rpc(request, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
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
    const child = spawn(process.execPath, [bundlePath], {
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
          // protocol handshake preamble, keep waiting
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
  const daemon = spawn(helixdPath, [
    "serve-daemon",
    "--endpoint", endpoint,
    "--workers", String(workers),
    "--queue-capacity", "64",
    "--task-retention-seconds", "600",
    "--session-idle-seconds", "120",
    "--max-idle-sessions-per-key", "2",
    "--mode", "harness",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let daemonStderr = "";
  daemon.stderr.setEncoding("utf8");
  daemon.stderr.on("data", (chunk) => { daemonStderr += chunk; });

  async function waitForDaemon() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await rpc({ op: "ping" }, 500);
        if (response.ok && response.protocolVersion) return response;
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    throw new Error(`daemon did not start: ${daemonStderr}`);
  }

  try {
    const hello = await waitForDaemon();
    row("daemon protocolVersion", String(hello.protocolVersion));
    row("daemon capabilities", (hello.capabilities ?? []).join(", "));

    // Phase B: ping RTT
    const pings = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      await rpc({ op: "ping" }, 2000);
      pings.push(performance.now() - started);
    }
    rowStats("B. daemon IPC ping RTT", stats(pings));

    // Phase C: concurrent ping throughput
    const concurrent = 64;
    const rounds = 20;
    const wallStart = performance.now();
    let completed = 0;
    const workers = Array.from({ length: concurrent }, async () => {
      for (let r = 0; r < rounds; r += 1) {
        await rpc({ op: "ping" }, 2000);
        completed += 1;
      }
    });
    await Promise.all(workers);
    const wallMs = performance.now() - wallStart;
    row(`C. concurrent ping (${concurrent} clients x ${rounds})`, `${completed} pings in ${wallMs.toFixed(0)}ms -> ${(completed / (wallMs / 1000)).toFixed(0)} req/s`);

    // Phase D: submit -> poll task round trip
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
    try { await rpc({ op: "shutdown" }, 2000); } catch { /* already gone */ }
    await Promise.race([
      new Promise((resolve) => daemon.once("exit", resolve)),
      sleep(2000),
    ]);
    if (daemon.exitCode === null) daemon.kill();
  }
}

// --- Phase E: daemon idle RSS --------------------------------------------
async function processRss(pid) {
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
function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
async function benchDaemonRss() {
  const daemon = spawn(helixdPath, [
    "serve-daemon",
    "--endpoint", `${endpoint}-rss`,
    "--workers", String(workers),
    "--queue-capacity", "64",
    "--task-retention-seconds", "600",
    "--mode", "harness",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let rssStderr = "";
  daemon.stderr.setEncoding("utf8");
  daemon.stderr.on("data", (chunk) => { rssStderr += chunk; });
  await sleep(1200);
  if (daemon.exitCode !== null) console.warn(`RSS daemon exited early (${daemon.exitCode}): ${rssStderr}`);
  const rss = await processRss(daemon.pid);
  if (rss === 0) console.warn(`RSS daemon pid=${daemon.pid} stderr: ${rssStderr}`);
  try { await rpc2(`${endpoint}-rss`, { op: "shutdown" }, 2000); } catch { /* noop */ }
  daemon.kill();
  return rss;
}
function rpc2(endpointOverride, request, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpointOverride);
    let buffer = "";
    let settled = false;
    const done = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => done(() => reject(new Error("timeout"))), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      done(() => { try { resolve(JSON.parse(buffer.slice(0, newline).trim())); } catch (error) { reject(error); } });
    });
    socket.on("error", (error) => done(() => reject(error)));
  });
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

  const child = spawn(process.execPath, [bundlePath], {
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
    if (!String(result).includes("helix-bench")) {
      console.warn(`round ${i} unexpected result: ${result}`);
    }
  }
  rowStats("F. SSH cold connect+exec", stats(cold));
  rowStats("F. SSH warm exec (system ssh)", stats(warm));

  // large-output round trip (spools/truncates through the direct path)
  const started = performance.now();
  const large = await call("ssh_exec", { host: "bench", command: "seq 1 200000", timeoutSeconds: 60 });
  const largeMs = performance.now() - started;
  row("F. large output 200k lines", `${largeMs.toFixed(0)}ms`);

  child.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
}

// --- main -----------------------------------------------------------------
console.log("== Helix benchmark ==");
console.log(`platform: ${process.platform} node: ${process.version}`);
console.log(`bundle: ${bundlePath}`);
console.log(`helixd: ${helixdPath}`);
console.log(`endpoint: ${endpoint}`);
console.log("");

const started = performance.now();
const mcpStartup = await benchMcpStartup();
rowStats("A. MCP bundle startup->initialize", mcpStartup);
console.log("");

await benchDaemon();
console.log("");

const rss = await benchDaemonRss();
row("E. daemon idle RSS", formatBytes(rss));
console.log("");

if (wantSsh) {
  await benchSsh();
  console.log("");
}

console.log(`== total bench time: ${((performance.now() - started) / 1000).toFixed(1)}s ==`);