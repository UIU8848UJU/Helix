import { createConnection } from "node:net";
import {
  tempEndpoint, sleep, stats, row, rowStats, startDaemon, makeRpc,
} from "./helpers.mjs";

// Max / limit tests: connection capacity, request-size boundary, burst task
// throughput and saturation shutdown. Exits 0 only when all checks pass.
// The daemon enforces MAX_IPC_CONNECTIONS=64 active handlers and a
// MAX_REQUEST_BYTES=4MiB request line limit (apps/helixd/src/daemon.rs).

const endpoint = tempEndpoint("max");
const { daemon, rpc, waitForReady, stop } = startDaemon(endpoint, { workers: 4 });

let failed = 0;

try {
  const hello = await waitForReady();
  console.log(`== Helix max/limit test ==`);
  row("daemon", `${hello.protocolVersion} workers=4`);

  // 1. Connection capacity: 96 connections must all be accepted; the daemon
  //    runs 64 active handlers and queues the rest without dropping them.
  const CONN_TARGET = 96;
  const clients = [];
  for (let i = 0; i < CONN_TARGET; i += 1) {
    const socket = createConnection(endpoint);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("error", () => {});
    socket.write('{"op":"pi'); // partial request to keep the handler busy
    clients.push(socket);
  }
  row(`max concurrent connections`, `${clients.length}/${CONN_TARGET} held open (64 handler capacity, rest queued)`);
  const heldPings = [];
  for (let i = 0; i < 10; i += 1) {
    const started = performance.now();
    const response = await rpc({ op: "ping" }, 5000);
    heldPings.push(performance.now() - started);
    if (!response.ok) failed += 1;
  }
  rowStats("ping while 96 connections held", stats(heldPings));
  for (const socket of clients) socket.destroy();
  await sleep(300);

  // 2. Request size boundary: ~3MiB accepted, ~5MiB rejected cleanly.
  //    The daemon answers oversize requests with an error response instead of
  //    dropping the connection, so the client can see why it was refused.
  const searchPayload = (pattern) => ({
    op: "spool_search",
    result_ref: "spool://missing/stdout",
    pattern,
    regex: false,
    before: 0,
    after: 0,
    max_matches: 1,
  });
  try {
    const response = await rpc(searchPayload("x".repeat(3 * 1024 * 1024)), 8000);
    const sizeRejected = (response.error ?? "").includes("exceeds 4 MiB");
    if (sizeRejected) failed += 1;
    row("request ~3MiB (under 4MiB limit)", `accepted, error=${response.error ?? "none"}${sizeRejected ? " (UNEXPECTED SIZE REJECTION)" : ""}`);
  } catch (error) {
    failed += 1;
    row("request ~3MiB (under 4MiB limit)", `unexpected rejection: ${error.message}`);
  }
  let oversizedRejected = false;
  try {
    const response = await rpc(searchPayload("y".repeat(5 * 1024 * 1024)), 8000);
    oversizedRejected = response.ok === false && (response.error ?? "").includes("exceeds 4 MiB");
    row("request ~5MiB (over 4MiB limit)", oversizedRejected ? `rejected cleanly: ${response.error}` : `unexpectedly handled ok=${response.ok} error=${response.error ?? "none"}`);
  } catch (error) {
    oversizedRejected = !String(error.message).includes("timeout");
    row("request ~5MiB (over 4MiB limit)", oversizedRejected ? `connection dropped: ${error.message}` : `timeout: ${error.message}`);
  }
  if (!oversizedRejected) failed += 1;
  const alive = await rpc({ op: "ping" }, 5000);
  row("daemon responsive after oversized request", alive.ok ? "yes" : "no");
  if (!alive.ok) failed += 1;

  // 3. Burst task throughput: 64 clients x 20 submit+poll tasks.
  const BURST_CLIENTS = 64;
  const BURST_ROUNDS = 20;
  const wallStart = performance.now();
  let done = 0;
  let burstFailed = 0;
  await Promise.all(Array.from({ length: BURST_CLIENTS }, async () => {
    for (let r = 0; r < BURST_ROUNDS; r += 1) {
      try {
        const submitted = await rpc({ op: "submit", request: { op: "ping" } }, 5000);
        let status = submitted;
        for (let i = 0; i < 100 && !["succeeded", "failed", "cancelled"].includes(status.state); i += 1) {
          status = await rpc({ op: "task_status", task_id: submitted.taskId }, 5000);
        }
        if (status.state !== "succeeded") burstFailed += 1;
      } catch {
        burstFailed += 1;
      }
      done += 1;
    }
  }));
  const wallMs = performance.now() - wallStart;
  row(`burst submit (${BURST_CLIENTS} clients x ${BURST_ROUNDS})`, `${done} tasks in ${wallMs.toFixed(0)}ms -> ${(done / (wallMs / 1000)).toFixed(0)} task/s, failed=${burstFailed}`);
  if (burstFailed > 0) failed += burstFailed;

  // 4. Saturation shutdown: 64 non-reading large-response clients must not
  //    prevent a clean shutdown within the timeout.
  const taskId = "x".repeat(256 * 1024);
  const largeRequest = `${JSON.stringify({ op: "task_status", task_id: taskId })}\n`;
  const nonReaders = Array.from({ length: 64 }, () => {
    const socket = createConnection(endpoint);
    socket.on("connect", () => socket.write(largeRequest));
    socket.on("error", () => {});
    return socket;
  });
  await sleep(300);
  let shutdownOk = true;
  try {
    const response = await rpc({ op: "shutdown" }, 8000);
    if (!response.ok) shutdownOk = false;
  } catch {
    shutdownOk = false;
  }
  row("shutdown under 64 non-reading clients", shutdownOk ? "PASS" : "FAIL");
  if (!shutdownOk) failed += 1;
  for (const socket of nonReaders) socket.destroy();

  await Promise.race([
    new Promise((resolve) => daemon.once("exit", resolve)),
    sleep(2000),
  ]);
  if (daemon.exitCode === null) daemon.kill();

  row("max test result", failed === 0 ? "PASS" : `FAIL (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  console.error(`max test failed: ${error.message}`);
  daemon.kill();
  process.exit(1);
}
