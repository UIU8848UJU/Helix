import path from "node:path";
import type { HostConfig, RemoteExecutionOptions } from "./types.js";

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const containerNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const composeServicePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("NUL bytes are not allowed");
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function normalizeRemotePath(input: string): string {
  if (input.includes("\0") || input.includes("\n") || input.includes("\r")) {
    throw new Error("Remote path contains invalid control characters");
  }
  if (!input.startsWith("/")) {
    throw new Error(`Remote path must be absolute: ${input}`);
  }
  return path.posix.normalize(input);
}

function isPathWithin(candidate: string, root: string): boolean {
  if (root === "/") {
    return true;
  }
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function assertRemotePathAllowed(host: HostConfig, input: string): string {
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
  if (!allowed) {
    throw new Error(`Local path is outside HELIX_LOCAL_PATH_ROOTS: ${candidate}`);
  }
  return candidate;
}

export function assertSudoAllowed(host: HostConfig, command: string): void {
  if (!host.sudo.enabled) {
    throw new Error("sudo is disabled for this host");
  }
  if (!command.trim() || command.includes("\0") || command.includes("\n") || command.includes("\r")) {
    throw new Error("sudo command is empty or contains control characters");
  }

  const matched = host.sudo.allow.some((pattern) => new RegExp(pattern).test(command));
  if (!matched) {
    throw new Error("sudo command does not match the host allowlist");
  }
}

export function assertContainerName(value: string): string {
  if (!containerNamePattern.test(value)) {
    throw new Error(`Invalid Docker container name or ID: ${value}`);
  }
  return value;
}

export function assertComposeService(value: string): string {
  if (!composeServicePattern.test(value)) {
    throw new Error(`Invalid Docker Compose service: ${value}`);
  }
  return value;
}

export function buildRemoteScript(
  host: HostConfig,
  command: string,
  options: RemoteExecutionOptions = {},
): string {
  if (!command.trim() || command.includes("\0")) {
    throw new Error("Command cannot be empty and cannot contain NUL bytes");
  }

  const parts = ["set -e"];
  if (options.cwd) {
    parts.push(`cd ${shellQuote(assertRemotePathAllowed(host, options.cwd))}`);
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!envNamePattern.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    parts.push(`export ${key}=${shellQuote(value)}`);
  }

  for (const script of options.sourceScripts ?? []) {
    const allowed = assertRemotePathAllowed(host, script);
    parts.push(`. ${shellQuote(allowed)}`);
  }

  parts.push(command);
  return parts.join("\n");
}

export function buildDockerExecCommand(input: {
  host: HostConfig;
  container: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  sourceScripts?: string[];
  user?: string;
}): string {
  const container = assertContainerName(input.container);
  const inner = buildRemoteScript(input.host, input.command, {
    cwd: input.cwd,
    env: input.env,
    sourceScripts: input.sourceScripts,
  });

  const args = ["docker", "exec"];
  if (input.user) {
    args.push("--user", shellQuote(input.user));
  }
  if (input.cwd) {
    args.push("--workdir", shellQuote(assertRemotePathAllowed(input.host, input.cwd)));
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!envNamePattern.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    args.push("--env", shellQuote(`${key}=${value}`));
  }
  args.push(shellQuote(container), "sh", "-lc", shellQuote(inner));
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
}): string {
  const projectDir = assertRemotePathAllowed(input.host, input.projectDir);
  const service = assertComposeService(input.service);
  const inner = buildRemoteScript(input.host, input.command, {
    cwd: input.cwd,
    env: input.env,
    sourceScripts: input.sourceScripts,
  });

  const args = ["docker", "compose", "exec", "-T"];
  if (input.user) {
    args.push("--user", shellQuote(input.user));
  }
  if (input.cwd) {
    args.push("--workdir", shellQuote(assertRemotePathAllowed(input.host, input.cwd)));
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!envNamePattern.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    args.push("--env", shellQuote(`${key}=${value}`));
  }
  args.push(shellQuote(service), "sh", "-lc", shellQuote(inner));
  return `cd ${shellQuote(projectDir)} && ${args.join(" ")}`;
}

export function quoteScpRemotePath(remotePath: string): string {
  return shellQuote(normalizeRemotePath(remotePath));
}
