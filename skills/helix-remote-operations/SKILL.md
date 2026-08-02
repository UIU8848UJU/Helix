---
name: helix-remote-operations
description: Use Helix SSH MCP to inspect remote hosts, transfer files, enter Docker or Compose services, source environments, build software, diagnose failures, and request reviewed sudo without exposing credentials or weakening policy.
---

# Helix Remote Operations

Use this skill when a task requires controlled work on a configured remote machine through the `helix-ssh` MCP server.

## Hard Rules

- Do not edit `ssh-mcp.json` during normal operations or troubleshooting.
- Treat the Helix host alias, remote hostname, and SSH username as different fields.
- Never ask for or expose plaintext login or sudo passwords.
- Never place `sudo` inside `ssh_exec`, `docker_exec`, or `compose_exec`.
- Privileged work must use `sudo_request`, local human approval, then `sudo_execute`.
- After `sudo_request`, show `approvalCommand` and stop. Continue only after the user explicitly confirms approval.
- Reuse the exact approved host, requestId, and command. Do not broaden or rewrite the command.
- Do not bypass host-key checks, path allowlists, sudo allowlists, timeouts, or output limits.
- Use host mutation tools only for an explicit administrative configuration request.

## First Actions

1. Call `helix_help` with the most relevant topic when the workflow is unclear.
2. Call `host_list` and select the configured alias.
3. Call `host_get` if hostname, username, authentication, paths, or sudo mode must be confirmed.
4. For password-backed hosts, call `credential_status`.
5. Call `ssh_check` before changing assumptions or proposing configuration edits.
6. Call `environment_probe` before working in an unfamiliar environment.

## Workflow: Ordinary Remote Command

1. Determine the exact non-privileged command.
2. Prefer structured `cwd`, `env`, and `sourceScripts` parameters.
3. Call `ssh_exec`.
4. Inspect `ok`, `exitCode`, `stdout`, `stderr`, `timedOut`, and `truncated`.
5. On failure, run the smallest read-only diagnostic command that tests the current hypothesis.
6. Summarize the observed cause and next action.

Do not add `sudo` when an ordinary command fails. First determine whether the failure is actually a privilege boundary.

## Workflow: Docker or Compose

1. Call `environment_probe` when Docker availability is unknown.
2. Call `docker_list` or `compose_ps` to discover exact names.
3. Use `docker_exec` or `compose_exec` with structured `cwd`, `env`, `sourceScripts`, `user`, and `shell` fields.
4. Inspect the execution result before issuing additional commands.
5. For privileged host-level Docker commands, use the reviewed sudo workflow with the exact final Docker command.

## Workflow: File Transfer

1. Confirm the local and remote paths.
2. Use `ssh_upload` or `ssh_download`.
3. Set `recursive=true` only for directories.
4. Treat path rejection as a policy boundary.
5. Do not expand `allowedRemotePaths` or local path roots unless the user explicitly starts an administrative configuration task.

## Workflow: Reviewed sudo

### Phase 1 — Request

Call `sudo_request` with:

- the selected host alias;
- the exact final command;
- a concrete reason tied to the user's task.

Do not request an interactive shell or a broad command that can execute arbitrary follow-up actions.

### Phase 2 — Stop for the user

Present:

- the exact command;
- the reason;
- the returned `approvalCommand`;
- the approval expiry when available.

Then stop. Do not call `sudo_execute` in the same turn and do not infer approval from silence or from the original task request.

### Phase 3 — Execute

Only after the user explicitly says local approval is complete:

1. Call `sudo_execute`.
2. Use the identical host, requestId, and command.
3. Inspect the result.
4. Never reuse the approval for another command.

### Allowlist rejection

Report:

- the exact rejected command;
- the active policy boundary;
- the narrow anchored rule an administrator would need to consider.

Do not edit configuration, split the command, encode it, wrap it in a shell, or substitute a broader allowed command.

## Workflow: Remote Build

1. Run the connection and environment checks.
2. Locate the source tree within an allowed remote path.
3. Transfer missing files with `ssh_upload` when necessary.
4. Determine whether the build runs on the host, in Docker, or in a Compose service.
5. Supply required source scripts as structured arguments.
6. Run the build with a realistic timeout.
7. Analyze the first meaningful failure rather than repeatedly rerunning the full build.
8. Run minimal diagnostics for compiler, dependency, environment, disk, or permission failures.
9. Request sudo only for an exact system-level remediation that the user can review.
10. Report the command, result, logs, remaining issue, and reproducible next step.

## Workflow: Troubleshooting Login

Use this order:

1. `host_list`
2. `host_get`
3. `credential_status`
4. `ssh_check`
5. report whether the failure is network, host key, username, credential presence, authentication, or policy related

Do not rename aliases, replace hostnames with usernames, or rewrite credential references without an explicit administrative request.

## Administrative Configuration Changes

Enter this mode only when the user explicitly asks to add, update, or remove a host or policy.

Before using host mutation tools, state:

- the alias and field being changed;
- the old and proposed values when known;
- why the change is required;
- whether it expands access or privilege;
- how it will be validated.

Never store plaintext credentials in configuration. Store only credential references managed by the Broker.

## Completion Report

At the end of a remote task, report:

- host alias used;
- execution context: host, container, or Compose service;
- important commands performed;
- whether sudo was requested and approved;
- exit status and concise output summary;
- files transferred or changed;
- unresolved risks or next validation step.
