[CmdletBinding()]
param(
    [ValidateSet("Auto", "Claude", "Codex", "All", "None")]
    [string]$RegisterClient = "Auto",

    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user"
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigDir = if ($env:APPDATA) { Join-Path $env:APPDATA "Helix" } else { Join-Path $HOME ".config\helix" }
$ConfigFile = if ($env:HELIX_SSH_CONFIG) { $env:HELIX_SSH_CONFIG } else { Join-Path $ConfigDir "ssh-mcp.json" }

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing dependency: $Name"
    }
}

Require-Command node
Require-Command npm
Require-Command ssh
Require-Command scp
Require-Command cargo

$NodeMajor = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
if ($NodeMajor -lt 20) {
    throw "Node.js 20 or newer is required. Current version: $(& node --version)"
}

Push-Location $RootDir
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    & npm run check
    if ($LASTEXITCODE -ne 0) { throw "TypeScript type check failed" }

    & npm test
    if ($LASTEXITCODE -ne 0) { throw "TypeScript tests failed" }

    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

    & cargo test --release --manifest-path "apps/credential-broker/Cargo.toml"
    if ($LASTEXITCODE -ne 0) { throw "Rust broker tests failed" }

    & cargo build --release --manifest-path "apps/credential-broker/Cargo.toml"
    if ($LASTEXITCODE -ne 0) { throw "Rust broker build failed" }
} finally {
    Pop-Location
}

$Broker = Join-Path $RootDir "apps\credential-broker\target\release\helix-credential-broker.exe"
if (-not (Test-Path $Broker)) {
    throw "Rust broker was not found: $Broker"
}

New-Item -ItemType Directory -Force -Path (Split-Path $ConfigFile -Parent) | Out-Null
if (-not (Test-Path $ConfigFile)) {
    Copy-Item (Join-Path $RootDir "examples\ssh-mcp.config.json") $ConfigFile
    Write-Host "Created config: $ConfigFile"
} else {
    Write-Host "Keeping existing config: $ConfigFile"
}

$Config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
if (-not $Config.settings) {
    $Config | Add-Member -NotePropertyName settings -NotePropertyValue ([PSCustomObject]@{})
}
if ($Config.settings.PSObject.Properties.Name -contains "credentialBrokerPath") {
    $Config.settings.credentialBrokerPath = $Broker
} else {
    $Config.settings | Add-Member -NotePropertyName credentialBrokerPath -NotePropertyValue $Broker
}
$Json = $Config | ConvertTo-Json -Depth 20
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigFile, $Json + [Environment]::NewLine, $Utf8NoBom)

$Entry = Join-Path $RootDir "apps\ssh-mcp\build\index.js"
Write-Host ""
Write-Host "Helix SSH MCP installation completed."
Write-Host "Entry:  $Entry"
Write-Host "Broker: $Broker"
Write-Host "Config: $ConfigFile"
Write-Host ""
Write-Host "Credential storage example (password input is hidden):"
Write-Host "& `"$Broker`" credential-store --target `"Helix/ssh/build-password/login`" --username `"developer`""
Write-Host ""
Write-Host "MCP client configuration:"
@"
{
  "mcpServers": {
    "helix-ssh": {
      "command": "node",
      "args": ["$($Entry.Replace('\', '\\'))"],
      "env": {
        "HELIX_SSH_CONFIG": "$($ConfigFile.Replace('\', '\\'))",
        "HELIX_CREDENTIAL_BROKER": "$($Broker.Replace('\', '\\'))"
      }
    }
  }
}
"@ | Write-Host

if ($RegisterClient -ne "None") {
    Write-Host ""
    Write-Host "Registering MCP clients: $RegisterClient"
    try {
        & (Join-Path $PSScriptRoot "register-mcp.ps1") `
            -Client $RegisterClient `
            -ClaudeScope $ClaudeScope `
            -ConfigPath $ConfigFile `
            -EntryPath $Entry `
            -BrokerPath $Broker `
            -SkipIfUnavailable
    } catch {
        Write-Warning "Helix was installed, but MCP client registration failed: $($_.Exception.Message)"
        Write-Host "Retry after fixing the client installation:"
        Write-Host ".\scripts\register-mcp.ps1 -Client $RegisterClient -ClaudeScope $ClaudeScope"
    }
}
