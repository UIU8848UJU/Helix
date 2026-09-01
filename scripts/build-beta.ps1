[CmdletBinding()]
param(
    [string]$Version = "0.4.2",
    [string]$OutDir = ""
)

# Builds the Helix beta offline package:
#   1. runs the full test gate (Rust release tests, TS tests, type check)
#   2. builds helixd.exe (release) and bundles the ssh-mcp server into one file
#   3. assembles dist\helix-<Version>-win-x64\ with install scripts, config,
#      AI guide and admin script
#   4. writes SHA256SUMS.txt and a zip for distribution
# Users only need Node.js 20+ and ssh/scp: no cargo, npm install or tsc required.

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $RootDir "dist"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Missing dependency: cargo (Rust toolchain)"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Missing dependency: node"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Missing dependency: npm"
}

$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$PackageName = "helix-$Version-win-x64"
$PackageDir = Join-Path $OutDir $PackageName

$OriginalErrorActionPreference = $ErrorActionPreference
# Native CLIs (cargo/npm/npx) write progress to stderr; PowerShell 5.1 with
# Stop turns that into a terminating error before the exit code can be checked.
$ErrorActionPreference = "Continue"
Push-Location $RootDir
try {
    Write-Host "== Test gate =="
    & cargo test --release --workspace
    if ($LASTEXITCODE -ne 0) { throw "Rust release tests failed" }

    & npm run check
    if ($LASTEXITCODE -ne 0) { throw "TypeScript type check failed" }

    & npm test
    if ($LASTEXITCODE -ne 0) { throw "TypeScript tests failed" }

    Write-Host "== Build =="
    & cargo build --release --workspace
    if ($LASTEXITCODE -ne 0) { throw "Rust build failed" }

    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed" }

    & npx esbuild apps/ssh-mcp/src/index.ts `
        --bundle `
        --platform=node `
        --format=esm `
        --target=node20 `
        --outfile="dist/helix-ssh-mcp.bundle.mjs" `
        --log-level=warning
    if ($LASTEXITCODE -ne 0) { throw "esbuild bundle failed" }
} finally {
    Pop-Location
    $ErrorActionPreference = $OriginalErrorActionPreference
}

$Helixd = Join-Path $RootDir "target\release\helixd.exe"
$Bundle = Join-Path $RootDir "dist\helix-ssh-mcp.bundle.mjs"
if (-not (Test-Path -LiteralPath $Helixd)) { throw "Missing build output: $Helixd" }
if (-not (Test-Path -LiteralPath $Bundle)) { throw "Missing bundle output: $Bundle" }

Write-Host "== Assembling $PackageName =="
$ExpectedPackageDir = [System.IO.Path]::GetFullPath((Join-Path $OutDir $PackageName))
if ([System.IO.Path]::GetFullPath($PackageDir) -ne $ExpectedPackageDir -or
    [System.IO.Path]::GetDirectoryName($ExpectedPackageDir) -ne $OutDir) {
    throw "Refusing to replace package directory outside the requested output directory: $PackageDir"
}
if (Test-Path -LiteralPath $PackageDir) {
    Remove-Item -LiteralPath $PackageDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null

$Files = @(
    @{ Name = "helixd.exe";                    Source = $Helixd },
    @{ Name = "helix-ssh-mcp.bundle.mjs";      Source = $Bundle },
    @{ Name = "ssh-mcp.config.json";           Source = (Join-Path $RootDir "examples\ssh-mcp.config.json") },
    @{ Name = "HELIX_AI_GUIDE.md";             Source = (Join-Path $RootDir "docs\guides\HELIX_AI_GUIDE.md") },
    @{ Name = "helix-admin.ps1";               Source = (Join-Path $RootDir "scripts\helix-admin.ps1") },
    @{ Name = "install.ps1";                   Source = (Join-Path $RootDir "scripts\install-beta.ps1") },
    @{ Name = "register-mcp.ps1";              Source = (Join-Path $RootDir "scripts\register-mcp.ps1") },
    @{ Name = "unregister-mcp.ps1";            Source = (Join-Path $RootDir "scripts\unregister-mcp.ps1") }
)

foreach ($File in $Files) {
    if (-not (Test-Path -LiteralPath $File.Source)) {
        throw "Missing package source: $($File.Source)"
    }
    Copy-Item -LiteralPath $File.Source -Destination (Join-Path $PackageDir $File.Name) -Force
}

$InstallMd = Join-Path $PackageDir "INSTALL.md"
$InstallDoc = @"
# Helix $Version (beta)

Remote execution and persistent-session runtime for AI agents: SSH, PTY,
SFTP, credentials, task queues, Docker/Compose, and durable remote jobs.

## Requirements

- Windows 10/11 x64
- Node.js 20+
- ssh and scp (the Windows OpenSSH client is supported)

No Rust toolchain, npm install, or local compilation is required.

## Install

```powershell
# Run from the extracted package directory.
.\install.ps1

# Install without automatically registering an MCP client.
.\install.ps1 -RegisterClient None
```

The script installs helixd, the MCP server, configuration, AI guide,
and administration scripts under %APPDATA%\Helix\. It can register the
helix-ssh MCP server with installed Claude Code and Codex clients.

## MCP client

- Registered server name: helix-ssh
- Manual configuration (also printed with -RegisterClient None):
  - command: node
  - args: <install-directory>\bin\helix-ssh-mcp.mjs
  - env: HELIX_SSH_CONFIG / HELIX_CREDENTIAL_BROKER / HELIX_AI_GUIDE / HELIX_ADMIN_SCRIPT

## Verify

SHA256SUMS.txt lists the SHA-256 digest of every other file in the package.

## Use

Add a host with host_add or edit ssh-mcp.json, then use ssh_exec, ssh_check,
sudo_exec, ssh_upload, ssh_download, job_*, docker_*, compose_*, and terminal_*
tools. A Windows credential prompt records a password on first connection to a
password-authenticated host.
"@
[System.IO.File]::WriteAllText($InstallMd, $InstallDoc, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "== Checksums =="
$ChecksumLines = @()
Get-ChildItem -LiteralPath $PackageDir -File |
    Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
    Sort-Object Name |
    ForEach-Object {
    $Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $ChecksumLines += "$Hash  $($_.Name)"
}
$ChecksumFile = Join-Path $PackageDir "SHA256SUMS.txt"
[System.IO.File]::WriteAllLines($ChecksumFile, $ChecksumLines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "== Zip =="
$ZipPath = Join-Path $OutDir "$PackageName.zip"
if (Test-Path -LiteralPath $ZipPath) {
    [System.IO.File]::Delete($ZipPath)
}
Compress-Archive -Path (Join-Path $PackageDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "Beta package: $PackageDir"
Write-Host "Zip:          $ZipPath"
Write-Host "SHA-256 (zip): $((Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant())"
Write-Host ""
Write-Host "Offline install: expand the zip, then run .\install.ps1 inside it."
