#!/usr/bin/env node
/**
 * Smoke-test a bundled MCP server over stdio: initialize, list tools, call
 * host_list. Exits non-zero on any protocol or registration failure.
 *
 * Usage: node scripts/package/smoke-mcp.mjs <path-to-helix-ssh-mcp.mjs>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bundle = path.resolve(process.argv[2] ?? "");
if (!bundle || !fs.existsSync(bundle)) {
  console.error(`missing bundle: ${process.argv[2]}`);
  process.exit(1);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-smoke-"));
const configPath = path.join(temp, "ssh-mcp.json");
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      version: 1,
      settings: {},
      hosts: {
        smoke: {
          hostname: "127.0.0.1",
          port: 2222,
          username: "nobody",
          allowedRemotePaths: ["/"],
          auth: { type: "windows-credential", credentialRef: "Helix/ssh/smoke/login" },
          sudo: { mode: "disabled", allow: ["^.*$"], approvalTtlSeconds: 300 },
        },
      },
    },
    null,
    2,
  ),
);

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const child = spawn(process.execPath, [bundle], {
  env: { ...process.env, HELIX_SSH_CONFIG: configPath },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let stderr = "";
const responses = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      const message = JSON.parse(line);
      responses.set(message.id, message);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const waitFor = async (id, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (responses.has(id)) return responses.get(id);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no response for ${id}; stderr=${stderr}`);
};

try {
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      },
    })}\n`,
  );
  const init = await waitFor(1);
  check("initialize", init.result?.serverInfo?.name === "helix-ssh", JSON.stringify(init.result?.serverInfo));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  const tools = await waitFor(2);
  const names = new Set((tools.result?.tools ?? []).map((tool) => tool.name));
  for (const required of ["ssh_check", "ssh_upload", "task_status", "task_watch", "task_cancel"]) {
    check(`tool ${required}`, names.has(required));
  }
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "host_list", arguments: {} },
    })}\n`,
  );
  const hostList = await waitFor(3);
  check("host_list call", Array.isArray(hostList.result?.content), JSON.stringify(hostList.result?.isError));
} catch (error) {
  check("stdio session", false, error.message);
} finally {
  child.stdin.end();
  child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "MCP SMOKE PASSED" : `MCP SMOKE FAILED: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
