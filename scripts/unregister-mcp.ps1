[CmdletBinding()]
param(
    [ValidateSet("Auto", "Claude", "Codex", "All")]
    [string]$Client = "Auto",

    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user",

    [string]$Name = "helix-ssh",
    [switch]$SkipIfUnavailable,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

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

function Invoke-External([string]$FilePath, [string[]]$Arguments) {
    $Display = (($Arguments | ForEach-Object { Format-Argument $_ }) -join " ")
    Write-Host ">> $FilePath $Display"
    if ($DryRun) {
        return
    }

    & $FilePath @Arguments | Out-Host
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0) {
        Write-Warning "命令退出码为 $ExitCode；目标可能原本就不存在：$FilePath $Display"
    }
}

if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
    throw "MCP 名称只能包含字母、数字、点、下划线和短横线"
}

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
            $Message = "未检测到 Claude Code 或 Codex CLI，跳过 MCP 注销"
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
    Invoke-External $Claude.Source @("mcp", "remove", "--scope", $ClaudeScope, $Name)
    Write-Host "Claude Code 已注销：$Name，scope=$ClaudeScope"
}

if ($Targets -contains "Codex") {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    Backup-File (Join-Path $CodexHome "config.toml")
    Invoke-External $Codex.Source @("mcp", "remove", $Name)
    Write-Host "Codex 已注销：$Name"
}
