# Helix Model Worker MCP

Helix Model Worker MCP lets an MCP client invoke the user's existing local model CLIs:

```text
GPT / Codex client --claude_run--> Claude Code CLI
Claude client      --gpt_run----> Codex CLI / GPT
```

It uses the authentication already owned by each CLI. The MCP does not receive, copy or persist API keys or OAuth tokens.

## Tools

### `model_worker_status`

Checks executable versions and authentication state. It returns no credential values.

### `claude_run`

Runs the current Claude Code CLI in non-interactive JSON mode. This is the normal tool for a GPT/Codex client.

### `gpt_run`

Runs the current Codex CLI in non-interactive JSONL mode. This is the normal tool for a Claude client.

Both worker tools accept:

```json
{
  "prompt": "Review the current implementation and identify the root cause.",
  "cwd": "F:\\AI_infra\\Helix",
  "mode": "answer",
  "timeoutSeconds": 300
}
```

Optional `model` is passed as a structured CLI argument. Prompts are sent through stdin, not command-line arguments.

## Access modes

- `answer` is the default. Claude uses plan permissions and Codex uses a read-only sandbox.
- `workspace` must be explicit. Claude uses `acceptEdits`; Codex uses `workspace-write` with no escalation.
- Dangerous bypass flags are never exposed by this MCP.

The requested `cwd` is resolved through the filesystem and must remain inside one of `allowedWorkingDirectories`. This prevents `..` and symlink escapes.

## Recursion boundary

A child model must not delegate back into the same bridge. Model Worker enforces this in three ways:

1. Claude is launched with a strict empty MCP configuration.
2. Codex is launched with `--ignore-user-config`, which keeps authentication but omits user MCP servers.
3. Child environments carry `HELIX_MODEL_WORKER_ACTIVE=1`; a nested Model Worker server refuses to start.

Each invocation is stateless: Claude uses `--no-session-persistence` and Codex uses `--ephemeral`.

## Audit and privacy

The JSONL audit records provider, mode, working directory, model, duration, exit status and a SHA-256 prompt hash. It does not store the prompt or response.

Default Windows paths:

```text
%APPDATA%\Helix\model-worker-mcp.json
%APPDATA%\Helix\model-worker-audit.jsonl
```

## Configuration

```json
{
  "version": 1,
  "settings": {
    "claudeCommand": "claude",
    "gptCommand": "codex",
    "allowedWorkingDirectories": ["F:\\AI_infra"],
    "defaultWorkingDirectory": "F:\\AI_infra",
    "defaultTimeoutSeconds": 300,
    "maxTimeoutSeconds": 1800,
    "maxOutputBytes": 1048576,
    "maxPromptChars": 200000,
    "maxConcurrentWorkers": 2,
    "auditEnabled": true
  }
}
```

Override the config path with `HELIX_MODEL_WORKER_CONFIG`. `HELIX_CLAUDE_COMMAND` and `HELIX_GPT_COMMAND` only affect auto-created defaults; explicit JSON config takes precedence.

## Build and test

```powershell
npm run check --workspace apps/model-worker-mcp
npm test --workspace apps/model-worker-mcp
npm run build --workspace apps/model-worker-mcp
```

## Install and register

Register for both clients:

```powershell
.\scripts\install-model-worker-mcp.ps1 -RegisterClient All
```

Register only after building:

```powershell
.\scripts\register-model-worker-mcp.ps1 -Client All
```

Unregister:

```powershell
.\scripts\unregister-model-worker-mcp.ps1 -Client All
```

Restart Claude Code and Codex after registration.

## Authentication

Verify directly:

```powershell
claude auth status
codex login status
```

If Codex reports `Not logged in`, run `codex login` before using `gpt_run`. Authentication is deliberately kept outside Helix.

## Operational notes

- Each call may consume paid model quota.
- `workspace` mode can modify files inside the configured working root.
- The server bounds duration, output bytes, prompt size and concurrency.
- Output truncation terminates the worker and is reported as an error rather than returning a misleading partial success.
- Model Worker is a local model bridge. Remote deployment and execution remain the responsibility of Helix SSH MCP.
