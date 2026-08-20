[CmdletBinding()]
param(
    [ValidateSet("Auto", "None")]
    [string]$RegisterClient = "Auto",

    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user",

    [ValidateSet("Harness", "Personal", "EnterpriseLocked")]
    [string]$DeploymentMode = "Harness"
)

# Offline installer for the Helix beta package. Installs the prebuilt daemon,
# the bundled MCP server, config, AI guide, skill and admin script from this
# directory into the Helix runtime directory. No Rust toolchain, npm install or
# TypeScript build is required; only Node.js 20+ and ssh/scp are needed.

$ErrorActionPreference = "Stop"
$PackageDir = $PSScriptRoot

function Require-PackageFile([string]$RelativePath) {
    $Path = Join-Path $PackageDir $RelativePath
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Beta package is incomplete: missing $RelativePath"
    }
    return $Path
}

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing dependency: $Name"
    }
}

function Stop-HelixBrokerDaemon([string]$ExistingBrokerPath) {
    if ($ExistingBrokerPath -and (Test-Path -LiteralPath $ExistingBrokerPath)) {
        try {
            & $ExistingBrokerPath daemon-stop 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Stopped existing Helix daemon."
                Start-Sleep -Milliseconds 150
                return
            }
        } catch {
            # Fall through to the direct Named Pipe shutdown request.
        }
    }
    try {
        $Pipe = New-Object System.IO.Pipes.NamedPipeClientStream(
            ".",
            "helix-credential-broker-v1",
            [System.IO.Pipes.PipeDirection]::InOut,
            [System.IO.Pipes.PipeOptions]::None
        )
        try {
            $Pipe.Connect(250)
            $Writer = New-Object System.IO.StreamWriter($Pipe, (New-Object System.Text.UTF8Encoding($false)), 1024, $true)
            $Writer.AutoFlush = $true
            $Reader = New-Object System.IO.StreamReader($Pipe, [System.Text.Encoding]::UTF8, $false, 1024, $true)
            $Writer.WriteLine('{"op":"shutdown"}')
            [void]$Reader.ReadLine()
            Write-Host "Requested shutdown of existing Helix daemon."
        } finally {
            $Pipe.Dispose()
        }
        Start-Sleep -Milliseconds 150
    } catch {
        # No running daemon. Safe to continue.
    }
}

Require-Command node
Require-Command ssh
Require-Command scp

$NodeMajor = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
if ($NodeMajor -lt 20) {
    throw "Node.js 20 or newer is required. Current version: $(& node --version)"
}

$Helixd = Require-PackageFile "helixd.exe"
$Bundle = Require-PackageFile "helix-ssh-mcp.bundle.mjs"
$TemplateConfig = Require-PackageFile "ssh-mcp.config.json"
$GuideSource = Require-PackageFile "HELIX_AI_GUIDE.md"
$SkillSource = Require-PackageFile "SKILL.md"
$AdminSource = Require-PackageFile "helix-admin.ps1"

$ConfigDir = if ($env:APPDATA) { Join-Path $env:APPDATA "Helix" } else { Join-Path $HOME ".config\helix" }
$ConfigFile = if ($env:HELIX_SSH_CONFIG) { $env:HELIX_SSH_CONFIG } else { Join-Path $ConfigDir "ssh-mcp.json" }

$ExistingBrokerPath = $null
if (Test-Path -LiteralPath $ConfigFile) {
    try {
        $ExistingConfig = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        if ($ExistingConfig.settings -and $ExistingConfig.settings.credentialBrokerPath) {
            $ExistingBrokerPath = [string]$ExistingConfig.settings.credentialBrokerPath
        }
    } catch {
        Write-Warning "Could not inspect the existing Helix config before upgrade: $($_.Exception.Message)"
    }
}

Stop-HelixBrokerDaemon $ExistingBrokerPath

$RuntimeDir = Split-Path $ConfigFile -Parent
$BinDir = Join-Path $RuntimeDir "bin"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# Daemon is content-addressed so upgrades swap binaries atomically.
$BrokerHash = (Get-FileHash -LiteralPath $Helixd -Algorithm SHA256).Hash.ToLowerInvariant()
$BrokerTag = $BrokerHash.Substring(0, 16)
$Broker = Join-Path $BinDir "helixd-$BrokerTag.exe"
if (-not (Test-Path -LiteralPath $Broker)) {
    Copy-Item -LiteralPath $Helixd -Destination $Broker -Force
}

$Entry = Join-Path $BinDir "helix-ssh-mcp.mjs"
Copy-Item -LiteralPath $Bundle -Destination $Entry -Force

if (-not (Test-Path -LiteralPath $ConfigFile)) {
    Copy-Item -LiteralPath $TemplateConfig -Destination $ConfigFile
    Write-Host "Created config: $ConfigFile"
} else {
    Write-Host "Keeping existing config: $ConfigFile"
}

$Config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
if (-not $Config.settings) {
    $Config | Add-Member -NotePropertyName settings -NotePropertyValue ([PSCustomObject]@{})
}

function Set-ConfigProperty($Object, [string]$Name, $Value) {
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.$Name = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

if ($DeploymentMode -eq "EnterpriseLocked") {
    Set-ConfigProperty $Config.settings "allowHostMutation" $false
    Set-ConfigProperty $Config.settings "allowPolicyMutation" $false
    Set-ConfigProperty $Config.settings "strictHostKeyChecking" $true
} else {
    Set-ConfigProperty $Config.settings "allowHostMutation" $true
    Set-ConfigProperty $Config.settings "allowPolicyMutation" $true
    Set-ConfigProperty $Config.settings "strictHostKeyChecking" $false
}
Set-ConfigProperty $Config.settings "credentialBrokerPath" $Broker

$Json = $Config | ConvertTo-Json -Depth 20
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigFile, $Json + [Environment]::NewLine, $Utf8NoBom)

$GuideFile = Join-Path $RuntimeDir "HELIX_AI_GUIDE.md"
Copy-Item -LiteralPath $GuideSource -Destination $GuideFile -Force

$SkillDir = Join-Path $RuntimeDir "skills\helix-remote-operations"
$SkillFile = Join-Path $SkillDir "SKILL.md"
New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
Copy-Item -LiteralPath $SkillSource -Destination $SkillFile -Force

$AdminFile = Join-Path $RuntimeDir "helix-admin.ps1"
Copy-Item -LiteralPath $AdminSource -Destination $AdminFile -Force

Write-Host ""
Write-Host "Helix beta installation completed."
Write-Host "MCP entry:  $Entry"
Write-Host "Daemon runtime: $Broker"
Write-Host "Config: $ConfigFile"
Write-Host "AI guide: $GuideFile"
Write-Host "Skill:    $SkillFile"
Write-Host "Admin:    $AdminFile"
Write-Host "Deployment mode: $DeploymentMode"
Write-Host ""

if ($RegisterClient -ne "None") {
    Write-Host "Registering MCP clients: $RegisterClient"
    try {
        & (Join-Path $PackageDir "register-mcp.ps1") `
            -Client $RegisterClient `
            -ClaudeScope $ClaudeScope `
            -ConfigPath $ConfigFile `
            -EntryPath $Entry `
            -BrokerPath $Broker `
            -GuidePath $GuideFile `
            -AdminScriptPath $AdminFile `
            -SkipIfUnavailable
    } catch {
        Write-Warning "Helix was installed, but MCP client registration failed: $($_.Exception.Message)"
    }
} else {
    Write-Host "MCP client configuration:"
    Write-Host ""
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
    Write-Host ""
    Write-Host "Or register automatically: .\install.ps1 -RegisterClient Auto"
}
