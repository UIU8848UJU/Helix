import path from "node:path";
import type { HostConfig, RemoteExecutionOptions } from "./types.js";

// shellQuote lives in the shared @helix/jobs Task Runtime package. ssh-mcp
// re-exports it so existing importers (server, ssh, jobs) keep their surface.
import { shellQuote } from "@helix/jobs";
export { shellQuote };

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const containerNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const composeServicePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function normalizeRemotePath(input: string): string {
  if (input.includes("\0") || input.includes("\n") || input.includes("\r")) {
    throw new Error("Remote path contains invalid control characters");
  }
  if (!input.startsWith("/")) throw new Error(`Remote path must be absolute: ${input}`);
  return path.posix.normalize(input);
}

const windowsDrivePattern = /^[A-Za-z]:[\\/]/;
const windowsUncPattern = /^\\\\[^\\]+\\[^\\]+/;

export function normalizeWindowsRemotePath(input: string): string {
  if (input.includes("\0") || input.includes("\n") || input.includes("\r")) {
    throw new Error("Remote path contains invalid control characters");
  }
  const normalized = path.win32.normalize(input);
  if (!windowsDrivePattern.test(normalized) && !windowsUncPattern.test(normalized)) {
    throw new Error("Remote path must be absolute (drive or UNC): " + input);
  }
  return normalized;
}

function isWindowsPathWithin(candidate: string, root: string): boolean {
  const candidateLower = candidate.toLowerCase();
  const rootLower = root.toLowerCase();
  if (rootLower.endsWith("\\")) return candidateLower.startsWith(rootLower);
  return candidateLower === rootLower || candidateLower.startsWith(rootLower + "\\");
}

function isPathWithin(candidate: string, root: string): boolean {
  if (root === "/") return true;
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function assertRemotePathAllowed(host: HostConfig, input: string): string {
  if (host.os === "windows") {
    const candidate = normalizeWindowsRemotePath(input);
    const roots = host.allowedRemotePaths.map(normalizeWindowsRemotePath);
    if (!roots.some((root) => isWindowsPathWithin(candidate, root))) {
      throw new Error("Remote path is outside the configured allowlist: " + candidate);
    }
    return candidate;
  }
  const candidate = normalizeRemotePath(input);
  const roots = host.allowedRemotePaths.map(normalizeRemotePath);
  if (!roots.some((root) => isPathWithin(candidate, root))) {
    throw new Error(`Remote path is outside the configured allowlist: ${candidate}`);
  }
  return candidate;
}

export function assertLocalPathAllowed(input: string, roots: string[]): string {
  if (input.includes("\0") || input.includes("\n") || input.includes("\r")) {
    throw new Error("Local path contains invalid control characters");
  }
  const candidate = path.resolve(input);
  const allowed = roots.some((rootInput) => {
    const root = path.resolve(rootInput);
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) throw new Error(`Local path is outside HELIX_LOCAL_PATH_ROOTS: ${candidate}`);
  return candidate;
}

export function assertSudoAllowed(host: HostConfig, command: string): void {
  if (host.sudo.mode === "disabled") throw new Error("sudo is disabled for this host");
  if (!command.trim() || command.includes("\0") || command.includes("\n") || command.includes("\r")) {
    throw new Error("sudo command is empty or contains control characters");
  }
  const matched = host.sudo.allow.some((pattern) => new RegExp(pattern).test(command));
  if (!matched) throw new Error("sudo command does not match the host allowlist");
}

export function assertContainerName(value: string): string {
  if (!containerNamePattern.test(value)) throw new Error(`Invalid Docker container name or ID: ${value}`);
  return value;
}

export function assertComposeService(value: string): string {
  if (!composeServicePattern.test(value)) throw new Error(`Invalid Docker Compose service: ${value}`);
  return value;
}

export function buildRemoteScript(host: HostConfig, command: string, options: RemoteExecutionOptions = {}): string {
  if (!command.trim() || command.includes("\0")) {
    throw new Error("Command cannot be empty and cannot contain NUL bytes");
  }
  const parts = ["set -e"];
  const cwd = options.cwd ?? host.defaultWorkingDir;
  if (cwd) parts.push(`cd ${shellQuote(assertRemotePathAllowed(host, cwd))}`);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!envNamePattern.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    parts.push(`export ${key}=${shellQuote(value)}`);
  }
  for (const script of options.sourceScripts ?? []) {
    parts.push(`. ${shellQuote(assertRemotePathAllowed(host, script))}`);
  }
  parts.push(command);
  return parts.join("\n");
}

export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsRemoteScript(host: HostConfig, command: string, options: RemoteExecutionOptions = {}): string {
  if (!command.trim() || command.includes("\0")) {
    throw new Error("Command cannot be empty and cannot contain NUL bytes");
  }
  const parts: string[] = ["$ProgressPreference = 'SilentlyContinue'", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"];
  const cwd = options.cwd ?? host.defaultWorkingDir;
  if (cwd) parts.push(`Set-Location -LiteralPath ${quotePowerShell(assertRemotePathAllowed(host, cwd))}`);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!envNamePattern.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    parts.push(`$env:${key} = ${quotePowerShell(value)}`);
  }
  for (const script of options.sourceScripts ?? []) {
    parts.push(`. ${quotePowerShell(assertRemotePathAllowed(host, script))}`);
  }
  parts.push(command);
  parts.push("if ($LASTEXITCODE) { exit $LASTEXITCODE }");
  parts.push("if (-not $?) { exit 1 }");
  parts.push("exit 0");
  return parts.join("; ");
}

export function encodePowerShellCommand(script: string): string {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

export function buildWindowsCommand(host: HostConfig, command: string, options: RemoteExecutionOptions = {}): string {
  return encodePowerShellCommand(buildWindowsRemoteScript(host, command, options));
}

export function buildDockerExecCommand(input: {
  host: HostConfig;
  container: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  sourceScripts?: string[];
  user?: string;
  shell?: "sh" | "bash";
}): string {
  const container = assertContainerName(input.container);
  const inner = buildRemoteScript(input.host, input.command, {
    cwd: input.cwd,
    env: input.env,
    sourceScripts: input.sourceScripts,
  });
  const args = ["docker", "exec"];
  if (input.user) args.push("--user", shellQuote(input.user));
  if (input.cwd) args.push("--workdir", shellQuote(assertRemotePathAllowed(input.host, input.cwd)));
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!envNamePattern.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    args.push("--env", shellQuote(`${key}=${value}`));
  }
  args.push(shellQuote(container), input.shell ?? "sh", "-lc", shellQuote(inner));
  return args.join(" ");
}

export function buildComposeExecCommand(input: {
  host: HostConfig;
  projectDir: string;
  service: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  sourceScripts?: string[];
  user?: string;
  shell?: "sh" | "bash";
}): string {
  const projectDir = assertRemotePathAllowed(input.host, input.projectDir);
  const service = assertComposeService(input.service);
  const inner = buildRemoteScript(input.host, input.command, {
    cwd: input.cwd,
    env: input.env,
    sourceScripts: input.sourceScripts,
  });
  const args = ["docker", "compose", "exec", "-T"];
  if (input.user) args.push("--user", shellQuote(input.user));
  if (input.cwd) args.push("--workdir", shellQuote(assertRemotePathAllowed(input.host, input.cwd)));
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!envNamePattern.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    args.push("--env", shellQuote(`${key}=${value}`));
  }
  args.push(shellQuote(service), input.shell ?? "sh", "-lc", shellQuote(inner));
  return `cd ${shellQuote(projectDir)} && ${args.join(" ")}`;
}

export function quoteScpRemotePath(remotePath: string): string {
  return shellQuote(normalizeRemotePath(remotePath));
}
