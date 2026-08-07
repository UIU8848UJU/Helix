import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";

const PROTOCOL_VERSION = 1;
const root = process.cwd();
const executable = path.join(
  root,
  "apps",
  "credential-broker",
  "target",
  "release",
  process.platform === "win32" ? "helix-credential-broker.exe" : "helix-credential-broker",
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
    const timer = setTimeout(() => done(() => reject(new Error("IPC timeout"))), timeoutMs);
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
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { childStderr += chunk; });

try {
  const ping = await waitForDaemon();
  if (ping.workers !== 2) throw new Error(`expected workers=2, got ${ping.workers}`);

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

  const shutdown = await rpc({ op: "shutdown" });
  assertProtocol(shutdown);
  shutdownRequested = true;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2000),
  ]);
  if (child.exitCode === null) throw new Error("daemon did not exit after shutdown");
  if (child.exitCode !== 0) throw new Error(`daemon exited with ${child.exitCode}: ${childStderr}`);

  console.log(`Broker daemon IPC smoke test passed on ${process.platform}: ${endpoint}`);
} finally {
  if (!shutdownRequested || child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(1500),
    ]);
  }
}
