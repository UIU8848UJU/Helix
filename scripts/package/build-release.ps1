[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$Version,
    [string]$OutDir = '',
    [switch]$SkipCredentialIntegrationTests,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $RootDir 'dist'
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$PackageName = "helix-$Version-win-x64"
$PackageDir = Join-Path $OutDir $PackageName
$ZipPath = Join-Path $OutDir "$PackageName.zip"

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$File failed with exit code $LASTEXITCODE"
    }
}

function Require-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file was not found: $Path"
    }
}

function Remove-ExactPath([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

$cargoToml = Join-Path $RootDir 'Cargo.toml'
$versionMatch = Select-String -LiteralPath $cargoToml -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
$cargoVersion = $versionMatch.Matches.Groups[1].Value
if ($cargoVersion -ne $Version) {
    throw "Requested package version $Version does not match Cargo workspace version $cargoVersion"
}

foreach ($command in @('cargo', 'node', 'npm', 'npx')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing dependency: $command"
    }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$resolvedOutDir = [System.IO.Path]::GetFullPath($OutDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$resolvedPackageDir = [System.IO.Path]::GetFullPath($PackageDir)
if (-not $resolvedPackageDir.StartsWith("$resolvedOutDir$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write package outside output directory: $PackageDir"
}
if ((Test-Path -LiteralPath $PackageDir) -or (Test-Path -LiteralPath $ZipPath)) {
    if (-not $Force) {
        throw "Package already exists. Use -Force to replace only $PackageName and its zip."
    }
    Remove-ExactPath $PackageDir
    Remove-ExactPath $ZipPath
}

Push-Location $RootDir
try {
    Write-Host '== Rust test gate =='
    $rustTestArgs = @('test', '--release', '--workspace')
    if ($SkipCredentialIntegrationTests) {
        Write-Warning 'Skipping helix-credential integration tests by explicit request.'
        $rustTestArgs += '--exclude'
        $rustTestArgs += 'helix-credential'
    }
    Invoke-Native 'cargo' $rustTestArgs

    Write-Host '== TypeScript test gate =='
    Invoke-Native 'npm' @('run', 'check')
    Invoke-Native 'npm' @('test')
    Invoke-Native 'npm' @('run', 'build')

    Write-Host '== Release build =='
    Invoke-Native 'cargo' @('build', '--release', '--workspace')

    New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null
    $bundlePath = Join-Path $PackageDir 'helix-ssh-mcp.bundle.mjs'
    Invoke-Native 'npx' @(
        'esbuild', 'apps/ssh-mcp/src/index.ts', '--bundle', '--platform=node',
        '--format=esm', '--target=node20', "--outfile=$bundlePath", '--log-level=warning'
    )
} finally {
    Pop-Location
}

$sources = @(
    @{ Name = 'helixd.exe'; Source = Join-Path $RootDir 'target\release\helixd.exe' },
    @{ Name = 'ssh-mcp.config.json'; Source = Join-Path $RootDir 'examples\ssh-mcp.config.json' },
    @{ Name = 'HELIX_AI_GUIDE.md'; Source = Join-Path $RootDir 'docs\guides\HELIX_AI_GUIDE.md' },
    @{ Name = 'helix-admin.ps1'; Source = Join-Path $RootDir 'scripts\helix-admin.ps1' },
    # The release archive is offline-installable. The repository's install.ps1
    # is the source-tree installer and expects cargo/npm; install-beta.ps1 is
    # the self-contained installer for a prebuilt package.
    @{ Name = 'install.ps1'; Source = Join-Path $RootDir 'scripts\install-beta.ps1' },
    @{ Name = 'register-mcp.ps1'; Source = Join-Path $RootDir 'scripts\register-mcp.ps1' },
    @{ Name = 'unregister-mcp.ps1'; Source = Join-Path $RootDir 'scripts\unregister-mcp.ps1' }
)
foreach ($source in $sources) {
    Require-File $source.Source
    Copy-Item -LiteralPath $source.Source -Destination (Join-Path $PackageDir $source.Name) -Force
}

$installDoc = @"
# Helix $Version

Remote execution and persistent-session runtime for AI agents: SSH, PTY,
SFTP, credentials, task queues, Docker/Compose, and durable remote jobs.

## Requirements

- Windows 10/11 x64
- Node.js 20+
- ssh and scp (the Windows OpenSSH client is supported)

No Rust toolchain, npm install, or local compilation is required.

## Install

````powershell
# Run from the extracted package directory.
.\install.ps1

# Install without automatically registering an MCP client.
.\install.ps1 -RegisterClient None
````

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
tools. For persistent terminals, use terminal_open, terminal_exec, task_wait,
and terminal_read to submit a command and await completion without client-side
sleep polling.
"@
[System.IO.File]::WriteAllText(
    (Join-Path $PackageDir 'INSTALL.md'),
    $installDoc,
    (New-Object System.Text.UTF8Encoding($false))
)

$checksumFile = Join-Path $PackageDir 'SHA256SUMS.txt'
$checksumLines = @(
    Get-ChildItem -LiteralPath $PackageDir -File |
        Sort-Object Name |
        ForEach-Object {
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$hash  $($_.Name)"
        }
)
[System.IO.File]::WriteAllLines($checksumFile, $checksumLines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host '== Zip package =='
Compress-Archive -Path (Join-Path $PackageDir '*') -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host '== Verify extraction and checksums =='
$verifyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("helix-package-verify-" + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $verifyDir | Out-Null
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $verifyDir
    foreach ($line in Get-Content -LiteralPath (Join-Path $verifyDir 'SHA256SUMS.txt')) {
        $parts = $line -split '  ', 2
        if ($parts.Count -ne 2) { throw "Invalid checksum line: $line" }
        $actual = (Get-FileHash -LiteralPath (Join-Path $verifyDir $parts[1]) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $parts[0]) { throw "Checksum mismatch: $($parts[1])" }
    }
} finally {
    Remove-ExactPath $verifyDir
}

$zipHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Package: $PackageDir"
Write-Host "Zip:     $ZipPath"
Write-Host "SHA256:  $zipHash"
