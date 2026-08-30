import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const brokerBuildRoot = process.env.HELIX_SSH_MCP_BUILD
  ? path.resolve(process.env.HELIX_SSH_MCP_BUILD)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/ssh-mcp/build");
const {
  buildBrokerCredentialExistsRequest,
  buildBrokerExecuteRequest,
  buildBrokerPtyRequest,
  buildBrokerSudoExecuteRequest,
  buildBrokerTerminalOpenRequest,
  buildBrokerTransferRequest,
} = await import(pathToFileURL(path.join(brokerBuildRoot, "broker.js")).href);

const settings = {
  allowHostMutation: false,
  allowPolicyMutation: false,
  defaultTimeoutSeconds: 30,
  maxOutputBytes: 4096,
  maxConcurrentCommands: 2,
  strictHostKeyChecking: true,
  allowPersistentTerminal: true,
  auditEnabled: false,
  auditCommandMode: "plain",
};
const host = {
  hostname: "contract.example",
  port: 2222,
  username: "contract-user",
  allowedRemotePaths: ["/srv"],
  auth: { type: "windows-credential", credentialRef: "Helix/contract/login" },
  sudo: {
    mode: "reviewed-password",
    credentialRef: "Helix/contract/sudo",
    allow: ["^.*$"],
    approvalTtlSeconds: 60,
  },
};

const submit = (request) => ({ op: "submit", request });
const requests = [
  { op: "ping" },
  submit({ op: "ping" }),
  submit(buildBrokerCredentialExistsRequest("Helix/contract/login")),
  submit(buildBrokerExecuteRequest({
    credentialRef: "Helix/contract/login",
    host,
    command: "printf contract",
    settings,
  })),
  submit(buildBrokerPtyRequest({
    credentialRef: "Helix/contract/login",
    host,
    command: "bash -i",
    cols: 120,
    rows: 40,
    input: "echo contract",
    settings,
  })),
  submit(buildBrokerSudoExecuteRequest({
    loginCredentialRef: "Helix/contract/login",
    sudoCredentialRef: "Helix/contract/sudo",
    host,
    command: "id",
    settings,
  })),
  submit(buildBrokerTransferRequest({
    credentialRef: "Helix/contract/login",
    host,
    direction: "upload",
    localPath: "./contract.txt",
    remotePath: "/srv/contract.txt",
    recursive: false,
    settings,
  })),
  submit(buildBrokerTransferRequest({
    credentialRef: "Helix/contract/login",
    host,
    direction: "download",
    localPath: "./contract.txt",
    remotePath: "/srv/contract.txt",
    recursive: true,
    settings,
  })),
  {
    op: "task_status",
    task_id: "contract-task",
  },
  {
    op: "task_wait",
    task_id: "contract-task",
    timeout_seconds: 30,
  },
  {
    op: "task_cancel",
    task_id: "contract-task",
  },
  {
    op: "spool_read",
    result_ref: "contract-result",
    cursor: 0,
    max_bytes: 128,
  },
  { op: "spool_tail", result_ref: "contract-result", max_bytes: 128 },
  {
    op: "spool_search",
    result_ref: "contract-result",
    pattern: "contract",
    regex: false,
    before: 1,
    after: 1,
    max_matches: 5,
  },
  buildBrokerTerminalOpenRequest({
    settings,
    credentialRef: "Helix/contract/login",
    host,
    command: "bash -i",
    cols: 120,
    rows: 40,
    idleSeconds: 60,
    maxHistoryBytes: 4096,
  }),
  { op: "terminal_write", terminal_id: "contract-terminal", input: "echo contract\n" },
  { op: "terminal_exec", terminal_id: "contract-terminal", command: "echo contract" },
  { op: "terminal_read", terminal_id: "contract-terminal", cursor: 0, max_bytes: 128 },
  { op: "terminal_tail", terminal_id: "contract-terminal", max_bytes: 128 },
  {
    op: "terminal_search",
    terminal_id: "contract-terminal",
    pattern: "contract",
    regex: false,
    before: 1,
    after: 1,
    max_matches: 5,
  },
  { op: "terminal_resize", terminal_id: "contract-terminal", cols: 100, rows: 30 },
  { op: "terminal_status", terminal_id: "contract-terminal" },
  { op: "terminal_close", terminal_id: "contract-terminal" },
  { op: "shutdown" },
];

const fixture = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
const directory = await mkdtemp(path.join(os.tmpdir(), "helix-protocol-contract-"));
const fixturePath = path.join(directory, "requests.jsonl");
await writeFile(fixturePath, fixture, "utf8");

try {
  const command = process.platform === "win32" ? "cargo.exe" : "cargo";
const result = spawnSync(
    command,
    [
      "test",
      "--quiet",
      "-p",
      "helix-core",
      "--lib",
      "protocol::tests::protocol_contract_fixture",
      "--",
      "--exact",
      "--ignored",
    ],
    {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, HELIX_PROTOCOL_CONTRACT_FIXTURE: fixturePath },
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "Rust protocol contract test failed\n");
    process.exit(result.status ?? 1);
  }
  const cargoOutput = `${result.stdout}\n${result.stderr}`;
  if (!/running\s+1 test/.test(cargoOutput) || !/1 passed; 0 failed/.test(cargoOutput)) {
    process.stderr.write(cargoOutput);
    throw new Error("Rust protocol contract gate did not execute exactly one passing test");
  }
  process.stdout.write(`Protocol contract passed: ${requests.length} TS requests parsed by Rust serde.\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
