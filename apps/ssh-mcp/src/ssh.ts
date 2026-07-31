import { expandHome } from "./paths.js";
import { runProcess, type Semaphore } from "./process.js";
import { shellQuote } from "./policy.js";
import { newRequestId, writeAudit } from "./audit.js";
import type { EnvironmentProbe, ExecutionResult, GlobalSettings, HostConfig } from "./types.js";

function sshTarget(host: HostConfig): string {
  return host.username ? `${host.username}@${host.hostname}` : host.hostname;
}

function commonSshOptions(host: HostConfig, settings: GlobalSettings): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", `StrictHostKeyChecking=${settings.strictHostKeyChecking ? "yes" : "accept-new"}`,
  ];
  if (host.port && host.port !== 22) args.push("-p", String(host.port));
  if (host.identityFile) args.push("-i", expandHome(host.identityFile));
  if (host.proxyJump) args.push("-J", host.proxyJump);
  return args;
}

function commonScpOptions(host: HostConfig, settings: GlobalSettings): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", `StrictHostKeyChecking=${settings.strictHostKeyChecking ? "yes" : "accept-new"}`,
  ];
  if (host.port && host.port !== 22) args.push("-P", String(host.port));
  if (host.identityFile) args.push("-i", expandHome(host.identityFile));
  if (host.proxyJump) args.push("-o", `ProxyJump=${host.proxyJump}`);
  return args;
}

export async function runSsh(input: {
  host: HostConfig;
  settings: GlobalSettings;
  command: string;
  timeoutSeconds?: number;
  limiter: Semaphore;
}): Promise<ExecutionResult> {
  const timeoutSeconds = input.timeoutSeconds ?? input.settings.defaultTimeoutSeconds;
  const args = [...commonSshOptions(input.host, input.settings), sshTarget(input.host), input.command];
  return await input.limiter.use(async () => await runProcess("ssh", args, {
    timeoutMs: timeoutSeconds * 1000,
    maxOutputBytes: input.settings.maxOutputBytes,
  }));
}

export async function runScp(input: {
  direction: "upload" | "download";
  host: HostConfig;
  settings: GlobalSettings;
  localPath: string;
  remotePath: string;
  recursive: boolean;
  timeoutSeconds?: number;
  limiter: Semaphore;
}): Promise<ExecutionResult> {
  const timeoutSeconds = input.timeoutSeconds ?? input.settings.defaultTimeoutSeconds;
  const args = commonScpOptions(input.host, input.settings);
  if (input.recursive) args.push("-r");
  const remote = `${sshTarget(input.host)}:${shellQuote(input.remotePath)}`;
  if (input.direction === "upload") args.push(input.localPath, remote);
  else args.push(remote, input.localPath);
  const requestId = newRequestId();
  const startedAt = Date.now();
  try {
    const result = await input.limiter.use(async () => await runProcess("scp", args, {
      timeoutMs: timeoutSeconds * 1000,
      maxOutputBytes: input.settings.maxOutputBytes,
    }));
    await writeAudit(input.settings, {
      timestamp: new Date().toISOString(),
      requestId,
      tool: input.direction === "upload" ? "ssh_upload" : "ssh_download",
      host: input.host.hostname,
      operation: `${input.localPath} ${input.direction === "upload" ? "->" : "<-"} ${input.remotePath}`,
      durationMs: result.durationMs || Date.now() - startedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      success: result.ok,
    });
    return result;
  } catch (error) {
    await writeAudit(input.settings, {
      timestamp: new Date().toISOString(),
      requestId,
      tool: input.direction === "upload" ? "ssh_upload" : "ssh_download",
      host: input.host.hostname,
      operation: `${input.localPath} ${input.direction === "upload" ? "->" : "<-"} ${input.remotePath}`,
      durationMs: Date.now() - startedAt,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function buildEnvironmentProbeScript(host: HostConfig): string {
  const roots = Array.from(new Set(["/opt/ros", ...host.allowedRemotePaths]))
    .map(shellQuote)
    .join(" ");
  return `set +e
meta() { printf 'HELIX_META\\t%s\\t%s\\n' "$1" "$2"; }
tool() { if command -v "$1" >/dev/null 2>&1; then value=$("$1" --version 2>&1 | head -n 1); printf 'HELIX_TOOL\\t%s\\t%s\\n' "$1" "$value"; else printf 'HELIX_TOOL\\t%s\\t\\n' "$1"; fi; }
os_name=""; os_version=""; os_pretty=""
if [ -r /etc/os-release ]; then . /etc/os-release; os_name="\${NAME:-}"; os_version="\${VERSION_ID:-}"; os_pretty="\${PRETTY_NAME:-}"; fi
meta os.name "$os_name"
meta os.version "$os_version"
meta os.prettyName "$os_pretty"
meta os.kernel "$(uname -sr 2>/dev/null)"
meta arch "$(uname -m 2>/dev/null)"
meta shell "\${SHELL:-}"
meta cwd "$(pwd 2>/dev/null)"
for name in git docker gcc g++ cmake make ninja python3 node rustc cargo; do tool "$name"; done
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'HELIX_CONTAINER\\t{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}' 2>/dev/null
fi
for root in ${roots}; do
  if [ -d "$root" ]; then
    find "$root" -maxdepth 5 -type f \\( -name setup.bash -o -name setup.sh -o -name env.sh -o -name activate \\) -print 2>/dev/null
  fi
done | head -n 100 | while IFS= read -r file; do printf 'HELIX_SOURCE\\t%s\\n' "$file"; done
`;
}

export function parseEnvironmentProbe(output: string): EnvironmentProbe {
  const probe: EnvironmentProbe = {
    os: { name: null, version: null, prettyName: null, kernel: null },
    arch: null,
    shell: null,
    cwd: null,
    tools: {},
    containers: [],
    candidateSourceScripts: [],
  };
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split("\t");
    const kind = fields[0];
    if (kind === "HELIX_META") {
      const key = fields[1];
      const value = fields.slice(2).join("\t") || null;
      if (key === "os.name") probe.os.name = value;
      else if (key === "os.version") probe.os.version = value;
      else if (key === "os.prettyName") probe.os.prettyName = value;
      else if (key === "os.kernel") probe.os.kernel = value;
      else if (key === "arch") probe.arch = value;
      else if (key === "shell") probe.shell = value;
      else if (key === "cwd") probe.cwd = value;
    } else if (kind === "HELIX_TOOL" && fields[1]) {
      probe.tools[fields[1]] = fields.slice(2).join("\t") || null;
    } else if (kind === "HELIX_CONTAINER" && fields.length >= 5) {
      probe.containers.push({
        id: fields[1] ?? "",
        name: fields[2] ?? "",
        image: fields[3] ?? "",
        status: fields.slice(4).join("\t"),
      });
    } else if (kind === "HELIX_SOURCE" && fields[1]) {
      probe.candidateSourceScripts.push(fields.slice(1).join("\t"));
    }
  }
  return probe;
}

export async function probeEnvironment(input: {
  host: HostConfig;
  settings: GlobalSettings;
  timeoutSeconds?: number;
  limiter: Semaphore;
}): Promise<{ result: ExecutionResult; probe: EnvironmentProbe | null }> {
  const result = await runSsh({ ...input, command: buildEnvironmentProbeScript(input.host) });
  return { result, probe: result.ok ? parseEnvironmentProbe(result.stdout) : null };
}
