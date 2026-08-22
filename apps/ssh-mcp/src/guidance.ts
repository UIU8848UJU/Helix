import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const HELIX_SERVER_INSTRUCTIONS = [
  "Helix runs in Harness mode by default: host changes, policy changes, direct sudo, remote root paths, and first-use SSH connectivity are available without approval workflows.",
  "Start with host_list, credential_status, and ssh_check when the target or authentication state is uncertain.",
  "Treat alias, hostname, and username as different values.",
  "Use host_onboard for one-stop Windows onboarding. It normally opens the native Windows credential dialog automatically.",
  "Use credential_enroll_launch to reopen the local credential window; never ask the user to paste a password into chat.",
  "On Windows, ssh_check/ssh_exec/sudo_exec/ssh_upload/ssh_download automatically open the native credential dialog once when credentials are missing or the stored password is rejected, then retry the command.",
  "Use sudo_exec directly for short privileged commands. There is no sudo allowlist, request/execute approval split, confirmation token, or expiry.",
  "Use job_start for work expected to exceed roughly 30 seconds, produce large logs, or survive an MCP/SSH session. Continue with job_status, job_logs, and job_cancel instead of restarting the command.",
  "Task types such as build, test, docker-build, compose-build, deploy, data, simulation, and run are metadata for one common persistent-job mechanism.",
  "Do not treat a client run_in_background option or a large MCP timeout as remote persistence.",
  "Harness hosts default to allowedRemotePaths=['/'] and strictHostKeyChecking=false. Do not introduce a path-whitelist or known_hosts setup step unless the active configuration is explicitly locked down.",
  "All user commands pass through the Harness dangerous-command guard. Do not try to bypass a blocked rm, filesystem wipe, block-device write, power-control, PID-1 kill, or fork-bomb command.",
  "Prefer structured cwd, env, and sourceScripts fields for repeatable build and debugging workflows.",
  "Use terminal_open for persistent interactive sessions (shells, REPLs, long build loops). terminal_open returns a small summary (state, exitCode, size, tail); use terminal_write to send input, terminal_status for the current summary, terminal_read/terminal_tail to page output, terminal_search to find error lines without reading everything, and terminal_close when done. Terminals idle out after the configured timeout.",
  "Each host can carry a persistent defaultWorkingDir (absolute, inside the allowlist). When cwd is omitted, ssh_exec, job_start, docker_exec and compose_exec fall back to it. View with get_working_dir and update with set_working_dir.",
].join("\n");

export const HELP_TOPICS = [
  "overview",
  "connect",
  "exec",
  "jobs",
  "sudo",
  "transfer",
  "docker",
  "terminal",
  "configuration",
  "troubleshooting",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  mutation_capabilities:
    "Report whether host/policy mutation is enabled, whether direct sudo is active, and how credential onboarding works on this platform.",
  host_list:
    "List configured aliases and redacted connection settings. Alias, hostname, and username are different fields.",
  host_get:
    "Read one host configuration with secrets redacted.",
  host_onboard:
    "Preferred one-stop host creation. On Windows it opens the native credential dialog automatically and defaults remote access to root.",
  host_add:
    "Low-level host creation. Prefer host_onboard unless exact low-level fields are required.",
  host_update:
    "Update host connection or policy fields. Harness mode permits these changes by default.",
  host_offboard:
    "Remove a host configuration while leaving stored credentials available for optional cleanup.",
  host_remove:
    "Low-level host configuration removal.",
  get_working_dir:
    "Read the persistent default working directory configured for a host.",
  set_working_dir:
    "Set or clear the persistent default working directory for a host. Paths must be absolute and inside the host allowlist.",
  credential_status:
    "Check whether login and sudo credential references exist without returning secret values.",
  credential_enroll_launch:
    "Open the native Windows credential dialog for password input. The password stays outside MCP and chat.",
  credential_enroll_request:
    "Return a fallback enrollment command for headless or non-Windows environments.",
  credential_delete_request:
    "Return a local credential cleanup command without exposing the credential value.",
  ssh_check:
    "Check SSH connectivity using the configured authentication backend.",
  ssh_exec:
    "Execute a short remote command with structured cwd, env, and source scripts. Use job_start instead when work may exceed roughly 30 seconds or must survive the MCP call.",
  ssh_pty:
    "Execute a remote command under an allocated PTY (xterm) for interactive flows; stdin input is passed through and the merged output is returned with a deadline.",
  terminal_open:
    "Open a persistent interactive PTY session on a remote host; returns a summary envelope (terminalId, state, exitCode, size, tail). Use terminal_write/terminal_read/terminal_search to interact and drill down.",
  terminal_write:
    "Write input to a persistent terminal stdin. PTY input is echoed back, so never pass passwords or secrets.",
  terminal_read:
    "Read a byte range from a persistent terminal clean output by cursor; continue with the returned nextCursor until eof.",
  terminal_tail:
    "Read the newest output of a persistent terminal without a cursor.",
  terminal_search:
    "Search a persistent terminal clean output for matching lines with optional context.",
  terminal_resize:
    "Resize a persistent terminal PTY dimensions.",
  terminal_status:
    "Return the current summary envelope of a persistent terminal.",
  terminal_close:
    "Close a persistent terminal and free its resources.",
  sudo_exec:
    "Execute a short command directly through sudo. No approval flow or expiry is used; use job_start(useSudo=true) for long privileged work.",
  job_start:
    "Start a detached persistent remote job for builds, tests, Docker/Compose builds, deployments, data jobs, simulations, or other long work. Save the returned jobId.",
  job_status:
    "Read a persistent job state after the original SSH connection or MCP session has ended.",
  job_logs:
    "Read recent job log lines or incremental bytes using the previous nextCursor to avoid repeating logs and wasting model context.",
  job_cancel:
    "Cancel a persistent job process group with TERM followed by KILL only when the grace period expires.",
  ssh_upload:
    "Upload a file or directory using SCP or broker SFTP. Harness hosts permit remote root by default.",
  ssh_download:
    "Download a file or directory using SCP or broker SFTP. Harness hosts permit remote root by default.",
  docker_list:
    "List Docker containers.",
  docker_exec:
    "Execute a short command inside a Docker container; use job_start for long container or image-build workflows.",
  compose_ps:
    "List Docker Compose services.",
  compose_exec:
    "Execute a short command inside a Docker Compose service; use job_start(type=compose-build) for long builds.",
  environment_probe:
    "Probe OS, architecture, tools, containers, and likely environment scripts.",
};

const HELP: Record<HelpTopic, object> = {
  overview: {
    purpose: "High-throughput SSH harness for AI agents without exposing plaintext credentials.",
    standardFlow: [
      "host_list",
      "host_get when details are needed",
      "credential_status for password-backed hosts",
      "ssh_check",
      "environment_probe for unfamiliar environments",
      "short work: ssh_exec, sudo_exec, transfer, Docker, or Compose tools",
      "long work: job_start, then job_status and job_logs",
    ],
    defaults: [
      "Host and policy mutation are enabled in Harness and Personal deployments.",
      "Direct sudo has no approval request, confirmation token, or expiry.",
      "Remote allowed paths default to /.",
      "Strict host-key checking defaults to false in Harness mode.",
      "A small hard-coded guard blocks obvious destructive commands.",
      "Windows host onboarding opens a local credential window automatically.",
      "Persistent jobs remain on the remote host after the original MCP or SSH session ends.",
    ],
  },
  connect: {
    workflow: [
      "Call host_list and select the alias.",
      "Call host_get to verify hostname and username.",
      "For windows-credential authentication, call credential_status.",
      "Call ssh_check.",
      "If credentials are missing, call credential_enroll_launch on Windows.",
    ],
    harnessNote: "Do not require a known_hosts enrollment step when strictHostKeyChecking is false.",
  },
  exec: {
    workflow: [
      "Use environment_probe when the remote environment is unfamiliar.",
      "Use ssh_exec for short normal commands.",
      "On os=windows hosts, ssh_exec and ssh_check run PowerShell via -EncodedCommand; sudo_exec and job_* are unix-only.",
      "Use sudo_exec for short commands requiring sudo password handling.",
      "Use job_start for long, high-output, or session-independent work.",
      "Pass cwd, env, and sourceScripts as structured fields.",
      "Inspect exitCode, stdout, stderr, timedOut, and truncated.",
    ],
    safety: "The guard blocks obvious destructive commands but is not a complete shell sandbox.",
  },
  jobs: {
    chooseWhen: [
      "Expected duration is over roughly 30 seconds.",
      "The task is a complete build, full test, Docker/Compose image build, deployment, data import, simulation, replay, or benchmark.",
      "Logs are large and should be read incrementally.",
      "The task must continue after the MCP call, SSH connection, or client session ends.",
    ],
    workflow: [
      "Call job_start with type, name, command, and structured cwd/env/sourceScripts.",
      "Save the returned jobId; do not restart the same task when the original call ends.",
      "Call job_status for queued, running, succeeded, failed, cancelled, lost, or not_found.",
      "Call job_logs with lines for the first view, then pass nextCursor as cursor for incremental logs.",
      "Call job_cancel only when the task should stop.",
    ],
    types: ["build", "test", "docker-build", "compose-build", "deploy", "service", "data", "simulation", "run", "custom"],
    persistence: "State and logs live under /tmp/helix/jobs/<jobId>. They survive MCP/SSH sessions but not a remote reboot, and /tmp may be cleaned.",
  },

  terminal: {
    chooseWhen: [
      "The workflow needs stateful stdin/stdout across multiple requests.",
      "An interactive shell, REPL, or long build loop should stay alive between calls.",
      "Output is large and should be searched or tailed instead of dumped.",
    ],
    workflow: [
      "Call terminal_open with host and command (e.g. bash --norc -i).",
      "Save the returned terminalId; it stays alive until terminal_close or the idle timeout.",
      "Send input with terminal_write; read output with terminal_status, terminal_tail, or terminal_read.",
      "Find error lines with terminal_search instead of reading everything.",
      "Call terminal_close when finished.",
    ],
    persistence: "Terminals are reaped after the configured idle timeout; close them explicitly when done.",
  },
  sudo: {
    workflow: [
      "Call sudo_exec with the final short command.",
      "Use job_start(useSudo=true) for long privileged work.",
      "No sudo_request, local APPROVE step, token, allowlist, or expiry is used.",
      "Password-backed hosts use the stored sudo credential; OpenSSH hosts use sudo -n.",
      "A command rejected by the dangerous-command guard must not be rewritten to bypass it.",
    ],
  },
  transfer: {
    workflow: [
      "Use ssh_upload or ssh_download.",
      "Use absolute paths.",
      "Set recursive only for directories.",
      "Harness hosts already permit remote /; do not add a path-policy step unless the host is explicitly locked down.",
    ],
  },
  docker: {
    workflow: [
      "Use docker_list or compose_ps to discover names.",
      "Use docker_exec or compose_exec for short work.",
      "Use job_start(type=docker-build) or job_start(type=compose-build) for long builds.",
      "Use sudo_exec for short privileged host-level Docker operations or job_start(useSudo=true) for long ones.",
      "The dangerous-command guard applies to container, Compose, and job commands.",
    ],
  },
  configuration: {
    defaultProfile: "Harness",
    behavior: [
      "allowHostMutation=true",
      "allowPolicyMutation=true",
      "strictHostKeyChecking=false",
      "allowedRemotePaths=['/']",
      "host_onboard opens the Windows credential window automatically",
      "EnterpriseLocked disables mutation and restores strict host-key checking",
    ],
  },
  troubleshooting: {
    order: [
      "host_list / host_get",
      "credential_status",
      "credential_enroll_launch when credentials are absent",
      "ssh_check",
      "environment_probe",
      "job_status before restarting any previously started long task",
      "job_logs with nextCursor for incremental output",
      "smallest useful ssh_exec or sudo_exec diagnostic",
    ],
    avoid: [
      "Confusing alias with username.",
      "Asking for passwords in chat.",
      "Adding unnecessary path or known_hosts setup steps in Harness mode.",
      "Trying to bypass the destructive-command guard.",
      "Using client run_in_background as if it detached the remote process.",
      "Restarting a long build because the original MCP call timed out.",
      "Repeatedly sending the entire job log into model context.",
    ],
  },
};

export function getHelixHelp(topic: HelpTopic = "overview"): object {
  return {
    topic,
    ...HELP[topic],
    localGuide: resolveLocalGuidePath(),
  };
}

export function resolveLocalGuidePath(): string | null {
  if (process.env.HELIX_AI_GUIDE) return process.env.HELIX_AI_GUIDE;
  const configPath = process.env.HELIX_SSH_CONFIG;
  return configPath ? join(dirname(configPath), "HELIX_AI_GUIDE.md") : null;
}

type MutableRegisteredTool = {
  description?: string;
};

type McpServerInternals = {
  _registeredTools?: Record<string, MutableRegisteredTool>;
  server: {
    _instructions?: string;
  };
};

export function registerGuidance(server: McpServer): void {
  const internals = server as unknown as McpServerInternals;
  internals.server._instructions = HELIX_SERVER_INSTRUCTIONS;

  const registeredTools = internals._registeredTools ?? {};
  for (const [name, description] of Object.entries(TOOL_DESCRIPTIONS)) {
    const tool = registeredTools[name];
    if (tool) tool.description = description;
  }

  if (!registeredTools.helix_help) {
    server.tool(
      "helix_help",
      "Read the authoritative Helix Harness workflow, persistent jobs, credentials, sudo, paths, host-key, and command-guard behavior.",
      { topic: z.enum(HELP_TOPICS).optional() },
      async ({ topic }) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify(getHelixHelp(topic ?? "overview"), null, 2),
        }],
      }),
    );
  }
}
