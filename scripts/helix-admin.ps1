[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet("credential", "host")]
    [string]$Resource,

    [Parameter(Position = 1, Mandatory = $true)]
    [ValidateSet("set", "status", "delete", "list", "get")]
    [string]$Action,

    [Alias("Host")]
    [string]$HostAlias,

    [ValidateSet("all", "login", "sudo")]
    [string]$Kind = "all",

    [string[]]$CredentialRef,
    [string]$Username,
    [string]$ConfigPath,
    [switch]$SeparatePasswords
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$PathValue) {
    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $null
    }
    return [System.IO.Path]::GetFullPath($PathValue)
}

if (-not $ConfigPath) {
    if ($env:HELIX_SSH_CONFIG) {
        $ConfigPath = $env:HELIX_SSH_CONFIG
    } else {
        $Base = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME ".config" }
        $ConfigPath = Join-Path $Base "Helix\ssh-mcp.json"
    }
}
$ConfigPath = Resolve-FullPath $ConfigPath

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Helix config was not found: $ConfigPath"
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

function Get-HostConfig([string]$Alias) {
    if ([string]::IsNullOrWhiteSpace($Alias)) {
        throw "-Host is required"
    }
    $Property = $Config.hosts.PSObject.Properties[$Alias]
    if (-not $Property) {
        throw "Unknown host alias: $Alias"
    }
    return $Property.Value
}

function Get-BrokerPath {
    $Candidate = if ($env:HELIX_CREDENTIAL_BROKER) {
        $env:HELIX_CREDENTIAL_BROKER
    } elseif ($Config.settings.credentialBrokerPath) {
        $Config.settings.credentialBrokerPath
    } else {
        $null
    }
    if (-not $Candidate) {
        throw "Credential Broker path is not configured"
    }
    $Resolved = Resolve-FullPath $Candidate
    if (-not (Test-Path -LiteralPath $Resolved)) {
        throw "Credential Broker was not found: $Resolved"
    }
    return $Resolved
}

function Resolve-CredentialTargets {
    if ($CredentialRef -and $CredentialRef.Count -gt 0) {
        return @($CredentialRef | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    }

    $HostConfig = Get-HostConfig $HostAlias
    $Targets = @()
    if (($Kind -eq "all" -or $Kind -eq "login") -and $HostConfig.auth.type -eq "windows-credential") {
        $Targets += [PSCustomObject]@{ Kind = "login"; Ref = [string]$HostConfig.auth.credentialRef }
    }
    if (($Kind -eq "all" -or $Kind -eq "sudo") -and $HostConfig.sudo.credentialRef) {
        $Targets += [PSCustomObject]@{ Kind = "sudo"; Ref = [string]$HostConfig.sudo.credentialRef }
    }
    if ($Targets.Count -eq 0) {
        throw "No managed credentials matched host=$HostAlias kind=$Kind"
    }
    return $Targets
}

if ($Resource -eq "host") {
    switch ($Action) {
        "list" {
            $Config.hosts | ConvertTo-Json -Depth 20
            exit 0
        }
        "get" {
            (Get-HostConfig $HostAlias) | ConvertTo-Json -Depth 20
            exit 0
        }
        default {
            throw "Host action '$Action' is not supported by this local script. Use Helix MCP host_onboard, host_update, or host_offboard."
        }
    }
}

if ($Resource -ne "credential") {
    throw "Unsupported resource: $Resource"
}

$Broker = Get-BrokerPath
$ResolvedTargets = Resolve-CredentialTargets
$TargetObjects = @()
foreach ($Item in $ResolvedTargets) {
    if ($Item -is [string]) {
        $TargetObjects += [PSCustomObject]@{ Kind = "explicit"; Ref = [string]$Item }
    } else {
        $TargetObjects += $Item
    }
}

switch ($Action) {
    "set" {
        $ResolvedUsername = $Username
        if (-not $ResolvedUsername) {
            $HostConfig = Get-HostConfig $HostAlias
            $ResolvedUsername = [string]$HostConfig.username
        }
        if ([string]::IsNullOrWhiteSpace($ResolvedUsername)) {
            throw "A username is required for credential enrollment"
        }

        if ($SeparatePasswords) {
            foreach ($Target in $TargetObjects) {
                Write-Host "Enter password for $($Target.Kind): $($Target.Ref)"
                & $Broker credential-store --target $Target.Ref --username $ResolvedUsername
                if ($LASTEXITCODE -ne 0) {
                    throw "Credential enrollment failed for $($Target.Ref)"
                }
            }
        } else {
            $Arguments = @("credential-enroll", "--username", $ResolvedUsername)
            foreach ($Target in $TargetObjects) {
                $Arguments += @("--target", $Target.Ref)
            }
            Write-Host "Enter one password for $($TargetObjects.Count) selected credential target(s)."
            & $Broker @Arguments
            if ($LASTEXITCODE -ne 0) {
                throw "Credential enrollment failed"
            }
        }
        Write-Host "Credential enrollment completed."
    }
    "status" {
        $Result = @()
        foreach ($Target in $TargetObjects) {
            $ExistsText = (& $Broker credential-exists --target $Target.Ref | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                throw "Credential status failed for $($Target.Ref)"
            }
            $Result += [PSCustomObject]@{
                kind = $Target.Kind
                credentialRef = $Target.Ref
                exists = ($ExistsText -eq "true")
            }
        }
        $Result | ConvertTo-Json -Depth 5
    }
    "delete" {
        foreach ($Target in $TargetObjects) {
            & $Broker credential-delete --target $Target.Ref
            if ($LASTEXITCODE -ne 0) {
                throw "Credential deletion failed for $($Target.Ref)"
            }
            Write-Host "Deleted credential: $($Target.Ref)"
        }
    }
    default {
        throw "Credential action '$Action' is not supported"
    }
}
