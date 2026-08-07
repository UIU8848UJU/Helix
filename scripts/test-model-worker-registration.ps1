$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("helix-model-worker-register-" + [guid]::NewGuid().ToString("N"))
$FakeBin = Join-Path $TestRoot "bin"
$LogFile = Join-Path $TestRoot "cli.log"
$Entry = Join-Path $TestRoot "index.js"
$Config = Join-Path $TestRoot "model-worker.json"
$OldPath = $env:PATH
$OldUserProfile = $env:USERPROFILE
$OldLog = $env:HELIX_TEST_LOG

try {
    New-Item -ItemType Directory -Force -Path $FakeBin | Out-Null
    New-Item -ItemType File -Force -Path $Entry | Out-Null
    Set-Content -LiteralPath $Config -Value '{"version":1,"settings":{}}' -Encoding utf8
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
    $env:USERPROFILE = $TestRoot
    $env:HELIX_TEST_LOG = $LogFile

    & (Join-Path $RootDir "scripts\register-model-worker-mcp.ps1") `
        -Client All `
        -ClaudeScope user `
        -ConfigPath $Config `
        -EntryPath $Entry

    $Log = Get-Content -LiteralPath $LogFile -Raw
    $Expected = @(
        'claude mcp remove --scope user helix-model-worker',
        'claude mcp add helix-model-worker --scope user',
        '--env HELIX_MODEL_WORKER_CONFIG=',
        'claude mcp get helix-model-worker',
        'codex mcp remove helix-model-worker',
        'codex mcp add helix-model-worker --env HELIX_MODEL_WORKER_CONFIG=',
        'codex mcp get helix-model-worker'
    )
    foreach ($Pattern in $Expected) {
        if (-not $Log.Contains($Pattern)) {
            throw "Model Worker registration test failed; missing: $Pattern`n$Log"
        }
    }
    Write-Host "Model Worker MCP registration test passed."
} finally {
    $env:PATH = $OldPath
    $env:USERPROFILE = $OldUserProfile
    $env:HELIX_TEST_LOG = $OldLog
    Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
