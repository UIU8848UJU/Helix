# Host and Credential Administration

Helix separates non-secret host configuration from secret credential enrollment, and separates normal host lifecycle work from genuine security-policy expansion.

## Mutation tiers

Call `mutation_capabilities` to inspect both tiers.

### Host lifecycle tier

Personal deployments enable this tier by default. It covers the operations needed for normal use:

- `host_onboard` and `host_offboard`;
- changing hostname, port, username, identity file, proxy jump, and tags;
- standard per-host credential references;
- user home, `/workspace`, `/tmp/helix`, and `/opt/ros` lifecycle-safe paths;
- credential enrollment, status, and deletion requests.

These operations should go through MCP tools directly. The AI should not ask the user to edit `ssh-mcp.json` first.

### Security-policy tier

This tier is disabled by default and only gates actual privilege expansion:

- adding remote roots outside lifecycle-safe defaults;
- adding sudo allowlist rules;
- replacing authentication or credential references on an existing host;
- increasing sudo approval TTL;
- disabling strict host-key checking or auditing.

Enable it only for the specific administrative task with `settings.allowPolicyMutation=true` or `HELIX_ALLOW_POLICY_MUTATION=1`, then restore it to false.

Every configuration mutation passes through the same central comparison. A low-level tool cannot bypass this tiering.

## Deployment defaults

Windows personal installation uses:

```text
allowHostMutation = true
allowPolicyMutation = false
```

Existing personal installations are migrated to these defaults when `scripts/install.ps1` is rerun.

Enterprise locked mode uses:

```powershell
.\scripts\install.ps1 -DeploymentMode EnterpriseLocked
```

That mode disables both tiers until a local administrator opens them.

## MCP host interfaces

- `mutation_capabilities`: report both mutation tiers and their scope.
- `host_list`: list configured aliases and redacted settings.
- `host_get`: query one alias.
- `host_onboard`: preferred creation workflow with generated credential references and useful safe paths.
- `host_update`: connection-field changes work in the lifecycle tier; protected fields require policy authorization.
- `host_offboard`: remove host configuration while preserving credentials until the user chooses cleanup.

For a Windows password-backed alias such as `jetson-dev`, onboarding generates:

```text
Helix/ssh/jetson-dev/login
Helix/ssh/jetson-dev/sudo
```

The default safe paths are:

```text
/home/<username>
/workspace
/tmp/helix
/opt/ros
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
