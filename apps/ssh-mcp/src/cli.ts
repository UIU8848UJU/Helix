import fs from "node:fs";
import net from "node:net";
import { BROKER_ENDPOINT } from "./broker.js";
import { getConfigPath } from "./paths.js";

export type CliCommand =
  | { kind: "server" }
  | { kind: "help" }
  | { kind: "stop" }
  | { kind: "uninstall"; purge: boolean };

/** Parse the optional CLI verb. No verb keeps the stdio MCP server behavior. */
export function parseCliArgs(argv: string[]): CliCommand {
  const verb = argv[2];
  if (!verb) return { kind: "server" };
  if (verb === "help" || verb === "--help" || verb === "-h") return { kind: "help" };
  if (verb === "stop") return { kind: "stop" };
  if (verb === "uninstall") return { kind: "uninstall", purge: argv.includes("--purge") };
  return { kind: "server" };
}

export function cliUsage(): string {
  return [
    "Usage: helix-ssh-mcp [command]",
    "",
    "  (no command)     Run the MCP server over stdio.",
    "  stop             Stop the running helixd daemon.",
    "  uninstall        Stop the daemon and print the remaining uninstall steps.",
    "  uninstall --purge  Also delete the local ssh-mcp.json config file.",
    "  help             Show this help.",
  ].join("\n");
}

export type StopResult = "stopped" | "not-running" | "timeout";

/**
 * Ask the daemon to shut down through its JSON IPC endpoint. A missing
 * endpoint means the daemon was already stopped.
 */
export async function stopDaemon(endpoint: string = BROKER_ENDPOINT, timeoutMs = 3000): Promise<StopResult> {
  return await new Promise<StopResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const socket = net.createConnection(endpoint);
    const finish = (result: StopResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("connect", () => socket.write('{"op":"shutdown"}\n'));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) finish("stopped");
    });
    socket.on("error", () => finish("not-running"));
  });
}

/**
 * Handle CLI commands. Returns `undefined` when the caller should start the
 * stdio MCP server, otherwise the process exit code.
 */
export async function runCli(argv: string[]): Promise<number | undefined> {
  const command = parseCliArgs(argv);
  if (command.kind === "server") return undefined;
  if (command.kind === "help") {
    process.stdout.write(`${cliUsage()}\n`);
    return 0;
  }

  const result = await stopDaemon();
  const detail = result === "stopped"
    ? "daemon: stopped"
    : result === "not-running"
      ? "daemon: not running"
      : "daemon: stop timed out";
  process.stdout.write(`${detail}\n`);
  if (command.kind === "stop") return result === "timeout" ? 1 : 0;

  const configPath = getConfigPath();
  if (command.purge) {
    if (fs.existsSync(configPath)) {
      fs.rmSync(configPath);
      process.stdout.write(`config: removed ${configPath}\n`);
    } else {
      process.stdout.write(`config: no file at ${configPath}\n`);
    }
  } else {
    process.stdout.write(`config: kept at ${configPath}\n`);
  }
  process.stdout.write(
    "next: claude mcp remove helix-ssh; npm uninstall -g helix-ssh-mcp helixd-win32-x64\n",
  );
  return result === "timeout" ? 1 : 0;
}
