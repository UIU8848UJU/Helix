$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigDir = if ($env:APPDATA) { Join-Path $env:APPDATA "Helix" } else { Join-Path $HOME ".config\helix" }
$ConfigFile = if ($env:HELIX_SSH_CONFIG) { $env:HELIX_SSH_CONFIG } else { Join-Path $ConfigDir "ssh-mcp.json" }

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "缺少依赖: $Name"
    }
}

Require-Command node
Require-Command npm
Require-Command ssh
Require-Command scp

$NodeMajor = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
if ($NodeMajor -lt 20) {
    throw "需要 Node.js 20+，当前版本: $(& node --version)"
}

Push-Location $RootDir
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }

    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build 失败" }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path (Split-Path $ConfigFile -Parent) | Out-Null
if (-not (Test-Path $ConfigFile)) {
    Copy-Item (Join-Path $RootDir "examples\ssh-mcp.config.json") $ConfigFile
    Write-Host "已创建配置: $ConfigFile"
} else {
    Write-Host "保留现有配置: $ConfigFile"
}

$Entry = Join-Path $RootDir "apps\ssh-mcp\build\index.js"
Write-Host ""
Write-Host "Helix SSH MCP 安装完成。"
Write-Host "入口: $Entry"
Write-Host "配置: $ConfigFile"
Write-Host ""
Write-Host "MCP 客户端配置片段:"
@"
{
  "mcpServers": {
    "helix-ssh": {
      "command": "node",
      "args": ["$($Entry.Replace('\', '\\'))"],
      "env": {
        "HELIX_SSH_CONFIG": "$($ConfigFile.Replace('\', '\\'))"
      }
    }
  }
}
"@ | Write-Host
