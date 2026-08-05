---
name: helix-remote-operations
description: Use Helix SSH MCP as a high-throughput remote harness for host onboarding, credential windows, direct sudo, persistent jobs, unrestricted paths, file transfer, Docker/Compose, environment setup, builds, tests, deployments, and debugging.
---

# Helix Remote Operations

## Core Behavior

- Default deployment profile is `Harness`.
- Host and policy mutation are enabled by default.
- Strict host-key checking is disabled by default in Harness mode.
- New and migrated Harness hosts use `allowedRemotePaths=["/"]`.
- Use `sudo_exec` directly; there is no sudo approval request, token, allowlist, confirmation step, or expiry.
- Use `job_start` for long-running work instead of keeping `ssh_exec` or the Credential Broker blocked.
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
7. Decide whether the work is a short command or a persistent job.

Do not require a `known_hosts` setup step in Harness mode unless the user has explicitly enabled strict host-key checking.

## Host Onboarding

1. Collect alias, hostname, username, port, and authentication type.
2. Call `host_onboard`; remote path access defaults to `/`.
3. On Windows password authentication, allow the automatically opened PowerShell window to collect the password.
4. Tell the user to enter the password in that window.
5. After the user says the window completed, call `credential_status` and `ssh_check`.

Set `separatePasswords=true` only when login and sudo passwords differ.

If the window did not appear, call `credential_enroll_launch`.

## Short Remote Command

Use `ssh_exec` only when the task is expected to complete in roughly 30 seconds or less, output is limited, and it is acceptable for the MCP call to wait.

1. Prefer structured `cwd`, `env`, and `sourceScripts`.
2. Inspect `ok`, `exitCode`, `stdout`, `stderr`, `timedOut`, and `truncated`.
3. On failure, run the smallest diagnostic that tests the current hypothesis.

Do not treat an MCP client's `run_in_background` option as remote process persistence. It does not detach the process from the Credential Broker.

## Persistent Remote Job

Use the persistent job tools for builds, full tests, Docker image builds, deployments, simulations, replays, data imports, benchmarks, or any operation that may outlive one MCP call.

```text
job_start
  → job_status
  → job_logs
  → job_cancel when required
```

The job is stored under `/tmp/helix/jobs/<jobId>` and detached with `nohup` plus `setsid` when available. It survives the original SSH connection and MCP client session, but not a remote host reboot.

### Job Type Routing

Use one of these types:

- `build`: CMake, Ninja, Cargo, colcon, Maven, Gradle, and ordinary compilation;
- `test`: unit, integration, system, or regression tests;
- `docker-build`: Dockerfile image builds;
- `compose-build`: Docker Compose builds;
- `deploy`: installs, migrations, rollouts, and deployment workflows;
- `service`: longer service maintenance operations;
- `data`: import, backfill, transformation, and batch processing;
- `simulation`: simulation, replay, and benchmark work;
- `run`: long-running ordinary programs;
- `custom`: other tasks.

Types are metadata and routing hints. Do not invent separate background MCP tools for each build system.

### Starting a Job

```text
job_start(host, type?, name?, command, cwd?, env?, sourceScripts?, useSudo?, startTimeoutSeconds?)
```

- Save the returned `jobId` immediately.
- `startTimeoutSeconds` only controls remote job creation, not total job duration.
- Set `useSudo=true` for privileged long-running work.
- The dangerous-command guard validates the user command before launch.

Example:

```text
job_start(
  host="Ubuntu22.04_developer",
  type="compose-build",
  name="QuantX dev image",
  cwd="/home/xxx/QuantX",
  command="docker compose -f docker/docker-compose.yml build dev"
)
```

### Status and Logs

Call `job_status(host, jobId)` to obtain:

```text
queued / running / succeeded / failed / cancelled / lost / not_found
```

For first inspection, call `job_logs` with `lines`. For continued polling, pass the previous `nextCursor` as `cursor` so only new bytes are returned. Do not repeatedly resend the entire log into model context.

### Cancelling

Call `job_cancel(host, jobId)`. It sends TERM to the process group, waits for the grace period, then sends KILL only when necessary. Privileged jobs are cancelled through sudo automatically.

Do not manually reconstruct PID-file, `tail`, and `kill` workflows with `ssh_exec` unless the persistent job metadata is damaged and troubleshooting requires it.

## Direct sudo

Use `sudo_exec` whenever sudo password handling is required for a short command.

```text
sudo_exec(host, command, cwd?, env?, sourceScripts?, timeoutSeconds?)
```

Do not create approval requests or ask the user to confirm individual sudo commands. The command executes directly after passing the dangerous-command guard.

Password-backed hosts use the stored sudo credential. OpenSSH hosts use `sudo -n`.

For a long privileged task, use `job_start(useSudo=true)` instead of increasing `sudo_exec` timeouts.

## Dangerous-command Guard

Do not attempt to bypass a rejection. The default guard blocks obvious destructive operations including:

- `rm` and `find -delete`;
- filesystem wiping or formatting;
- partition editing;
- raw block-device writes;
- shutdown, halt, poweroff, and reboot;
- killing PID 1;
- fork bombs.

The guard applies to `ssh_exec`, `sudo_exec`, `job_start`, `docker_exec`, and `compose_exec` user commands.

## Docker or Compose

1. Call `environment_probe` if Docker availability is unknown.
2. Call `docker_list` or `compose_ps`.
3. Use `docker_exec` or `compose_exec` for short operations.
4. Use `job_start(type="docker-build")` or `job_start(type="compose-build")` for image builds and other long operations.
5. Use `sudo_exec` for short privileged host-level Docker commands, or `job_start(useSudo=true)` for long ones.

## File Transfer

1. Confirm local and remote paths.
2. Use `ssh_upload` or `ssh_download`.
3. Set `recursive=true` only for directories.
4. Harness hosts already permit remote `/`; do not add a path-policy step unless a locked deployment explicitly uses narrower roots.

## Remote Build

1. Run `ssh_check` and `environment_probe`.
2. Locate source code and determine whether the build runs on the host, Docker, or Compose.
3. Pass source scripts as structured parameters.
4. Use `ssh_exec` only for short probes or incremental commands.
5. Use `job_start(type="build")`, `job_start(type="docker-build")`, or `job_start(type="compose-build")` for complete builds.
6. Poll `job_status` and read logs incrementally with `job_logs`.
7. Analyze the first meaningful error after the job reaches a terminal state or the logs expose a clear failure.
8. Run minimal diagnostics.
9. Use `sudo_exec` or `job_start(useSudo=true)` for required package, service, or system changes.
10. Report the result and reproducible next action.

Never restart the same long build merely because the original MCP call ended. Use the returned `jobId` first.

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
- persistent job IDs, types, final states, and relevant log conclusions;
- dangerous-command guard rejections;
- remaining issues and next action.
