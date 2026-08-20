[CmdletBinding()]
param(
    [string]$Version = "0.4.0-beta.1",
    [string]$OutDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "dist")
)

# Builds the Helix beta offline package:
#   1. runs the full test gate (Rust release tests, TS tests, type check)
#   2. builds helixd.exe (release) and bundles the ssh-mcp server into one file
#   3. assembles dist\helix-<Version>-win-x64\ with install scripts, config,
#      AI guide, skill and admin script
#   4. writes SHA256SUMS.txt and a zip for distribution
# Users only need Node.js 20+ and ssh/scp: no cargo, npm install or tsc required.

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

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
New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null

$Files = @(
    @{ Name = "helixd.exe";                    Source = $Helixd },
    @{ Name = "helix-ssh-mcp.bundle.mjs";      Source = $Bundle },
    @{ Name = "ssh-mcp.config.json";           Source = (Join-Path $RootDir "examples\ssh-mcp.config.json") },
    @{ Name = "HELIX_AI_GUIDE.md";             Source = (Join-Path $RootDir "docs\guides\HELIX_AI_GUIDE.md") },
    @{ Name = "SKILL.md";                      Source = (Join-Path $RootDir "skills\helix-remote-operations\SKILL.md") },
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

面向 AI Agent 的远程执行与会话 Runtime：SSH/PTY/SFTP、凭据、任务队列、Docker/Compose、远端持久作业。

## 前置条件

- Windows 10/11 x64（本包为 win-x64）
- Node.js 20+
- ssh / scp（Windows 自带 OpenSSH 客户端）

不需要 Rust 工具链、不需要 npm install、不需要编译。

## 安装

```powershell
# 解压后，在包目录内执行
.\install.ps1

# 或跳过 MCP 客户端自动注册，只安装并打印配置
.\install.ps1 -RegisterClient None
```

脚本会把 helixd（内容寻址命名）、MCP 服务端、配置、AI 指南、Skill、运维脚本
安装到 %APPDATA%\Helix\，并尝试注册到已安装的 Claude Code / Codex。

## MCP 客户端

- 安装脚本注册名为 helix-ssh 的 MCP server（node 运行 helix-ssh-mcp.bundle.mjs）。
- 手动配置（-RegisterClient None 时输出）：
  - command: node
  - args: <安装目录>\bin\helix-ssh-mcp.mjs
  - env: HELIX_SSH_CONFIG / HELIX_CREDENTIAL_BROKER / HELIX_AI_GUIDE / HELIX_ADMIN_SCRIPT

## 校验

SHA256SUMS.txt 中列出了包内每个文件的 SHA-256。

## 使用

配置主机后（host_add / 编辑 ssh-mcp.json），即可使用 ssh_exec / ssh_check /
sudo_exec / ssh_upload / ssh_download / job_* / docker_* / compose_* 等工具。
首次密码主机连接会自动弹出 Windows 凭据窗口录入密码。
"@
[System.IO.File]::WriteAllText($InstallMd, $InstallDoc, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "== Checksums =="
$ChecksumLines = @()
Get-ChildItem -LiteralPath $PackageDir -File | Sort-Object Name | ForEach-Object {
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
