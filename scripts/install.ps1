[CmdletBinding()]
param(
    [ValidateSet("Auto", "Claude", "Codex", "All", "None")]
    [string]$RegisterClient = "Auto",

    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user",

    [ValidateSet("Harness", "Personal", "EnterpriseLocked")]
    [string]$DeploymentMode = "Harness"
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

function Set-ConfigProperty($Object, [string]$Name, $Value) {
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.$Name = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
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

$RuntimeDir = Split-Path $ConfigFile -Parent
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
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

if ($DeploymentMode -eq "EnterpriseLocked") {
    Set-ConfigProperty $Config.settings "allowHostMutation" $false
    Set-ConfigProperty $Config.settings "allowPolicyMutation" $false
    Set-ConfigProperty $Config.settings "strictHostKeyChecking" $true
} else {
    # Harness/Personal mode only keeps the destructive-command guard as an execution boundary.
    Set-ConfigProperty $Config.settings "allowHostMutation" $true
    Set-ConfigProperty $Config.settings "allowPolicyMutation" $true
    Set-ConfigProperty $Config.settings "strictHostKeyChecking" $false

    if ($Config.hosts) {
        foreach ($HostProperty in $Config.hosts.PSObject.Properties) {
            $HostConfig = $HostProperty.Value
            Set-ConfigProperty $HostConfig "allowedRemotePaths" @("/")
            if ($HostConfig.sudo) {
                Set-ConfigProperty $HostConfig.sudo "allow" @("^.*$")
            }
        }
    }
}

Set-ConfigProperty $Config.settings "credentialBrokerPath" $Broker

$Json = $Config | ConvertTo-Json -Depth 20
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigFile, $Json + [Environment]::NewLine, $Utf8NoBom)

$GuideSource = Join-Path $RootDir "docs\guides\HELIX_AI_GUIDE.md"
$GuideFile = Join-Path $RuntimeDir "HELIX_AI_GUIDE.md"
Copy-Item -LiteralPath $GuideSource -Destination $GuideFile -Force

$SkillSource = Join-Path $RootDir "skills\helix-remote-operations\SKILL.md"
$SkillDir = Join-Path $RuntimeDir "skills\helix-remote-operations"
$SkillFile = Join-Path $SkillDir "SKILL.md"
New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
Copy-Item -LiteralPath $SkillSource -Destination $SkillFile -Force

$AdminSource = Join-Path $RootDir "scripts\helix-admin.ps1"
$AdminFile = Join-Path $RuntimeDir "helix-admin.ps1"
Copy-Item -LiteralPath $AdminSource -Destination $AdminFile -Force

$Entry = Join-Path $RootDir "apps\ssh-mcp\build\index.js"
Write-Host ""
Write-Host "Helix SSH MCP installation completed."
Write-Host "Entry:  $Entry"
Write-Host "Broker: $Broker"
Write-Host "Config: $ConfigFile"
Write-Host "AI guide: $GuideFile"
Write-Host "Skill:    $SkillFile"
Write-Host "Admin:    $AdminFile"
Write-Host "Deployment mode: $DeploymentMode"
Write-Host "Host mutation: $($Config.settings.allowHostMutation)"
Write-Host "Policy mutation: $($Config.settings.allowPolicyMutation)"
Write-Host "Strict host-key checking: $($Config.settings.strictHostKeyChecking)"
Write-Host "Direct sudo: enabled; destructive commands are blocked by the Harness guard"
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
        "HELIX_CREDENTIAL_BROKER": "$($Broker.Replace('\', '\\'))",
        "HELIX_AI_GUIDE": "$($GuideFile.Replace('\', '\\'))",
        "HELIX_ADMIN_SCRIPT": "$($AdminFile.Replace('\', '\\'))"
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
            -AdminScriptPath $AdminFile `
            -SkipIfUnavailable
    } catch {
        Write-Warning "Helix was installed, but MCP client registration failed: $($_.Exception.Message)"
        Write-Host "Retry after fixing the client installation:"
        Write-Host ".\scripts\register-mcp.ps1 -Client $RegisterClient -ClaudeScope $ClaudeScope"
    }
}
