[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "dist")
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Missing dependency: cargo (Rust toolchain)"
}

Push-Location $RootDir
try {
    & cargo test --release --workspace
    if ($LASTEXITCODE -ne 0) { throw "Rust daemon tests failed" }

    & cargo build --release --workspace
    if ($LASTEXITCODE -ne 0) { throw "Rust daemon build failed" }
} finally {
    Pop-Location
}

$Built = Join-Path $RootDir "target\release\helixd.exe"
if (-not (Test-Path -LiteralPath $Built)) {
    throw "Rust daemon was not found: $Built"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Target = Join-Path $OutDir "helixd.exe"
Copy-Item -LiteralPath $Built -Destination $Target -Force

$Hash = (Get-FileHash -LiteralPath $Built -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host ""
Write-Host "Release daemon saved: $Target"
Write-Host "SHA-256: $Hash"
Write-Host ""
Write-Host "Offline install (skips cargo):"
Write-Host ".\scripts\install.ps1 -BrokerBinary $Target"
