import { createConnection } from "node:net";
import {
  tempEndpoint, sleep, stats, row, rowStats, startDaemon, rssOf, formatBytes,
  openSlowClients, destroyClients,
} from "./helpers.mjs";

// Stress test: sustained mixed load, head-of-line blocking resilience and
// daemon memory drift. Exits 0 only when no failures/timeouts are observed.
// Env:
//   HELIX_STRESS_DURATION_MS=8000   soak duration
//   HELIX_STRESS_CLIENTS=64         concurrent workers during soak
//   HELIX_STRESS_SLOW_CLIENTS=64    slow clients during saturation phase
//   HELIX_STRESS_PING_P99_MS=500    max acceptable ping p99 under saturation

const DURATION_MS = Number(process.env.HELIX_STRESS_DURATION_MS ?? "8000");
const CLIENTS = Number(process.env.HELIX_STRESS_CLIENTS ?? "64");
const SLOW_CLIENTS = Number(process.env.HELIX_STRESS_SLOW_CLIENTS ?? "64");
const PING_P99_LIMIT_MS = Number(process.env.HELIX_STRESS_PING_P99_MS ?? "500");

const endpoint = tempEndpoint("stress");
const { daemon, rpc, waitForReady, stop } = startDaemon(endpoint, { workers: 4 });

let failures = 0;
let timeouts = 0;
let ops = 0;
let counter = 0;

try {
  const hello = await waitForReady();
  console.log(`== Helix stress ==`);
  row("daemon", `${hello.protocolVersion} workers=4`);
  row("soak", `${CLIENTS} clients x ${DURATION_MS}ms`);
  const rssStart = await rssOf(daemon.pid);

  // Phase 1: sustained mixed load (ping / submit+poll)
  const endAt = Date.now() + DURATION_MS;
  const soakLatency = [];
  await Promise.all(Array.from({ length: CLIENTS }, async () => {
    while (Date.now() < endAt) {
      const started = performance.now();
      try {
        counter += 1;
        if (counter % 3 === 0) {
          const submitted = await rpc({ op: "submit", request: { op: "ping" } }, 3000);
          if (counter % 9 === 0 && submitted.taskId) {
            let status = submitted;
            for (let i = 0; i < 60 && !["succeeded", "failed", "cancelled"].includes(status.state); i += 1) {
              status = await rpc({ op: "task_status", task_id: submitted.taskId }, 3000);
            }
            if (status.state !== "succeeded") failures += 1;
          }
        } else {
          await rpc({ op: "ping" }, 3000);
        }
        ops += 1;
        soakLatency.push(performance.now() - started);
      } catch (error) {
        if (String(error.message).includes("timeout")) timeouts += 1;
        else failures += 1;
      }
    }
  }));
  rowStats("stress soak latency", stats(soakLatency));
  row(`stress soak result`, `${ops} ops, ${failures} failures, ${timeouts} timeouts, ${(ops / (DURATION_MS / 1000)).toFixed(0)} ops/s`);

  // Phase 2: slow-client head-of-line blocking resilience
  const slowClients = await openSlowClients(endpoint, SLOW_CLIENTS);
  const pings = [];
  for (let i = 0; i < 100; i += 1) {
    const started = performance.now();
    // The daemon releases slots occupied by slow clients within its 5s IPC
    // deadline, so an individual ping may legitimately wait ~5s. Give the
    // client side headroom and score the result via the p99 gate below.
    try {
      const response = await rpc({ op: "ping" }, 10000);
      if (!response.ok) failures += 1;
    } catch (error) {
      if (String(error.message).includes("timeout")) timeouts += 1;
      else failures += 1;
    }
    pings.push(performance.now() - started);
  }
  destroyClients(slowClients);
  const p99 = stats(pings).p99;
  rowStats("stress ping under slow-client saturation", stats(pings));
  if (p99 > PING_P99_LIMIT_MS) {
    failures += 1;
    row(`stress saturation p99 limit`, `p99=${p99.toFixed(1)}ms exceeds ${PING_P99_LIMIT_MS}ms`);
  }

  const rssEnd = await rssOf(daemon.pid);
  row("stress daemon RSS", `start=${formatBytes(rssStart)} end=${formatBytes(rssEnd)} delta=${formatBytes(rssEnd - rssStart)}`);

  const ok = failures === 0 && timeouts === 0;
  row("stress result", ok ? "PASS" : "FAIL");
  await stop();
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(`stress failed: ${error.message}`);
  daemon.kill();
  process.exit(1);
}
