import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROKER_ENDPOINT } from "./broker.js";
import { getConfigPath } from "./paths.js";

export type CliCommand =
  | { kind: "server" }
  | { kind: "help" }
  | { kind: "stop" }
  | { kind: "install" }
  | { kind: "uninstall"; purge: boolean };

/** Parse the optional CLI verb. No verb keeps the stdio MCP server behavior. */
export function parseCliArgs(argv: string[]): CliCommand {
  const verb = argv[2];
  if (!verb) return { kind: "server" };
  if (verb === "help" || verb === "--help" || verb === "-h") return { kind: "help" };
  if (verb === "stop") return { kind: "stop" };
  if (verb === "install") return { kind: "install" };
  if (verb === "uninstall") return { kind: "uninstall", purge: argv.includes("--purge") };
  return { kind: "server" };
}

export function cliUsage(): string {
  return [
    "Usage: helix-ssh-mcp [command]",
    "",
    "  (no command)     Run the MCP server over stdio.",
    "  install          Create config, install HELIX_AI_GUIDE.md and register Claude Code.",
    "  stop             Stop the running helixd daemon.",
    "  uninstall        Stop the daemon and print the remaining uninstall steps.",
    "  uninstall --purge  Also delete the local ssh-mcp.json config and guide.",
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

export type ClaudeRunner = (args: string[]) => { status: number | null; error?: Error };

export type InstallOptions = {
  configPath?: string;
  guideDestination?: string;
  guideSource?: string;
  runClaude?: ClaudeRunner;
  runCodex?: ClaudeRunner;
};

export type InstallOutcome = {
  configPath: string;
  configCreated: boolean;
  guidePath: string;
  registered: boolean;
  claudeError?: string;
  codexRegistered: boolean;
  codexError?: string;
};

function bundledGuideSource(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // source tree: apps/ssh-mcp/src -> repo/docs/guides
    path.resolve(here, "..", "..", "..", "docs", "guides", "HELIX_AI_GUIDE.md"),
    // bundled npm package: <package>/bin -> <package>/docs
    path.resolve(here, "..", "docs", "HELIX_AI_GUIDE.md"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function shellQuote(argument: string): string {
  return /[\s"&|<>^]/.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument;
}

function defaultRunner(command: string): ClaudeRunner {
  return (args) => {
    const result = spawnSync([command, ...args].map(shellQuote).join(" "), {
      shell: true,
      stdio: "inherit",
    });
    return { status: result.status, error: result.error ?? undefined };
  };
}

function registerClient(
  run: ClaudeRunner,
  removeArgs: string[],
  addArgs: string[],
): { registered: boolean; error?: string } {
  try {
    run(removeArgs);
    const add = run(addArgs);
    if (add.status === 0) return { registered: true };
    return { registered: false, error: add.error?.message ?? `client exited with ${String(add.status)}` };
  } catch (error) {
    return { registered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Prepare a global npm install for immediate agent use: create the config,
 * copy the operations guide next to it, and register the MCP server with
 * Claude Code in user scope.
 */
export function installRuntime(options: InstallOptions = {}): InstallOutcome {
  const configPath = path.resolve(options.configPath ?? getConfigPath());
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const configCreated = !fs.existsSync(configPath);
  if (configCreated) {
    fs.writeFileSync(configPath, `${JSON.stringify({ version: 1, settings: {}, hosts: {} }, null, 2)}\n`);
  }

  const configuredGuide = process.env.HELIX_AI_GUIDE
    ? path.resolve(process.env.HELIX_AI_GUIDE)
    : null;
  const guidePath = path.resolve(
    options.guideDestination ?? configuredGuide ?? path.join(path.dirname(configPath), "HELIX_AI_GUIDE.md"),
  );
  const guideSource = options.guideSource ?? bundledGuideSource();
  if (!guideSource || !fs.existsSync(guideSource)) {
    throw new Error("HELIX_AI_GUIDE.md was not found in this package; reinstall helix-ssh-mcp");
  }
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  fs.copyFileSync(guideSource, guidePath);

  const envArgs = [
    "--env", `HELIX_SSH_CONFIG=${configPath}`,
    "--env", `HELIX_AI_GUIDE=${guidePath}`,
  ];
  const claude = registerClient(
    options.runClaude ?? defaultRunner("claude"),
    ["mcp", "remove", "--scope", "user", "helix-ssh"],
    ["mcp", "add", "helix-ssh", "--scope", "user", ...envArgs, "--", "helix-ssh-mcp"],
  );
  const codex = registerClient(
    options.runCodex ?? defaultRunner("codex"),
    ["mcp", "remove", "helix-ssh"],
    ["mcp", "add", "helix-ssh", ...envArgs, "--", "helix-ssh-mcp"],
  );

  return {
    configPath,
    configCreated,
    guidePath,
    registered: claude.registered,
    claudeError: claude.error,
    codexRegistered: codex.registered,
    codexError: codex.error,
  };
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
  if (command.kind === "install") {
    try {
      const outcome = installRuntime();
      process.stdout.write(`config: ${outcome.configCreated ? "created" : "kept"} at ${outcome.configPath}\n`);
      process.stdout.write(`guide: installed at ${outcome.guidePath}\n`);
      if (outcome.registered) {
        process.stdout.write("mcp[claude]: registered helix-ssh (user scope)\n");
      } else {
        process.stdout.write(`mcp[claude]: skipped (${outcome.claudeError ?? "claude not found"})\n`);
        process.stdout.write(
          `  manual: claude mcp add helix-ssh --scope user --env HELIX_SSH_CONFIG=${outcome.configPath} `
          + `--env HELIX_AI_GUIDE=${outcome.guidePath} -- helix-ssh-mcp\n`,
        );
      }
      if (outcome.codexRegistered) {
        process.stdout.write("mcp[codex]: registered helix-ssh\n");
      } else {
        process.stdout.write(`mcp[codex]: skipped (${outcome.codexError ?? "codex not found"})\n`);
        process.stdout.write(
          `  manual: codex mcp add helix-ssh --env HELIX_SSH_CONFIG=${outcome.configPath} `
          + `--env HELIX_AI_GUIDE=${outcome.guidePath} -- helix-ssh-mcp\n`,
        );
      }
      process.stdout.write("next: restart Claude Code / Codex, then ask it to call helix_help\n");
      return 0;
    } catch (error) {
      process.stderr.write(`install failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
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
    const guidePath = process.env.HELIX_AI_GUIDE
      ? path.resolve(process.env.HELIX_AI_GUIDE)
      : path.join(path.dirname(configPath), "HELIX_AI_GUIDE.md");
    if (fs.existsSync(guidePath)) {
      fs.rmSync(guidePath);
      process.stdout.write(`guide: removed ${guidePath}\n`);
    }
  } else {
    process.stdout.write(`config: kept at ${configPath}\n`);
  }
  const platformPackage = process.platform === "win32"
    ? "helixd-win32-x64"
    : process.arch === "arm64"
      ? "helixd-linux-arm64-gnu"
      : "helixd-linux-x64-gnu";
  process.stdout.write(
    `next: claude mcp remove helix-ssh; npm uninstall -g helix-ssh-mcp ${platformPackage}\n`,
  );
  return result === "timeout" ? 1 : 0;
}
