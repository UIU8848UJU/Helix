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
    Write-Host "已备份配置: $BackupPath"
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

    & $FilePath @Arguments | Out-Host
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0 -and -not $IgnoreExitCode) {
        throw "命令执行失败，退出码 $ExitCode：$FilePath $Display"
    }
}

if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
    throw "MCP 名称只能包含字母、数字、点、下划线和短横线"
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
    $BrokerPath = Join-Path $RootDir "apps\credential-broker\target\release\helix-credential-broker.exe"
}
$BrokerPath = Resolve-FullPath $BrokerPath

foreach ($RequiredPath in @($ConfigPath, $EntryPath, $BrokerPath)) {
    if (-not (Test-Path -LiteralPath $RequiredPath)) {
        throw "缺少 Helix 运行文件: $RequiredPath。请先执行 scripts\install.ps1"
    }
}

$Node = Get-Command node -ErrorAction Stop
$Claude = Get-Command claude -ErrorAction SilentlyContinue
$Codex = Get-Command codex -ErrorAction SilentlyContinue
$Targets = @()

switch ($Client) {
    "Claude" {
        if (-not $Claude) { throw "未找到 Claude Code CLI：claude" }
        $Targets += "Claude"
    }
    "Codex" {
        if (-not $Codex) { throw "未找到 Codex CLI：codex" }
        $Targets += "Codex"
    }
    "All" {
        if (-not $Claude) { throw "未找到 Claude Code CLI：claude" }
        if (-not $Codex) { throw "未找到 Codex CLI：codex" }
        $Targets += @("Claude", "Codex")
    }
    "Auto" {
        if ($Claude) { $Targets += "Claude" }
        if ($Codex) { $Targets += "Codex" }
        if ($Targets.Count -eq 0) {
            $Message = "未检测到 Claude Code 或 Codex CLI，跳过 MCP 注册"
            if ($SkipIfUnavailable) {
                Write-Warning $Message
                return
            }
            throw $Message
        }
    }
}

$ServerConfig = [ordered]@{
    type = "stdio"
    command = $Node.Source
    args = @($EntryPath)
    env = [ordered]@{
        HELIX_SSH_CONFIG = $ConfigPath
        HELIX_CREDENTIAL_BROKER = $BrokerPath
    }
}
$ServerJson = $ServerConfig | ConvertTo-Json -Depth 10 -Compress

if ($Targets -contains "Claude") {
    $ClaudeConfigPath = if ($ClaudeScope -eq "project") {
        Join-Path (Get-Location).Path ".mcp.json"
    } else {
        Join-Path $HOME ".claude.json"
    }
    Backup-File $ClaudeConfigPath

    Invoke-External $Claude.Source @("mcp", "remove", "--scope", $ClaudeScope, $Name) -IgnoreExitCode
    Invoke-External $Claude.Source @("mcp", "add-json", "--scope", $ClaudeScope, $Name, $ServerJson)
    Invoke-External $Claude.Source @("mcp", "get", $Name)
    Write-Host "Claude Code 注册完成：$Name，scope=$ClaudeScope"
}

if ($Targets -contains "Codex") {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    Backup-File (Join-Path $CodexHome "config.toml")

    Invoke-External $Codex.Source @("mcp", "remove", $Name) -IgnoreExitCode
    Invoke-External $Codex.Source @(
        "mcp", "add", $Name,
        "--env", "HELIX_SSH_CONFIG=$ConfigPath",
        "--env", "HELIX_CREDENTIAL_BROKER=$BrokerPath",
        "--", $Node.Source, $EntryPath
    )
    Invoke-External $Codex.Source @("mcp", "get", $Name)
    Write-Host "Codex 注册完成：$Name（用户级配置）"
}

Write-Host ""
Write-Host "请重启对应客户端，并使用 /mcp 或 MCP 列表确认 helix-ssh 已连接。"
