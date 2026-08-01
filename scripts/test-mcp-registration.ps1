$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("helix-mcp-register-" + [guid]::NewGuid().ToString("N"))
$FakeBin = Join-Path $TempRoot "bin"
$LogFile = Join-Path $TempRoot "cli.log"
$Entry = Join-Path $TempRoot "index.js"
$Broker = Join-Path $TempRoot "helix-credential-broker.exe"
$Config = Join-Path $TempRoot "ssh-mcp.json"
$OldPath = $env:PATH
$OldHome = $env:HOME
$OldUserProfile = $env:USERPROFILE
$OldLog = $env:HELIX_TEST_LOG

try {
    New-Item -ItemType Directory -Force -Path $FakeBin | Out-Null
    New-Item -ItemType File -Force -Path $Entry, $Broker | Out-Null
    Set-Content -LiteralPath $Config -Value '{"version":1,"settings":{},"hosts":{}}' -Encoding utf8

    @'
@echo off
echo claude %*>>"%HELIX_TEST_LOG%"
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $FakeBin "claude.cmd") -Encoding ascii

    @'
@echo off
echo codex %*>>"%HELIX_TEST_LOG%"
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $FakeBin "codex.cmd") -Encoding ascii

    $env:PATH = "$FakeBin;$OldPath"
    $env:HOME = $TempRoot
    $env:USERPROFILE = $TempRoot
    $env:HELIX_TEST_LOG = $LogFile

    & (Join-Path $RootDir "scripts\register-mcp.ps1") `
        -Client All `
        -ClaudeScope user `
        -ConfigPath $Config `
        -EntryPath $Entry `
        -BrokerPath $Broker

    & (Join-Path $RootDir "scripts\unregister-mcp.ps1") `
        -Client All `
        -ClaudeScope user

    $Log = Get-Content -LiteralPath $LogFile -Raw
    $Expected = @(
        'claude mcp remove --scope user helix-ssh',
        'claude mcp add-json --scope user helix-ssh',
        'claude mcp get helix-ssh',
        'codex mcp remove helix-ssh',
        'codex mcp add helix-ssh --env HELIX_SSH_CONFIG=',
        'codex mcp get helix-ssh'
    )

    foreach ($Pattern in $Expected) {
        if (-not $Log.Contains($Pattern)) {
            throw "注册脚本测试失败，缺少命令片段: $Pattern`n实际日志:`n$Log"
        }
    }

    Write-Host "MCP registration script smoke test passed."
} finally {
    $env:PATH = $OldPath
    $env:HOME = $OldHome
    $env:USERPROFILE = $OldUserProfile
    $env:HELIX_TEST_LOG = $OldLog
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
