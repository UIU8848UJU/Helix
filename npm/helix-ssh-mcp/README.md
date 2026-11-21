# helix-ssh-mcp

Helix MCP server: persistent SSH/PTY/SFTP, task runtime, credentials and remote jobs for AI agents.

## Install

```bash
npm install -g helix-ssh-mcp
claude mcp add helix-ssh -- helix-ssh-mcp
```

The daemon binary is installed as a platform-specific optional dependency:

- `helixd-win32-x64` (Windows x64)
- `helixd-linux-x64-gnu` (Linux x64, glibc)

If your platform is not covered, install from a GitHub Release and set
`HELIX_CREDENTIAL_BROKER` to the `helixd` path.

## Configuration

The server reads `%APPDATA%\Helix\ssh-mcp.json` on Windows and
`~/.config/helix/ssh-mcp.json` on Linux. Override with `HELIX_SSH_CONFIG`.

## Notes

This package is prepared but not yet published. Before publishing, check that
the name is available; otherwise rename the three packages under `npm/`
(`helix-ssh-mcp`, `helixd-win32-x64`, `helixd-linux-x64-gnu`) and publish the
platform packages first.
