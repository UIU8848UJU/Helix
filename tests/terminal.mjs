import { tempEndpoint, row, sleep, startDaemon } from "./helpers.mjs";

// End-to-end persistent terminal verification over the daemon IPC protocol.
// Requires a reachable SSH host plus a stored credential (Windows credential
// manager entry). Overrides:
//   HELIX_SSH_HOST / HELIX_SSH_PORT / HELIX_SSH_USER
//   HELIX_SSH_CRED_REF   (default Helix/ssh/build-password/login)
// Without a host the protocol-level checks (v5 + terminal_v1) still run.

const HOST = process.env.HELIX_SSH_HOST ?? "192.168.0.110";
const PORT = Number(process.env.HELIX_SSH_PORT ?? "22");
const USER = process.env.HELIX_SSH_USER ?? "nvidia";
const CRED = process.env.HELIX_SSH_CRED_REF ?? "Helix/ssh/build-password/login";

const endpoint = tempEndpoint("terminal");
const { daemon, rpc, waitForReady } = startDaemon(endpoint, { workers: 4 });
let failed = 0;
let terminalId = null;

function check(condition, label, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ""}`);
  }
}

try {
  const hello = await waitForReady();
  console.log(`== Helix terminal integration ==`);
  row("daemon", `v${hello.protocolVersion}`);
  check(hello.protocolVersion === 5, "protocol v5", `got ${hello.protocolVersion}`);
  check(hello.capabilities.includes("terminal_v1"), "terminal_v1 capability");

  // 1. open a persistent bash session
  console.log(`\n[1] terminal_open -> ${USER}@${HOST}:${PORT}`);
  let open;
  try {
    open = await rpc({
      op: "terminal_open",
      credential_ref: CRED,
      host: HOST,
      port: PORT,
      username: USER,
      command: "bash --norc -i",
      strict_host_key_checking: false,
      cols: 120,
      rows: 40,
      idle_seconds: 300,
      max_history_bytes: 4 * 1024 * 1024,
    }, 30_000);
  } catch (error) {
    console.log(`  SKIP  SSH phase unavailable: ${error.message}`);
    await cleanup();
    process.exit(failed === 0 ? 0 : 1);
  }
  terminalId = open.terminal?.terminalId;
  check(Boolean(terminalId), "open returns terminalId", String(open.error ?? ""));
  check(open.terminal?.state === "running", "state is running", String(open.terminal?.state));

  // 2. status -> summary envelope
  console.log(`\n[2] terminal_status`);
  const status = await rpc({ op: "terminal_status", terminal_id: terminalId }, 10_000);
  check(status.ok && status.terminal?.terminalId === terminalId, "status returns summary");
  check(status.terminal?.state === "running", "summary state running");
  check(typeof status.terminal?.tail === "string", "summary has tail");

  // 3. write a command and wait for its output
  console.log(`\n[3] terminal_write + read`);
  const write = await rpc({ op: "terminal_write", terminal_id: terminalId, input: "echo HELIX_TERM_MARKER_42\n" }, 10_000);
  check(write.ok, "write accepted");
  let content = "";
  for (let i = 0; i < 40 && !content.includes("HELIX_TERM_MARKER_42"); i += 1) {
    await sleep(250);
    const read = await rpc({ op: "terminal_read", terminal_id: terminalId, cursor: 0, max_bytes: 64 * 1024 }, 10_000);
    content = read.terminal?.content ?? "";
  }
  check(content.includes("HELIX_TERM_MARKER_42"), "echo output captured", `len=${content.length}`);

  // 4. cursor read semantics
  console.log(`\n[4] terminal_read cursor`);
  const first = await rpc({ op: "terminal_read", terminal_id: terminalId, cursor: 0, max_bytes: 16 }, 10_000);
  const nextCursor = first.terminal?.nextCursor ?? 0;
  check(nextCursor > 0, "read returns nextCursor", String(nextCursor));
  const second = await rpc({ op: "terminal_read", terminal_id: terminalId, cursor: nextCursor, max_bytes: 16 }, 10_000);
  check(second.ok, "cursor read continues");

  // 5. tail
  console.log(`\n[5] terminal_tail`);
  const tail = await rpc({ op: "terminal_tail", terminal_id: terminalId, max_bytes: 1024 }, 10_000);
  check(tail.ok && (tail.terminal?.content?.length ?? 0) > 0, "tail returns content");

  // 6. search
  console.log(`\n[6] terminal_search`);
  const search = await rpc({ op: "terminal_search", terminal_id: terminalId, pattern: "HELIX_TERM_MARKER", regex: false, before: 0, after: 0, max_matches: 10 }, 10_000);
  check(search.ok && (search.terminal?.matches?.length ?? 0) >= 1, "search finds marker", `matches=${search.terminal?.matches?.length}`);

  // 7. resize
  console.log(`\n[7] terminal_resize`);
  const resize = await rpc({ op: "terminal_resize", terminal_id: terminalId, cols: 200, rows: 50 }, 10_000);
  check(resize.ok, "resize accepted");

  // 8. close
  console.log(`\n[8] terminal_close`);
  const close = await rpc({ op: "terminal_close", terminal_id: terminalId }, 15_000);
  check(close.ok, "close accepted");
  const gone = await rpc({ op: "terminal_status", terminal_id: terminalId }, 5_000).catch(() => null);
  check(!gone?.ok, "session gone after close");
  terminalId = null;
} catch (error) {
  failed += 1;
  console.error(`terminal test failed: ${error.message}`);
} finally {
  if (terminalId) {
    await rpc({ op: "terminal_close", terminal_id: terminalId }, 10_000).catch(() => undefined);
  }
  await cleanup();
}

async function cleanup() {
  try { await rpc({ op: "shutdown" }, 2000); } catch { /* already gone */ }
  await Promise.race([
    new Promise((resolve) => daemon.once("exit", resolve)),
    sleep(2000),
  ]);
  if (daemon.exitCode === null) daemon.kill();
}

console.log(`\n== terminal verification ${failed === 0 ? "PASSED" : `FAILED (${failed})`} ==`);
process.exit(failed === 0 ? 0 : 1);
