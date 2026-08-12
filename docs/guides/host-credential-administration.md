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

`host_onboard` then launches the Rust credential broker, which opens the native Windows credential dialog (`CredUIPromptForWindowsCredentialsW`). The user enters the password directly in that dialog; no command copying is required. The broker waits for the dialog to actually start before reporting success, so a detached process that silently failed is detected instead of assumed.

The password never enters MCP, chat, JSON configuration, command-line password arguments, environment variables, or logs.

Default behavior uses one password prompt for both login and sudo targets. Use `separatePasswords=true` when they differ.

When an operation such as `ssh_exec`, `sudo_exec`, or a transfer fails with a missing credential or a failed SSH password authentication, the broker automatically reopens the dialog, waits for the user to finish, and retries the operation once. Cancelling the dialog aborts the operation with a clear error instead of hanging.

To reopen the dialog:

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

### Dialog behavior and platform support

The broker is spawned by the MCP process, so Windows does not grant the credential dialog foreground activation on its own. The broker owns the dialog to the active window (`GetForegroundWindow`) and raises it to the topmost z-order from a helper thread once it appears, so it pops in front of the user's current window instead of flashing in the background.

Platform support:

- The dialog uses `CredUIPromptForWindowsCredentialsW`, which requires Windows Vista or newer. Windows 7, Windows 10, and Windows 11 are all supported.
- Credential storage uses `CredWriteW`/`CredReadW`/`CredDeleteW` (Windows XP+).
- The shipped binary targets x86_64, so 64-bit Windows is required; 32-bit Windows needs an i686 build.
- Non-Windows hosts fall back to the headless `credential_enroll_request` flow.

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

Normal GUI use should prefer `host_onboard` or `credential_enroll_launch` so MCP opens the native dialog automatically. The installed `helix-admin.ps1` remains as a manual fallback for headless or scripted environments.

## Offboarding

`host_offboard` removes only host configuration and returns orphaned credential references. Credential cleanup remains a separate local action so accidental host removal does not destroy stored credentials.
