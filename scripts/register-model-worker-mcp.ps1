[CmdletBinding()]
param(
    [ValidateSet("Auto", "Claude", "Codex", "All")]
    [string]$Client = "Auto",

    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user",

    [string]$Name = "helix-model-worker",
    [string]$ConfigPath,
    [string]$EntryPath,
    [switch]$SkipIfUnavailable,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Resolve-FullPath([string]$PathValue) {
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return $null }
    return [System.IO.Path]::GetFullPath($PathValue)
}

function Backup-File([string]$PathValue) {
    if ($DryRun -or -not $PathValue -or -not (Test-Path -LiteralPath $PathValue)) { return }
    $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $BackupPath = "$PathValue.helix-backup-$Timestamp"
    Copy-Item -LiteralPath $PathValue -Destination $BackupPath -Force
    Write-Host "Backed up config: $BackupPath"
}

function Format-Argument([string]$Value) {
    if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
    return $Value
}

function Invoke-External(
    [string]$FilePath,
    [string[]]$Arguments,
    [switch]$IgnoreExitCode
) {
    $Display = (($Arguments | ForEach-Object { Format-Argument $_ }) -join " ")
    Write-Host ">> $FilePath $Display"
    if ($DryRun) { return }
    & $FilePath @Arguments | Out-Host
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0 -and -not $IgnoreExitCode) {
        throw "Command failed with exit code ${ExitCode}: $FilePath $Display"
    }
}

if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
    throw "MCP name may only contain letters, digits, dot, underscore, and dash"
}

$UserHome = [Environment]::GetFolderPath("UserProfile")
if (-not $ConfigPath) {
    $Base = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $UserHome "AppData\Roaming" }
    $ConfigPath = Join-Path $Base "Helix\model-worker-mcp.json"
}
$ConfigPath = Resolve-FullPath $ConfigPath

if (-not $EntryPath) {
    $EntryPath = Join-Path $RootDir "apps\model-worker-mcp\build\index.js"
}
$EntryPath = Resolve-FullPath $EntryPath

foreach ($RequiredPath in @($ConfigPath, $EntryPath)) {
    if (-not (Test-Path -LiteralPath $RequiredPath)) {
        throw "Missing Model Worker runtime file: $RequiredPath. Run scripts\install-model-worker-mcp.ps1 first"
    }
}

$Node = Get-Command node -ErrorAction Stop
$Claude = Get-Command claude -ErrorAction SilentlyContinue
$Codex = Get-Command codex -ErrorAction SilentlyContinue
$Targets = @()

switch ($Client) {
    "Claude" { if (-not $Claude) { throw "Claude Code CLI was not found" }; $Targets += "Claude" }
    "Codex" { if (-not $Codex) { throw "Codex CLI was not found" }; $Targets += "Codex" }
    "All" {
        if (-not $Claude) { throw "Claude Code CLI was not found" }
        if (-not $Codex) { throw "Codex CLI was not found" }
        $Targets += @("Claude", "Codex")
    }
    "Auto" {
        if ($Claude) { $Targets += "Claude" }
        if ($Codex) { $Targets += "Codex" }
        if ($Targets.Count -eq 0) {
            if ($SkipIfUnavailable) { Write-Warning "No supported model CLI was detected"; return }
            throw "Claude Code and Codex CLI were not detected"
        }
    }
}

if ($Targets -contains "Claude") {
    $ClaudeConfig = if ($ClaudeScope -eq "project") {
        Join-Path (Get-Location).Path ".mcp.json"
    } else {
        Join-Path $UserHome ".claude.json"
    }
    Backup-File $ClaudeConfig
    Invoke-External $Claude.Source @("mcp", "remove", "--scope", $ClaudeScope, $Name) -IgnoreExitCode
    Invoke-External $Claude.Source @(
        "mcp", "add", $Name,
        "--scope", $ClaudeScope,
        "--env", "HELIX_MODEL_WORKER_CONFIG=$ConfigPath",
        "--", $Node.Source, $EntryPath
    )
    Invoke-External $Claude.Source @("mcp", "get", $Name)
}

if ($Targets -contains "Codex") {
    Backup-File (Join-Path (Join-Path $UserHome ".codex") "config.toml")
    Invoke-External $Codex.Source @("mcp", "remove", $Name) -IgnoreExitCode
    Invoke-External $Codex.Source @(
        "mcp", "add", $Name,
        "--env", "HELIX_MODEL_WORKER_CONFIG=$ConfigPath",
        "--", $Node.Source, $EntryPath
    )
    Invoke-External $Codex.Source @("mcp", "get", $Name)
}

Write-Host "Model Worker MCP registration completed for: $($Targets -join ', ')"
