import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const HELIX_SERVER_INSTRUCTIONS = [
  "Helix is a controlled SSH operations server. Call helix_help when the workflow is unclear.",
  "Start remote work with host_list, then credential_status and ssh_check when authentication or connectivity is uncertain.",
  "Treat host aliases as Helix identifiers; hostname is the remote address and username is the SSH account.",
  "Normal host lifecycle management is designed to be usable by default. Use host_onboard, host_update for connection fields, host_offboard, and credential request tools instead of editing ssh-mcp.json.",
  "Call mutation_capabilities when a host change is rejected. Host lifecycle and security-policy expansion are separate tiers.",
  "Only expanded paths, sudo rules, credential-reference replacement, longer approval windows, or weakened global protections require allowPolicyMutation.",
  "Use ssh_exec only for non-privileged commands. Never add sudo to ssh_exec, docker_exec, or compose_exec.",
  "For privileged work, call sudo_request with the exact final command and a concrete reason. Show approvalCommand to the user and STOP. Do not call sudo_execute until the user explicitly confirms local approval is complete.",
  "sudo_execute must reuse the exact host, requestId, and command returned by the reviewed request. Never alter or broaden the approved command.",
  "If a command is rejected by the sudo allowlist, report the missing rule and requested command. Do not edit ssh-mcp.json or weaken policy unless the user explicitly asks for that exact policy expansion.",
  "Never ask for, print, store, or return plaintext login or sudo passwords. Use credential_status to check only whether configured credentials exist.",
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
    "Check the two mutation tiers before asking the user to change configuration: normal host lifecycle is enabled by default, while genuine policy expansion is locked separately.",
  host_list:
    "Start here: list configured Helix host aliases and redacted connection settings. An alias is not the SSH username or hostname.",
  host_get:
    "Read one host's redacted settings. Use this to understand username, hostname, authentication, paths, and sudo policy without editing configuration.",
  host_onboard:
    "Preferred way to add a host. Uses standard credential references and useful lifecycle-safe paths; only custom policy expansion needs the second authorization tier.",
  host_add:
    "Low-level host creation. Prefer host_onboard so credential references and safe defaults are generated consistently.",
  host_update:
    "Update connection details such as hostname, port, username, identity file, proxy jump, and tags normally. Expanding paths, sudo, credentials, or approval policy requires allowPolicyMutation.",
  host_offboard:
    "Preferred way to remove a host configuration without automatically deleting stored credentials.",
  host_remove:
    "Low-level host removal after an explicit user request. Prefer host_offboard when credential cleanup guidance is useful.",
  credential_status:
    "Check whether the configured login and sudo credentials exist. This never returns secret values and should precede password-auth troubleshooting.",
  credential_enroll_request:
    "Generate a local hidden-input credential enrollment command. Show it to the user and STOP; do not request passwords in chat.",
  credential_delete_request:
    "Generate a local credential cleanup command. Show it and wait for explicit user action; do not delete secrets automatically.",
  ssh_check:
    "Check SSH connectivity using the configured authentication backend. Prefer this before changing configuration when login fails.",
  ssh_exec:
    "Execute a non-privileged remote command with optional cwd, env, and source scripts. Never prefix the command with sudo; use sudo_request then sudo_execute instead.",
  ssh_upload:
    "Upload an allowed local file or directory to an allowed remote path. Do not change path policy to bypass a rejection.",
  ssh_download:
    "Download an allowed remote file or directory to an allowed local path. Do not change path policy to bypass a rejection.",
  sudo_request:
    "Phase 1 of reviewed sudo. Submit the exact final privileged command and reason. Then show approvalCommand to the user and STOP until they explicitly confirm local approval.",
  sudo_execute:
    "Phase 2 of reviewed sudo. Call only after the user explicitly confirms they ran approvalCommand. Reuse the exact host, requestId, and command; approval is one-time and command-bound.",
  docker_list:
    "List Docker containers without privilege escalation. If Docker itself requires sudo, use the reviewed sudo flow for an exact docker command.",
  docker_exec:
    "Execute a non-privileged command inside a named Docker container. Do not embed sudo; request reviewed sudo for privileged host-level Docker commands.",
  compose_ps:
    "List Docker Compose services from an allowed project directory.",
  compose_exec:
    "Execute a non-privileged command inside a Docker Compose service. Do not embed sudo.",
  environment_probe:
    "Perform read-only discovery of OS, architecture, tools, containers, and source scripts before planning remote build or debugging work.",
};

const HELP: Record<HelpTopic, object> = {
  overview: {
    purpose: "Controlled remote operations for AI agents without exposing plaintext credentials or making normal administration cumbersome.",
    standardFlow: [
      "host_list",
      "host_get when details are needed",
      "credential_status for password-backed hosts",
      "ssh_check",
      "environment_probe for unfamiliar environments",
      "ssh_exec, transfer, Docker, or reviewed sudo tools",
    ],
    hostAdministration: [
      "Use host_onboard for new hosts and host_offboard for removal.",
      "Normal connection-field updates are available in the host lifecycle tier.",
      "Call mutation_capabilities instead of asking the user to inspect JSON.",
      "Request policy authorization only for the exact protected expansion that is actually needed.",
    ],
    nonNegotiableRules: [
      "Do not edit ssh-mcp.json during normal operations or troubleshooting.",
      "Do not request or reveal plaintext passwords.",
      "Do not place sudo inside ssh_exec, docker_exec, or compose_exec.",
      "Do not approve sudo through MCP; local human approval is mandatory.",
    ],
  },
  connect: {
    workflow: [
      "Call host_list and select the host alias.",
      "Call host_get to verify hostname and username; the alias is only a Helix identifier.",
      "For windows-credential authentication, call credential_status.",
      "Call ssh_check before proposing configuration changes.",
    ],
    onFailure: [
      "Report the exact host alias, hostname, username, and error without secrets.",
      "Check host-key, network reachability, account name, and credential existence.",
      "Use host_update for explicit connection-field corrections; do not rewrite JSON.",
    ],
  },
  exec: {
    workflow: [
      "Use environment_probe when the remote environment is unfamiliar.",
      "Use ssh_exec for ordinary host commands.",
      "Pass cwd, env, and sourceScripts as structured arguments instead of building fragile shell setup chains.",
      "Inspect exitCode, stdout, stderr, timedOut, and truncated before deciding the next action.",
    ],
    privilegeBoundary: "ssh_exec is non-privileged. Any command requiring sudo must use the reviewed sudo workflow.",
  },
  sudo: {
    workflow: [
      "Call sudo_request with host, the exact final command, and a concrete reason.",
      "Present approvalCommand and the exact command to the user.",
      "Stop. Do not call sudo_execute in the same turn or before explicit user confirmation.",
      "After the user confirms approval, call sudo_execute using the same host, requestId, and byte-for-byte identical command.",
    ],
    rejectionHandling: [
      "If the allowlist rejects the command, report the exact rejected command and the narrow anchored rule that would be needed.",
      "Do not split, rewrite, broaden, or obfuscate the command to bypass policy.",
      "Adding a sudo rule is a policy-tier operation and requires explicit authorization.",
    ],
    security: "Approval is local, expiring, one-time, and bound to the host and exact command hash.",
  },
  transfer: {
    workflow: [
      "Use ssh_upload or ssh_download.",
      "Use absolute paths whenever possible.",
      "Set recursive only for directories.",
      "User home, /workspace, /tmp/helix, and /opt/ros are lifecycle-safe onboarding defaults.",
      "Adding other remote roots is a policy-tier expansion.",
    ],
  },
  docker: {
    workflow: [
      "Use docker_list or compose_ps to discover container and service names.",
      "Use docker_exec or compose_exec with structured cwd, env, sourceScripts, user, and shell fields.",
      "Use environment_probe before assuming Docker, Compose, ROS, or build tools exist.",
    ],
    privilegeBoundary: "Container tools are non-privileged. Host-level privileged Docker commands require sudo_request and sudo_execute.",
  },
  configuration: {
    rule: "Usability-first tiering: normal host lifecycle is available by default; only actual security-policy expansion needs a second authorization switch.",
    lifecycleTier: [
      "host_onboard and host_offboard",
      "hostname, port, username, identityFile, proxyJump, and tags",
      "standard per-host credential references",
      "safe onboarding roots under the user home, /workspace, /tmp/helix, and /opt/ros",
      "credential enrollment, status, and deletion requests",
    ],
    policyTier: [
      "remote roots outside lifecycle-safe defaults",
      "new sudo allowlist rules",
      "authentication or credential-reference replacement on an existing host",
      "longer sudo approval TTL",
      "disabling strict host-key checking or auditing",
    ],
    workflow: [
      "Use mutation_capabilities to inspect both tiers.",
      "Proceed directly for explicitly requested lifecycle changes.",
      "For policy expansion, state the exact old and new values and request authorization for only that change.",
      "Never place plaintext passwords in configuration; store only credential references.",
    ],
  },
  troubleshooting: {
    order: [
      "host_list / host_get",
      "credential_status",
      "ssh_check",
      "environment_probe",
      "a minimal read-only ssh_exec command",
      "mutation_capabilities when a requested host change is rejected",
      "report the observed boundary or policy failure",
    ],
    avoid: [
      "Editing ssh-mcp.json during normal workflows.",
      "Treating all host changes as dangerous policy changes.",
      "Changing usernames based on host aliases.",
      "Adding sudo to ordinary execution tools.",
      "Asking the user to paste passwords into chat.",
      "Bypassing host-key, path, or sudo allowlist checks.",
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
  // @modelcontextprotocol/sdk v1 exposes no post-construction instructions setter.
  // createServer has already registered its tools, so install guidance before connect.
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
      "Read the authoritative Helix workflow and safety rules. Call this before guessing, editing configuration, or using privileged operations.",
      {
        topic: z.enum(HELP_TOPICS).optional(),
      },
      async ({ topic }) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(getHelixHelp(topic ?? "overview"), null, 2),
          },
        ],
      }),
    );
  }
}
