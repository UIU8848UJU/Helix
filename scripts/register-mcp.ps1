[CmdletBinding()]
param(
    [ValidateSet("Auto", "Claude", "Codex", "All")]
    [string]$Client = "Auto",

    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user",

    [string]$Name = "helix-ssh",
    [string]$ConfigPath,
    [string]$EntryPath,
    [string]$BrokerPath,
    [string]$GuidePath,
    [string]$AdminScriptPath,
    [string]$BrowserEntryPath,
    [string]$BrowserConfigPath,
    [switch]$SkipIfUnavailable,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Resolve-FullPath([string]$PathValue) {
    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $null
    }
    return [System.IO.Path]::GetFullPath($PathValue)
}

function Backup-File([string]$PathValue) {
    if (-not $PathValue -or -not (Test-Path -LiteralPath $PathValue)) {
        return
    }
    $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $BackupPath = "$PathValue.helix-backup-$Timestamp"
    Copy-Item -LiteralPath $PathValue -Destination $BackupPath -Force
    Write-Host "Backed up config: $BackupPath"
}

function Format-Argument([string]$Value) {
    if ($Value -match '[\s"]') {
        return '"' + ($Value -replace '"', '\"') + '"'
    }
    return $Value
}

function Invoke-External(
    [string]$FilePath,
    [string[]]$Arguments,
    [switch]$IgnoreExitCode
) {
    $Display = (($Arguments | ForEach-Object { Format-Argument $_ }) -join " ")
    Write-Host ">> $FilePath $Display"
    if ($DryRun) {
        return
    }

    # Native CLIs (claude/codex) write errors to stderr. PowerShell 5.1 with
    # $ErrorActionPreference = "Stop" turns any stderr line into a terminating
    # error before the exit code can be checked, so relax EAP around the call.
    # -IgnoreExitCode + $LASTEXITCODE below still control real failures.
    $OriginalErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $FilePath @Arguments | Out-Host
    } finally {
        $ErrorActionPreference = $OriginalErrorActionPreference
    }
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0 -and -not $IgnoreExitCode) {
        throw "Command failed with exit code ${ExitCode}: $FilePath $Display"
    }
}

if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
    throw "MCP name may only contain letters, digits, dot, underscore, and dash"
}

if (-not $ConfigPath) {
    if ($env:HELIX_SSH_CONFIG) {
        $ConfigPath = $env:HELIX_SSH_CONFIG
    } else {
        $Base = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME "AppData\Roaming" }
        $ConfigPath = Join-Path $Base "Helix\ssh-mcp.json"
    }
}
$ConfigPath = Resolve-FullPath $ConfigPath

if (-not $EntryPath) {
    $EntryPath = Join-Path $RootDir "apps\ssh-mcp\build\index.js"
}
$EntryPath = Resolve-FullPath $EntryPath

if (-not $BrokerPath) {
    if ($env:HELIX_CREDENTIAL_BROKER) {
        $BrokerPath = $env:HELIX_CREDENTIAL_BROKER
    } elseif (Test-Path -LiteralPath $ConfigPath) {
        $Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        $BrokerPath = $Config.settings.credentialBrokerPath
    }
}
if (-not $BrokerPath) {
    $BrokerPath = Join-Path $RootDir "target\release\helixd.exe"
}
$BrokerPath = Resolve-FullPath $BrokerPath

if (-not $GuidePath) {
    if ($env:HELIX_AI_GUIDE) {
        $GuidePath = $env:HELIX_AI_GUIDE
    } else {
        $GuidePath = Join-Path (Split-Path $ConfigPath -Parent) "HELIX_AI_GUIDE.md"
    }
}
$GuidePath = Resolve-FullPath $GuidePath

if (-not (Test-Path -LiteralPath $GuidePath)) {
    $GuideSource = Join-Path $RootDir "docs\guides\HELIX_AI_GUIDE.md"
    New-Item -ItemType Directory -Force -Path (Split-Path $GuidePath -Parent) | Out-Null
    Copy-Item -LiteralPath $GuideSource -Destination $GuidePath -Force
    Write-Host "Installed AI guide: $GuidePath"
}

if (-not $AdminScriptPath) {
    if ($env:HELIX_ADMIN_SCRIPT) {
        $AdminScriptPath = $env:HELIX_ADMIN_SCRIPT
    } else {
        $AdminScriptPath = Join-Path (Split-Path $ConfigPath -Parent) "helix-admin.ps1"
    }
}
$AdminScriptPath = Resolve-FullPath $AdminScriptPath

if ($BrowserEntryPath) {
    $BrowserEntryPath = Resolve-FullPath $BrowserEntryPath
    if (-not (Test-Path -LiteralPath $BrowserEntryPath)) {
        throw "Missing browser MCP entry: $BrowserEntryPath. Run scripts\install.ps1 first"
    }
    if (-not $BrowserConfigPath) {
        if ($env:BROWSER_MCP_CONFIG) {
            $BrowserConfigPath = $env:BROWSER_MCP_CONFIG
        } else {
            $Base = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME "AppData\Roaming" }
            $BrowserConfigPath = Join-Path $Base "Helix\browser-mcp.json"
        }
    }
    $BrowserConfigPath = Resolve-FullPath $BrowserConfigPath
    if (-not (Test-Path -LiteralPath $BrowserConfigPath)) {
        throw "Missing browser MCP config: $BrowserConfigPath. Run scripts\install.ps1 first"
    }
}

if (-not (Test-Path -LiteralPath $AdminScriptPath)) {
    $AdminSource = Join-Path $RootDir "scripts\helix-admin.ps1"
    New-Item -ItemType Directory -Force -Path (Split-Path $AdminScriptPath -Parent) | Out-Null
    Copy-Item -LiteralPath $AdminSource -Destination $AdminScriptPath -Force
    Write-Host "Installed admin script: $AdminScriptPath"
}

foreach ($RequiredPath in @($ConfigPath, $EntryPath, $BrokerPath, $GuidePath, $AdminScriptPath)) {
    if (-not (Test-Path -LiteralPath $RequiredPath)) {
        throw "Missing Helix runtime file: $RequiredPath. Run scripts\install.ps1 first"
    }
}

$Node = Get-Command node -ErrorAction Stop
$Claude = Get-Command claude -ErrorAction SilentlyContinue
$Codex = Get-Command codex -ErrorAction SilentlyContinue
$Targets = @()

switch ($Client) {
    "Claude" {
        if (-not $Claude) { throw "Claude Code CLI was not found: claude" }
        $Targets += "Claude"
    }
    "Codex" {
        if (-not $Codex) { throw "Codex CLI was not found: codex" }
        $Targets += "Codex"
    }
    "All" {
        if (-not $Claude) { throw "Claude Code CLI was not found: claude" }
        if (-not $Codex) { throw "Codex CLI was not found: codex" }
        $Targets += @("Claude", "Codex")
    }
    "Auto" {
        if ($Claude) { $Targets += "Claude" }
        if ($Codex) { $Targets += "Codex" }
        if ($Targets.Count -eq 0) {
            $Message = "Claude Code and Codex CLI were not detected; MCP registration was skipped"
            if ($SkipIfUnavailable) {
                Write-Warning $Message
                return
            }
            throw $Message
        }
    }
}

if ($Targets -contains "Claude") {
    $ClaudeConfigPath = if ($ClaudeScope -eq "project") {
        Join-Path (Get-Location).Path ".mcp.json"
    } else {
        Join-Path $HOME ".claude.json"
    }
    Backup-File $ClaudeConfigPath

    Invoke-External $Claude.Source @("mcp", "remove", "--scope", $ClaudeScope, $Name) -IgnoreExitCode
    Invoke-External $Claude.Source @(
        "mcp", "add", $Name,
        "--scope", $ClaudeScope,
        "--env", "HELIX_SSH_CONFIG=$ConfigPath",
        "--env", "HELIX_CREDENTIAL_BROKER=$BrokerPath",
        "--env", "HELIX_AI_GUIDE=$GuidePath",
        "--env", "HELIX_ADMIN_SCRIPT=$AdminScriptPath",
        "--", $Node.Source, $EntryPath
    )
    Invoke-External $Claude.Source @("mcp", "get", $Name)
    Write-Host "Claude Code registration completed: $Name, scope=$ClaudeScope"

    if ($BrowserEntryPath) {
        Invoke-External $Claude.Source @("mcp", "remove", "--scope", $ClaudeScope, "helix-browser") -IgnoreExitCode
        Invoke-External $Claude.Source @(
            "mcp", "add", "helix-browser",
            "--scope", $ClaudeScope,
            "--env", "BROWSER_MCP_CONFIG=$BrowserConfigPath",
            "--", $Node.Source, $BrowserEntryPath
        )
        Invoke-External $Claude.Source @("mcp", "get", "helix-browser")
        Write-Host "Claude Code registration completed: helix-browser, scope=$ClaudeScope"
    }
}

if ($Targets -contains "Codex") {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    Backup-File (Join-Path $CodexHome "config.toml")

    Invoke-External $Codex.Source @("mcp", "remove", $Name) -IgnoreExitCode
    Invoke-External $Codex.Source @(
        "mcp", "add", $Name,
        "--env", "HELIX_SSH_CONFIG=$ConfigPath",
        "--env", "HELIX_CREDENTIAL_BROKER=$BrokerPath",
        "--env", "HELIX_AI_GUIDE=$GuidePath",
        "--env", "HELIX_ADMIN_SCRIPT=$AdminScriptPath",
        "--", $Node.Source, $EntryPath
    )
    Invoke-External $Codex.Source @("mcp", "get", $Name)
    Write-Host "Codex registration completed: $Name (user-level config)"

    if ($BrowserEntryPath) {
        Invoke-External $Codex.Source @("mcp", "remove", "helix-browser") -IgnoreExitCode
        Invoke-External $Codex.Source @(
            "mcp", "add", "helix-browser",
            "--env", "BROWSER_MCP_CONFIG=$BrowserConfigPath",
            "--", $Node.Source, $BrowserEntryPath
        )
        Invoke-External $Codex.Source @("mcp", "get", "helix-browser")
        Write-Host "Codex registration completed: helix-browser (user-level config)"
    }
}

Write-Host ""
Write-Host "Restart the selected client and verify helix-ssh and (when installed) helix-browser using /mcp or the MCP list."
