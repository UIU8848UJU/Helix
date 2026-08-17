[CmdletBinding()]
param(
    [ValidateSet("Auto", "Claude", "Codex", "All", "None")]
    [string]$RegisterClient = "Auto",

    [ValidateSet("user", "local", "project")]
    [string]$ClaudeScope = "user",

    [ValidateSet("Harness", "Personal", "EnterpriseLocked")]
    [string]$DeploymentMode = "Harness",

    # Path to a pre-built release broker binary (e.g. dist\helixd.exe).
    # When provided, the Rust toolchain is not required: cargo test/build are skipped
    # and the given binary is installed into the runtime bin directory as-is.
    [string]$BrokerBinary = ""
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigDir = if ($env:APPDATA) { Join-Path $env:APPDATA "Helix" } else { Join-Path $HOME ".config\helix" }
$ConfigFile = if ($env:HELIX_SSH_CONFIG) { $env:HELIX_SSH_CONFIG } else { Join-Path $ConfigDir "ssh-mcp.json" }
$BrowserConfigFile = if ($env:BROWSER_MCP_CONFIG) { $env:BROWSER_MCP_CONFIG } else { Join-Path $ConfigDir "browser-mcp.json" }

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

function Stop-HelixBrokerDaemon([string]$ExistingBrokerPath) {
    # Prefer the broker's lifecycle command when an installed daemon-aware binary is available.
    if ($ExistingBrokerPath -and (Test-Path -LiteralPath $ExistingBrokerPath)) {
        try {
            & $ExistingBrokerPath daemon-stop 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Stopped existing Helix credential broker daemon."
                Start-Sleep -Milliseconds 150
                return
            }
        } catch {
            # Fall through to the direct Named Pipe shutdown request.
        }
    }

    # This fallback does not depend on the location of the old executable.
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
            Write-Host "Requested shutdown of existing Helix credential broker daemon."
        } finally {
            $Pipe.Dispose()
        }
        Start-Sleep -Milliseconds 150
    } catch {
        # No running daemon, or a pre-daemon Helix version. Both are safe to continue from.
    }
}

Require-Command node
Require-Command npm
Require-Command ssh
Require-Command scp
if (-not $BrokerBinary) { Require-Command cargo }

$NodeMajor = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
if ($NodeMajor -lt 20) {
    throw "Node.js 20 or newer is required. Current version: $(& node --version)"
}

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

# A persistent Windows process can keep its EXE locked. Stop it before rebuilding the repo target.
Stop-HelixBrokerDaemon $ExistingBrokerPath

Push-Location $RootDir
try {
    # Native tools (npm/npx/cargo) write warnings to stderr. PowerShell 5.1 with
    # $ErrorActionPreference = "Stop" treats any stderr line as a terminating
    # error even when the tool exits 0, so relax EAP for native steps. Every
    # invocation below still checks $LASTEXITCODE.
    $OriginalErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    & npm run check
    if ($LASTEXITCODE -ne 0) { throw "TypeScript type check failed" }

    & npm test
    if ($LASTEXITCODE -ne 0) { throw "TypeScript tests failed" }

    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Warning "Playwright Chromium install failed; browser integration tests will be skipped" }

    if ($BrokerBinary) {
        if (-not (Test-Path -LiteralPath $BrokerBinary)) {
            throw "Pre-built broker binary was not found: $BrokerBinary"
        }
    } else {
        & cargo test --release --workspace
        if ($LASTEXITCODE -ne 0) { throw "Rust daemon tests failed" }

        & cargo build --release --workspace
        if ($LASTEXITCODE -ne 0) { throw "Rust daemon build failed" }
    }
} finally {
    $ErrorActionPreference = $OriginalErrorActionPreference
    Pop-Location
}

$BuiltBroker = if ($BrokerBinary) {
    (Resolve-Path -LiteralPath $BrokerBinary).Path
} else {
    Join-Path $RootDir "target\release\helixd.exe"
}
if (-not (Test-Path -LiteralPath $BuiltBroker)) {
    throw "Rust daemon was not found: $BuiltBroker"
}

$RuntimeDir = Split-Path $ConfigFile -Parent
$BinDir = Join-Path $RuntimeDir "bin"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# Run the daemon from a content-addressed runtime copy, not target/release. This keeps future builds
# from being blocked by a running Windows executable and lets upgrades switch binaries atomically.
$BrokerHash = (Get-FileHash -LiteralPath $BuiltBroker -Algorithm SHA256).Hash.ToLowerInvariant()
$BrokerTag = $BrokerHash.Substring(0, 16)
$Broker = Join-Path $BinDir "helixd-$BrokerTag.exe"
if (-not (Test-Path -LiteralPath $Broker)) {
    Copy-Item -LiteralPath $BuiltBroker -Destination $Broker -Force
}

if (-not (Test-Path -LiteralPath $ConfigFile)) {
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

if (-not (Test-Path -LiteralPath $BrowserConfigFile)) {
    Copy-Item (Join-Path $RootDir "examples\browser-mcp.config.json") $BrowserConfigFile
    Write-Host "Created browser config: $BrowserConfigFile"
} else {
    Write-Host "Keeping existing browser config: $BrowserConfigFile"
}

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
$BrowserEntry = Join-Path $RootDir "apps\browser-mcp\build\index.js"
Write-Host ""
Write-Host "Helix SSH MCP installation completed."
Write-Host "Entry:  $Entry"
Write-Host "Daemon runtime: $Broker"
Write-Host "Config: $ConfigFile"
Write-Host "AI guide: $GuideFile"
Write-Host "Skill:    $SkillFile"
Write-Host "Admin:    $AdminFile"
Write-Host "Browser entry: $BrowserEntry"
Write-Host "Browser config: $BrowserConfigFile"
Write-Host "Deployment mode: $DeploymentMode"
Write-Host "Host mutation: $($Config.settings.allowHostMutation)"
Write-Host "Policy mutation: $($Config.settings.allowPolicyMutation)"
Write-Host "Strict host-key checking: $($Config.settings.strictHostKeyChecking)"
Write-Host "Daemon: persistent daemon; Named Pipe + bounded task pool + SSH Session pool"
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
    },
    "helix-browser": {
      "command": "node",
      "args": ["$($BrowserEntry.Replace('\', '\\'))"],
      "env": {
        "BROWSER_MCP_CONFIG": "$($BrowserConfigFile.Replace('\', '\\'))"
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
            -BrowserEntryPath $BrowserEntry `
            -BrowserConfigPath $BrowserConfigFile `
            -SkipIfUnavailable
    } catch {
        Write-Warning "Helix was installed, but MCP client registration failed: $($_.Exception.Message)"
        Write-Host "Retry after fixing the client installation:"
        Write-Host ".\scripts\register-mcp.ps1 -Client $RegisterClient -ClaudeScope $ClaudeScope"
    }
}
