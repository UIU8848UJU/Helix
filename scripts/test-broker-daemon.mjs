import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";

const PROTOCOL_VERSION = 3;
const root = process.cwd();
const executable = path.join(
  root,
  "target",
  "release",
  process.platform === "win32" ? "helixd.exe" : "helixd",
);
const unique = `${process.pid}-${Date.now()}`;
const endpoint = process.platform === "win32"
  ? `\\\\.\\pipe\\helix-credential-broker-test-${unique}`
  : `/tmp/helix-credential-broker-test-${unique}.sock`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpc(request, timeoutMs = 2000) {
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

function assertProtocol(response) {
  if (response.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`expected protocolVersion=${PROTOCOL_VERSION}, got ${response.protocolVersion}`);
  }
  for (const capability of ["task_pool_v2", "bounded_ipc", "owner_only_ipc", "ssh_pty", "spool_v1"]) {
    if (!response.capabilities?.includes(capability)) {
      throw new Error(`missing daemon capability: ${capability}`);
    }
  }
}

async function openSlowClients(count) {
  const clients = Array.from({ length: count }, () => createConnection(endpoint));
  await Promise.all(clients.map((socket) => new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.on("error", () => {});
      socket.on("data", () => socket.destroy());
      socket.write('{"op":"ping"');
      resolve();
    });
    socket.once("error", reject);
  })));
  return clients;
}

function destroyClients(clients) {
  for (const socket of clients) socket.destroy();
}

async function openNonReadingLargeResponseClients(count) {
  const taskId = "x".repeat(256 * 1024);
  const request = `${JSON.stringify({ op: "task_status", task_id: taskId })}\n`;
  const clients = Array.from({ length: count }, () => createConnection(endpoint));
  await Promise.all(clients.map((socket) => new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.on("error", () => {});
      socket.write(request, (error) => error ? reject(error) : resolve());
    });
    socket.once("error", reject);
  })));
  return clients;
}

async function waitForDaemon() {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await rpc({ op: "ping" }, 500);
      if (response.ok) {
        assertProtocol(response);
        return response;
      }
      lastError = new Error(response.error ?? "ping returned ok=false");
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error("daemon did not start");
}

async function assertOwnerOnlyPipeAcl() {
  if (process.platform !== "win32") return;
  const probe = spawn(executable, ["daemon-acl", "--endpoint", endpoint], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  probe.stdout.setEncoding("utf8");
  probe.stderr.setEncoding("utf8");
  probe.stdout.on("data", (chunk) => { stdout += chunk; });
  probe.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => probe.once("exit", resolve));
  if (code !== 0) throw new Error(`ACL probe failed: ${stderr}`);
  if (!stdout.includes("D:P") || stdout.includes(";;;WD)") || stdout.includes(";;;AN)")) {
    throw new Error(`named pipe ACL is not owner-only: ${stdout.trim()}`);
  }
}

const child = spawn(executable, [
  "serve-daemon",
  "--endpoint", endpoint,
  "--workers", "2",
  "--queue-capacity", "8",
  "--task-retention-seconds", "60",
  "--session-idle-seconds", "30",
  "--max-idle-sessions-per-key", "1",
], {
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});

let childStderr = "";
let shutdownRequested = false;
let writeSaturationChild;
const startupRaceChildren = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { childStderr += chunk; });

try {
  const ping = await waitForDaemon();
  if (ping.workers !== 2) throw new Error(`expected workers=2, got ${ping.workers}`);
  await assertOwnerOnlyPipeAcl();

  const [slowClient] = await openSlowClients(1);
  const concurrentPing = await rpc({ op: "ping" });
  assertProtocol(concurrentPing);
  slowClient.destroy();

  const submitted = await rpc({ op: "submit", request: { op: "ping" } });
  assertProtocol(submitted);
  if (!submitted.ok || !submitted.taskId) {
    throw new Error(`submit failed: ${JSON.stringify(submitted)}`);
  }

  let status = submitted;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    status = await rpc({ op: "task_status", task_id: submitted.taskId });
    assertProtocol(status);
    if (["succeeded", "failed", "cancelled"].includes(status.state)) break;
    await sleep(50);
  }

  if (status.state !== "succeeded") {
    throw new Error(`broker task did not succeed: ${JSON.stringify(status)}`);
  }
  if (!status.result?.ok) {
    throw new Error(`nested broker result was not successful: ${JSON.stringify(status)}`);
  }

  const saturatedClients = await openSlowClients(64);
  const recoveredPing = await rpc({ op: "ping" }, 8000);
  assertProtocol(recoveredPing);
  if (!recoveredPing.ok) {
    throw new Error(`daemon did not recover after handler saturation: ${JSON.stringify(recoveredPing)}`);
  }
  destroyClients(saturatedClients);

  const shutdownSaturation = await openSlowClients(64);
  const saturatedReadShutdown = await rpc({ op: "shutdown" }, 8000);
  assertProtocol(saturatedReadShutdown);
  destroyClients(shutdownSaturation);
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2000),
  ]);
  if (child.exitCode === null) throw new Error("daemon did not exit after read saturation shutdown");

  writeSaturationChild = spawn(executable, [
    "serve-daemon",
    "--endpoint", endpoint,
    "--workers", "2",
    "--queue-capacity", "8",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  writeSaturationChild.stderr.on("data", (chunk) => { childStderr += chunk; });
  await waitForDaemon();
  const nonReaders = await openNonReadingLargeResponseClients(64);
  const shutdown = await rpc({ op: "shutdown" }, 8000);
  assertProtocol(shutdown);
  destroyClients(nonReaders);
  shutdownRequested = true;
  await Promise.race([
    new Promise((resolve) => writeSaturationChild.once("exit", resolve)),
    sleep(2000),
  ]);
  if (writeSaturationChild.exitCode === null) {
    writeSaturationChild.kill();
    throw new Error("daemon did not exit after write saturation shutdown");
  }
  if (writeSaturationChild.exitCode !== 0) {
    throw new Error(`write saturation daemon exited with ${writeSaturationChild.exitCode}: ${childStderr}`);
  }

  for (let index = 0; index < 2; index += 1) {
    startupRaceChildren.push(spawn(executable, [
      "serve-daemon",
      "--endpoint", endpoint,
      "--workers", "1",
      "--queue-capacity", "2",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }));
    startupRaceChildren[index].stderr.on("data", (chunk) => { childStderr += chunk; });
  }
  const raceWinner = await waitForDaemon();
  assertProtocol(raceWinner);
  await sleep(250);
  const alive = startupRaceChildren.filter((process) => process.exitCode === null);
  if (alive.length !== 1) {
    throw new Error(`expected one daemon startup winner, got ${alive.length}`);
  }
  const losers = startupRaceChildren.filter((process) => process.exitCode !== null);
  if (losers.length !== 1 || losers[0].exitCode !== 0) {
    throw new Error(`startup-race loser did not converge successfully: ${losers.map((p) => p.exitCode)}`);
  }
  await rpc({ op: "shutdown" });
  await Promise.race([new Promise((resolve) => alive[0].once("exit", resolve)), sleep(2000)]);
  if (alive[0].exitCode === null) throw new Error("startup-race winner did not shut down");

  console.log(`helixd daemon IPC smoke test passed on ${process.platform}: ${endpoint}`);
} finally {
  if (!shutdownRequested || child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(1500),
    ]);
  }
  if (writeSaturationChild?.exitCode === null) {
    writeSaturationChild.kill();
    await Promise.race([
      new Promise((resolve) => writeSaturationChild.once("exit", resolve)),
      sleep(1500),
    ]);
  }
  for (const process of startupRaceChildren) {
    if (process.exitCode === null) process.kill();
  }
}
