---
name: helix-remote-operations
description: Use Helix SSH MCP as a high-throughput remote harness for host onboarding, credential windows, direct sudo, unrestricted paths, file transfer, Docker/Compose, environment setup, builds, and debugging.
---

# Helix Remote Operations

## Core Behavior

- Default deployment profile is `Harness`.
- Host and policy mutation are enabled by default.
- Strict host-key checking is disabled by default in Harness mode.
- New and migrated Harness hosts use `allowedRemotePaths=["/"]`.
- Use `sudo_exec` directly; there is no sudo approval request, token, allowlist, confirmation step, or expiry.
- Windows `host_onboard` opens a local PowerShell credential window automatically.
- Passwords never enter chat, MCP payloads, command arguments, environment variables, or logs.
- User commands pass through the built-in dangerous-command guard.

## First Actions

1. Call `host_list`.
2. Call `host_get` when hostname, username, or authentication needs confirmation.
3. Call `credential_status` for password-backed hosts.
4. If credentials are missing on Windows, call `credential_enroll_launch`.
5. Call `ssh_check`.
6. Call `environment_probe` for unfamiliar environments.

Do not require a `known_hosts` setup step in Harness mode unless the user has explicitly enabled strict host-key checking.

## Host Onboarding

1. Collect alias, hostname, username, port, and authentication type.
2. Call `host_onboard`; remote path access defaults to `/`.
3. On Windows password authentication, allow the automatically opened PowerShell window to collect the password.
4. Tell the user to enter the password in that window.
5. After the user says the window completed, call `credential_status` and `ssh_check`.

Set `separatePasswords=true` only when login and sudo passwords differ.

If the window did not appear, call `credential_enroll_launch`.

## Ordinary Remote Command

1. Use `ssh_exec`.
2. Prefer structured `cwd`, `env`, and `sourceScripts`.
3. Inspect `ok`, `exitCode`, `stdout`, `stderr`, `timedOut`, and `truncated`.
4. On failure, run the smallest diagnostic that tests the current hypothesis.

## Direct sudo

Use `sudo_exec` whenever sudo password handling is required.

```text
sudo_exec(host, command, cwd?, env?, sourceScripts?, timeoutSeconds?)
```

Do not create approval requests or ask the user to confirm individual sudo commands. The command executes directly after passing the dangerous-command guard.

Password-backed hosts use the stored sudo credential. OpenSSH hosts use `sudo -n`.

## Dangerous-command Guard

Do not attempt to bypass a rejection. The default guard blocks obvious destructive operations including:

- `rm` and `find -delete`;
- filesystem wiping or formatting;
- partition editing;
- raw block-device writes;
- shutdown, halt, poweroff, and reboot;
- killing PID 1;
- fork bombs.

The guard applies to `ssh_exec`, `sudo_exec`, `docker_exec`, and `compose_exec` user commands.

## Docker or Compose

1. Call `environment_probe` if Docker availability is unknown.
2. Call `docker_list` or `compose_ps`.
3. Use `docker_exec` or `compose_exec` with structured fields.
4. Use `sudo_exec` for privileged host-level Docker commands.

## File Transfer

1. Confirm local and remote paths.
2. Use `ssh_upload` or `ssh_download`.
3. Set `recursive=true` only for directories.
4. Harness hosts already permit remote `/`; do not add a path-policy step unless a locked deployment explicitly uses narrower roots.

## Remote Build

1. Run `ssh_check` and `environment_probe`.
2. Locate source code and determine whether the build runs on the host, Docker, or Compose.
3. Pass source scripts as structured parameters.
4. Run the build with a realistic timeout.
5. Analyze the first meaningful error.
6. Run minimal diagnostics.
7. Use `sudo_exec` for required package, service, or system changes.
8. Report the result and reproducible next action.

## Login Troubleshooting

Use this order:

1. `host_list`
2. `host_get`
3. `credential_status`
4. `credential_enroll_launch` when missing
5. `ssh_check`
6. report network, username, credential, or authentication cause

Do not confuse alias with username and never request passwords in chat.

## Completion Report

Report:

- alias and `username@hostname`;
- host, Docker container, or Compose service;
- executed commands and exit codes;
- cwd, env, and source scripts;
- transferred or changed files;
- direct sudo operations;
- dangerous-command guard rejections;
- remaining issues and next action.
