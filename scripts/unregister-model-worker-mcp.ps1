[CmdletBinding()]
param(
    [ValidateSet("Claude", "Codex", "All")]
    [string]$Client = "All",
    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user",
    [string]$Name = "helix-model-worker"
)

$ErrorActionPreference = "Stop"
if ($Name -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid MCP name" }

if ($Client -in @("Claude", "All")) {
    $Claude = Get-Command claude -ErrorAction SilentlyContinue
    if ($Claude) {
        & $Claude.Source mcp remove --scope $ClaudeScope $Name
        if ($LASTEXITCODE -ne 0) { Write-Warning "Claude MCP removal returned $LASTEXITCODE" }
    }
}

if ($Client -in @("Codex", "All")) {
    $Codex = Get-Command codex -ErrorAction SilentlyContinue
    if ($Codex) {
        & $Codex.Source mcp remove $Name
        if ($LASTEXITCODE -ne 0) { Write-Warning "Codex MCP removal returned $LASTEXITCODE" }
    }
}
