import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const HELIX_SERVER_INSTRUCTIONS = [
  "Helix runs in Harness mode by default: host changes, policy changes, and direct sudo are available without approval tokens or expiry windows.",
  "Start with host_list, credential_status, and ssh_check when the target or authentication state is uncertain.",
  "Treat alias, hostname, and username as different values.",
  "Use host_onboard for one-stop Windows onboarding. It normally opens a visible local PowerShell credential window automatically.",
  "Use credential_enroll_launch to reopen the local credential window; never ask the user to paste a password into chat.",
  "Use sudo_exec directly for privileged commands. There is no sudo allowlist, request/execute approval split, confirmation token, or expiry.",
  "All user commands pass through the Harness dangerous-command guard. Do not try to bypass a blocked rm, filesystem wipe, block-device write, power-control, PID-1 kill, or fork-bomb command.",
  "Prefer structured cwd, env, and sourceScripts fields for repeatable build and debugging workflows.",
].join("\n");

export const HELP_TOPICS = [
  "overview",
  "connect",
  "exec",
  "sudo",
  "transfer",
  "docker",
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
    "Preferred one-stop host creation. On Windows it opens a local credential-entry PowerShell window automatically by default.",
  host_add:
    "Low-level host creation. Prefer host_onboard unless exact low-level fields are required.",
  host_update:
    "Update host connection or policy fields. Harness mode permits these changes by default.",
  host_offboard:
    "Remove a host configuration while leaving stored credentials available for optional cleanup.",
  host_remove:
    "Low-level host configuration removal.",
  credential_status:
    "Check whether login and sudo credential references exist without returning secret values.",
  credential_enroll_launch:
    "Open a visible local Windows PowerShell window for password input. The password stays outside MCP and chat.",
  credential_enroll_request:
    "Return a fallback enrollment command for headless or non-Windows environments.",
  credential_delete_request:
    "Return a local credential cleanup command without exposing the credential value.",
  ssh_check:
    "Check SSH connectivity using the configured authentication backend.",
  ssh_exec:
    "Execute a remote command with structured cwd, env, and source scripts. Sudo text is not rejected, but password-backed sudo should use sudo_exec.",
  sudo_exec:
    "Execute a command directly through sudo. No approval flow or expiry is used; the built-in dangerous-command guard still applies.",
  ssh_upload:
    "Upload a file or directory using SCP or broker SFTP.",
  ssh_download:
    "Download a file or directory using SCP or broker SFTP.",
  docker_list:
    "List Docker containers.",
  docker_exec:
    "Execute a command inside a Docker container; the dangerous-command guard applies to the inner command.",
  compose_ps:
    "List Docker Compose services.",
  compose_exec:
    "Execute a command inside a Docker Compose service; the dangerous-command guard applies to the inner command.",
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
      "ssh_exec, sudo_exec, transfer, Docker, or Compose tools",
    ],
    defaults: [
      "Host and policy mutation are enabled in Harness and Personal deployments.",
      "Direct sudo has no approval request, confirmation token, or expiry.",
      "A small hard-coded guard blocks obvious destructive commands.",
      "Windows host onboarding opens a local credential window automatically.",
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
  },
  exec: {
    workflow: [
      "Use environment_probe when the remote environment is unfamiliar.",
      "Use ssh_exec for normal commands.",
      "Use sudo_exec when the command requires sudo password handling.",
      "Pass cwd, env, and sourceScripts as structured fields.",
      "Inspect exitCode, stdout, stderr, timedOut, and truncated.",
    ],
    safety: "The guard blocks obvious destructive commands but is not a complete shell sandbox.",
  },
  sudo: {
    workflow: [
      "Call sudo_exec with the final command.",
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
      "Update allowedRemotePaths through host_update when the task genuinely needs another root.",
    ],
  },
  docker: {
    workflow: [
      "Use docker_list or compose_ps to discover names.",
      "Use docker_exec or compose_exec with structured fields.",
      "Use sudo_exec for privileged host-level Docker operations.",
      "The dangerous-command guard applies to container and Compose inner commands.",
    ],
  },
  configuration: {
    defaultProfile: "Harness",
    behavior: [
      "allowHostMutation=true",
      "allowPolicyMutation=true",
      "host_onboard opens the Windows credential window automatically",
      "EnterpriseLocked remains available when both mutation switches must be disabled",
    ],
  },
  troubleshooting: {
    order: [
      "host_list / host_get",
      "credential_status",
      "credential_enroll_launch when credentials are absent",
      "ssh_check",
      "environment_probe",
      "smallest useful ssh_exec or sudo_exec diagnostic",
    ],
    avoid: [
      "Confusing alias with username.",
      "Asking for passwords in chat.",
      "Trying to bypass the destructive-command guard.",
      "Repeated full builds before inspecting the first meaningful error.",
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
      "Read the authoritative Helix Harness workflow, credential, sudo, and command-guard behavior.",
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
