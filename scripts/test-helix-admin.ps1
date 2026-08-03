$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ScriptPath = Join-Path $RootDir "scripts\helix-admin.ps1"
$Tokens = $null
$ParseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $ScriptPath,
    [ref]$Tokens,
    [ref]$ParseErrors
)
if ($ParseErrors.Count -gt 0) {
    throw "helix-admin.ps1 parse failed: $($ParseErrors | Out-String)"
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("helix-admin-test-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
    $Broker = Join-Path $TempRoot "fake-broker.cmd"
    $ConfigPath = Join-Path $TempRoot "ssh-mcp.json"

    @'
@echo off
if "%1"=="credential-exists" echo true
exit /b 0
'@ | Set-Content -LiteralPath $Broker -Encoding ascii

    $Config = [ordered]@{
        version = 1
        settings = [ordered]@{
            credentialBrokerPath = $Broker
        }
        hosts = [ordered]@{
            test = [ordered]@{
                hostname = "127.0.0.1"
                port = 22
                username = "developer"
                allowedRemotePaths = @("/tmp/helix")
                auth = [ordered]@{
                    type = "windows-credential"
                    credentialRef = "Helix/ssh/test/login"
                }
                sudo = [ordered]@{
                    mode = "reviewed-password"
                    credentialRef = "Helix/ssh/test/sudo"
                    allow = @()
                    approvalTtlSeconds = 300
                }
            }
        }
    }
    $Config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ConfigPath -Encoding utf8

    $HostJson = & $ScriptPath host get -Host test -ConfigPath $ConfigPath | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $HostJson.Contains('"username":  "developer"')) {
        throw "Host query smoke test failed: $HostJson"
    }

    $StatusJson = & $ScriptPath credential status -Host test -Kind all -ConfigPath $ConfigPath | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $StatusJson.Contains('"exists":  true')) {
        throw "Credential status smoke test failed: $StatusJson"
    }

    Write-Host "Helix admin script smoke test passed."
} finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
