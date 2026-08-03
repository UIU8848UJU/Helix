# Host and Credential Administration

Helix separates non-secret host configuration from secret credential enrollment.

## MCP host interfaces

- `host_list`: list configured aliases and redacted settings.
- `host_get`: query one alias.
- `host_onboard`: create a host with generated credential references.
- `host_update`: update an existing host after an explicit administrative request.
- `host_offboard`: remove host configuration while preserving credentials until the user chooses cleanup.

`host_onboard` and `host_offboard` require host mutation to be enabled through `settings.allowHostMutation` or `HELIX_ALLOW_HOST_MUTATION=1`.

For a Windows password-backed alias such as `jetson-dev`, onboarding generates:

```text
Helix/ssh/jetson-dev/login
Helix/ssh/jetson-dev/sudo
```

No plaintext password is accepted by any MCP host tool.

## Credential interfaces

- `credential_enroll_request`: returns a local `enrollmentCommand`.
- `credential_status`: checks whether configured credentials exist without returning secrets.
- `credential_delete_request`: returns a local cleanup command.

After `credential_enroll_request`, the AI must display `enrollmentCommand` and stop. The user runs it in a local PowerShell terminal. The password is read by the Rust Credential Broker through a hidden prompt and never enters MCP, chat, command-line arguments, environment variables, or configuration.

By default, one password prompt is reused for all selected targets, so matching SSH and sudo passwords are enrolled once. Set `separatePasswords=true` only when login and sudo use different passwords.

After local enrollment:

```text
credential_status
  -> ssh_check
```

## Local administration script

Windows installation copies the script to:

```text
%APPDATA%\Helix\helix-admin.ps1
```

Examples:

```powershell
# One hidden prompt, stored for both login and sudo references
& "$env:APPDATA\Helix\helix-admin.ps1" credential set `
  -Host "jetson-dev" `
  -Kind all

# Different login and sudo passwords
& "$env:APPDATA\Helix\helix-admin.ps1" credential set `
  -Host "jetson-dev" `
  -Kind all `
  -SeparatePasswords

# Query secret existence only
& "$env:APPDATA\Helix\helix-admin.ps1" credential status `
  -Host "jetson-dev"

# Delete selected stored credentials
& "$env:APPDATA\Helix\helix-admin.ps1" credential delete `
  -Host "jetson-dev" `
  -Kind sudo

# Read host configuration locally
& "$env:APPDATA\Helix\helix-admin.ps1" host get `
  -Host "jetson-dev"
```

## Offboarding behavior

`host_offboard` removes only the host configuration. It returns:

- orphaned credential references;
- `credentialsDeleted=false`;
- a local `cleanupCommand` when managed credentials exist.

The AI must ask before the user runs the cleanup command. This prevents an accidental host configuration removal from also destroying credentials that may be needed for recovery.
