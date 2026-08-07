[CmdletBinding()]
param(
    [ValidateSet("Auto", "Claude", "Codex", "All", "None")]
    [string]$RegisterClient = "All",
    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user",
    [string]$AllowedRoot,
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$UserHome = [Environment]::GetFolderPath("UserProfile")
if (-not $AllowedRoot) { $AllowedRoot = Split-Path $RootDir -Parent }
$AllowedRoot = [System.IO.Path]::GetFullPath($AllowedRoot)
if (-not (Test-Path -LiteralPath $AllowedRoot -PathType Container)) {
    throw "AllowedRoot must be an existing directory: $AllowedRoot"
}
if (-not $ConfigPath) {
    $Base = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $UserHome "AppData\Roaming" }
    $ConfigPath = Join-Path $Base "Helix\model-worker-mcp.json"
}
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)

foreach ($Command in @("node", "npm")) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "Missing dependency: $Command" }
}

Push-Location $RootDir
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    & npm run check --workspace apps/model-worker-mcp
    if ($LASTEXITCODE -ne 0) { throw "Model Worker type check failed" }
    & npm test --workspace apps/model-worker-mcp
    if ($LASTEXITCODE -ne 0) { throw "Model Worker tests failed" }
    & npm run build --workspace apps/model-worker-mcp
    if ($LASTEXITCODE -ne 0) { throw "Model Worker build failed" }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    $Config = [ordered]@{
        version = 1
        settings = [ordered]@{
            claudeCommand = "claude"
            gptCommand = "codex"
            allowedWorkingDirectories = @($AllowedRoot)
            defaultWorkingDirectory = $AllowedRoot
            defaultTimeoutSeconds = 300
            maxTimeoutSeconds = 1800
            maxOutputBytes = 1048576
            maxPromptChars = 200000
            maxConcurrentWorkers = 2
            auditEnabled = $true
        }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $ConfigPath -Parent) | Out-Null
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ConfigPath, (($Config | ConvertTo-Json -Depth 10) + [Environment]::NewLine), $Utf8NoBom)
    Write-Host "Created config: $ConfigPath"
} else {
    Write-Host "Keeping existing config: $ConfigPath"
}

$EntryPath = Join-Path $RootDir "apps\model-worker-mcp\build\index.js"
Write-Host "Model Worker MCP built: $EntryPath"
if ($RegisterClient -ne "None") {
    & (Join-Path $PSScriptRoot "register-model-worker-mcp.ps1") `
        -Client $RegisterClient `
        -ClaudeScope $ClaudeScope `
        -ConfigPath $ConfigPath `
        -EntryPath $EntryPath
}
