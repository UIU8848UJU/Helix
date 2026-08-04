# Host and Credential Administration

Helix separates non-secret host configuration from local credential storage.

## Host interfaces

- `host_list`: list aliases and redacted settings.
- `host_get`: query one alias.
- `host_onboard`: one-stop host creation.
- `host_update`: update connection, path, authentication, or sudo settings.
- `host_offboard`: remove host configuration while leaving credentials available for optional cleanup.

Harness and Personal deployments enable host and policy mutation by default. `EnterpriseLocked` disables both switches.

## Automatic Windows enrollment

For a Windows password-backed alias such as `ubuntu22-developer`, onboarding generates:

```text
Helix/ssh/ubuntu22-developer/login
Helix/ssh/ubuntu22-developer/sudo
```

`host_onboard` then starts a visible local PowerShell process that runs the installed `helix-admin.ps1` credential flow. The user enters the password in that window; no command copying is required.

The password never enters MCP, chat, JSON configuration, command-line password arguments, environment variables, or logs.

Default behavior uses one password prompt for both login and sudo targets. Use `separatePasswords=true` when they differ.

To reopen the window:

```text
credential_enroll_launch
```

For headless or non-Windows environments:

```text
credential_enroll_request
```

After enrollment:

```text
credential_status
  → ssh_check
```

## Direct sudo

Helix uses `sudo_exec` directly. There is no approval request, token, allowlist, confirmation step, or expiry.

Password-backed hosts read the stored sudo credential through the Rust Broker. OpenSSH hosts use `sudo -n`.

A built-in dangerous-command guard still blocks obvious destructive operations such as `rm`, filesystem formatting, raw block-device writes, power-control commands, killing PID 1, and fork bombs.

## Local administration script

The Windows installer copies:

```text
%APPDATA%\Helix\helix-admin.ps1
```

It remains available for manual fallback:

```powershell
& "$env:APPDATA\Helix\helix-admin.ps1" credential set `
  -Host "ubuntu22-developer" `
  -Kind all
```

Normal GUI use should prefer `host_onboard` or `credential_enroll_launch` so MCP opens the local window automatically.

## Offboarding

`host_offboard` removes only host configuration and returns orphaned credential references. Credential cleanup remains a separate local action so accidental host removal does not destroy stored credentials.
