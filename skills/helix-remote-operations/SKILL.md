---
name: helix-remote-operations
description: Use Helix SSH MCP to inspect remote hosts, onboard or offboard hosts, enroll credentials locally, transfer files, enter Docker or Compose services, source environments, build software, diagnose failures, and request reviewed sudo without exposing credentials or weakening policy.
---

# Helix Remote Operations

Use this skill when a task requires controlled work on a configured remote machine through the `helix-ssh` MCP server.

## Operating Principle

Security must preserve usability. Normal host lifecycle work is enabled by default in personal deployments; only genuine policy expansion requires the second authorization tier.

### Lifecycle tier

Proceed directly after an explicit user request for:

- `host_onboard` and `host_offboard`;
- hostname, port, username, identityFile, proxyJump, and tags;
- standard per-host credential references;
- user home, `/workspace`, `/tmp/helix`, and `/opt/ros` paths;
- credential enrollment, status, and deletion requests.

### Policy tier

Call `mutation_capabilities` and request exact authorization only for:

- additional remote roots outside lifecycle-safe defaults;
- new sudo allowlist rules;
- authentication or credential-reference replacement on an existing host;
- longer sudo approval TTL;
- disabling strict host-key checking or auditing.

Do not tell the user to edit JSON for normal lifecycle work.

## Hard Rules

- Do not edit `ssh-mcp.json` during normal operations, troubleshooting, or lifecycle administration.
- Treat the Helix host alias, remote hostname, and SSH username as different fields.
- Never ask for or expose plaintext login or sudo passwords.
- Never place `sudo` inside `ssh_exec`, `docker_exec`, or `compose_exec`.
- Privileged work must use `sudo_request`, local human approval, then `sudo_execute`.
- After `sudo_request`, show `approvalCommand` and stop. Continue only after the user explicitly confirms approval.
- Reuse the exact approved host, requestId, and command. Do not broaden or rewrite the command.
- Do not bypass host-key checks, path allowlists, sudo allowlists, timeouts, or output limits.
- Do not classify normal host onboarding, IP changes, username changes, or credential enrollment as policy expansion.
- Never run a local credential enrollment or deletion command on behalf of the user; display it and stop.

## First Actions

1. Call `helix_help` with the most relevant topic when the workflow is unclear.
2. Call `host_list` and select the configured alias.
3. Call `host_get` if hostname, username, authentication, paths, or sudo mode must be confirmed.
4. Call `mutation_capabilities` before host administration or after a mutation rejection.
5. For password-backed hosts, call `credential_status`.
6. Call `ssh_check` before changing assumptions or proposing configuration changes.
7. Call `environment_probe` before working in an unfamiliar environment.

## Workflow: Host Onboarding

Enter this workflow after the user explicitly asks to add a host.

1. Confirm alias, hostname, SSH username, port, and authentication type.
2. Call `mutation_capabilities`.
3. Call `host_onboard`; do not manually edit JSON.
4. Accept the lifecycle-safe default paths unless the user specifically needs another root.
5. For Windows Credential Manager authentication, call `credential_enroll_request`.
6. Show the returned `enrollmentCommand` and selected credential references.
7. Stop. Password input must happen in the user's local hidden Broker terminal.
8. After the user confirms completion, call `credential_status`.
9. Call `ssh_check`.
10. Report alias, `username@hostname`, authentication mode, credential existence, and connectivity.

By default, enrollment prompts once and stores the same password for all selected login/sudo targets. Use `separatePasswords=true` only when the user says the login and sudo passwords differ.

If onboarding requests a non-default path, non-empty sudo rule, custom credential reference, or longer approval TTL, state the exact policy expansion and request the second-tier authorization. Do not block the rest of onboarding unnecessarily.

## Workflow: Host Offboarding

1. Confirm the exact alias and that the user intends to remove its non-secret configuration.
2. Call `host_offboard`.
3. Report `orphanedCredentials` and `credentialsDeleted=false`.
4. If `cleanupCommand` is returned, ask whether the user wants to remove those credentials.
5. Do not infer credential deletion permission from host removal permission.
6. If approved, show the local cleanup command and stop; the user runs it locally.

## Workflow: Credential Maintenance

- Query existence with `credential_status`.
- Create or update credentials with `credential_enroll_request`.
- Request deletion with `credential_delete_request`.
- Never request the password in chat.
- Never place passwords in config, command arguments, environment variables, or logs.
- After enrollment, verify with `credential_status` and `ssh_check`.

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
4. User home, `/workspace`, `/tmp/helix`, and `/opt/ros` are lifecycle-safe defaults.
5. Treat requests for other roots as policy-tier expansion and ask only for that exact authorization.

## Workflow: Reviewed sudo

### Phase 1 — Request

Call `sudo_request` with the selected host alias, exact final command, and a concrete reason tied to the user's task.

Do not request an interactive shell or a broad command that can execute arbitrary follow-up actions.

### Phase 2 — Stop for the user

Present the exact command, reason, returned `approvalCommand`, and approval expiry when available. Then stop. Do not call `sudo_execute` in the same turn and do not infer approval from silence or from the original task request.

### Phase 3 — Execute

Only after the user explicitly says local approval is complete:

1. Call `sudo_execute`.
2. Use the identical host, requestId, and command.
3. Inspect the result.
4. Never reuse the approval for another command.

### Allowlist rejection

Report the exact rejected command, active policy boundary, and narrow anchored rule an administrator would need to consider. Adding the rule is a policy-tier operation. Do not split, encode, wrap, or substitute a broader command.

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

Explicit hostname, port, username, identityFile, proxyJump, or tag corrections are lifecycle changes and should use `host_update` directly. Do not rewrite credential references unless the user explicitly authorizes the policy-tier change.

## Completion Report

Report:

- selected host alias and `username@hostname`;
- environment used: host, Docker container, or Compose service;
- commands executed and their exit codes;
- source scripts and working directory;
- files transferred or changed;
- sudo approvals performed;
- lifecycle or policy-tier configuration changes;
- credential enrollment or cleanup commands handed to the user;
- remaining issues and the reproducible next action.
