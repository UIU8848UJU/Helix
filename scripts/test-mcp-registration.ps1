$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("helix-mcp-register-" + [guid]::NewGuid().ToString("N"))
$FakeBin = Join-Path $TempRoot "bin"
$LogFile = Join-Path $TempRoot "cli.log"
$Entry = Join-Path $TempRoot "index.js"
$Broker = Join-Path $TempRoot "helixd.exe"
$Config = Join-Path $TempRoot "ssh-mcp.json"
$Guide = Join-Path $TempRoot "HELIX_AI_GUIDE.md"
$Admin = Join-Path $TempRoot "helix-admin.ps1"
$OldPath = $env:PATH
$OldHome = $env:HOME
$OldUserProfile = $env:USERPROFILE
$OldLog = $env:HELIX_TEST_LOG

try {
    New-Item -ItemType Directory -Force -Path $FakeBin | Out-Null
    New-Item -ItemType File -Force -Path $Entry, $Broker, $Guide, $Admin | Out-Null
    Set-Content -LiteralPath $Config -Value '{"version":1,"settings":{},"hosts":{}}' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $TempRoot "browser-mcp.json") -Value '{"version":1,"settings":{},"allowedDomains":[],"storageStates":[]}' -Encoding utf8
    New-Item -ItemType File -Force -Path (Join-Path $TempRoot "browser-index.js") | Out-Null

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
        -BrokerPath $Broker `
        -GuidePath $Guide `
        -AdminScriptPath $Admin `
        -BrowserEntryPath (Join-Path $TempRoot "browser-index.js") `
        -BrowserConfigPath (Join-Path $TempRoot "browser-mcp.json") `

    & (Join-Path $RootDir "scripts\unregister-mcp.ps1") `
        -Client All `
        -ClaudeScope user `
        -IncludeBrowser

    $Log = Get-Content -LiteralPath $LogFile -Raw
    $Expected = @(
        'claude mcp remove --scope user helix-ssh',
        'claude mcp add helix-ssh --scope user',
        '--env HELIX_SSH_CONFIG=',
        '--env HELIX_CREDENTIAL_BROKER=',
        '--env HELIX_AI_GUIDE=',
        '--env HELIX_ADMIN_SCRIPT=',
        'claude mcp get helix-ssh',
        'codex mcp remove helix-ssh',
        'codex mcp add helix-ssh --env HELIX_SSH_CONFIG=',
        'codex mcp get helix-ssh',
        'claude mcp remove --scope user helix-browser',
        'claude mcp add helix-browser --scope user',
        '--env BROWSER_MCP_CONFIG=',
        'claude mcp get helix-browser',
        'codex mcp remove helix-browser',
        'codex mcp add helix-browser --env BROWSER_MCP_CONFIG=',
        'codex mcp get helix-browser'
    )

    foreach ($Pattern in $Expected) {
        if (-not $Log.Contains($Pattern)) {
            throw "Registration script smoke test failed. Missing command fragment: $Pattern`nActual log:`n$Log"
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
