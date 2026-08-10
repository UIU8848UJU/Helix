# Helix SSH MCP 安装指南

本文说明如何安装 Helix SSH MCP（含 Rust Credential Broker 与 browser-mcp）。支持两种方式：

- **方式 A：源码全量安装** —— 需要 Node.js 20+、npm、ssh、scp，以及 Rust 工具链（cargo）。
- **方式 B：release 二进制安装（推荐）** —— 先把 Rust Broker 编译一次并保存为 release exe，之后安装无需 Rust 工具链，直接复用预编译二进制。

## 前置条件

- Node.js 20+：运行 MCP 服务端（两种方式都需要）
- npm：安装依赖（两种方式都需要）
- ssh / scp（OpenSSH 客户端）：SSH / SCP 传输（两种方式都需要）
- cargo（Rust 工具链）：编译 Credential Broker（仅方式 A 需要）
- PowerShell 5.1+（Windows）：安装脚本 / 凭据录入（两种方式都需要）

Linux/macOS 目标主机还需要：SSH 服务端（openssh-server），需要 sudo 时给本机用户相应权限。

## 方式 A：源码全量安装

Windows：

```powershell
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
.\scripts\install.ps1
```

Linux/macOS：

```bash
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
./scripts/install.sh
```

脚本依次执行：安装 npm 依赖 → 类型检查 → 单元测试 → 构建 TS → 编译 Rust Broker（仅 Windows 脚本）→ 生成配置与 AI 指南 → 输出 MCP 客户端 JSON，并按需注册到 Claude/Codex（`register-mcp.ps1`）。

> 注：`install.sh`（Linux/macOS）使用系统 ssh/scp 的 openssh 认证路径，不编译 Broker；Broker（密码凭据 / SFTP）仅在认证类型为 `windows-credential` 的主机上使用，目前面向 Windows 本机。

## 方式 B：使用预编译 release 二进制（推荐）

### 1) 首次构建并保存 release exe

在有 Rust 工具链的机器上执行一次：

```powershell
.\scripts\build-broker-release.ps1
```

产物保存在 `dist\helix-credential-broker.exe`（`dist/` 已加入 `.gitignore`，不会提交到仓库），并打印 SHA-256 便于校验。可把该 exe 拷贝/分发到目标机器。

### 2) 用预编译二进制安装（无需 cargo）

```powershell
.\scripts\install.ps1 -BrokerBinary .\dist\helix-credential-broker.exe
```

安装脚本会跳过 `cargo test` / `cargo build`，把给定 exe 按 SHA-256 内容寻址复制到运行时目录 `%APPDATA%\Helix\bin\helix-credential-broker-<sha16>.exe`，并写入 `ssh-mcp.json` 的 `settings.credentialBrokerPath`。

## 安装产物

| 产物 | 默认位置 |
| --- | --- |
| MCP 服务端入口 | `apps/ssh-mcp/build/index.js` |
| SSH 配置 | `%APPDATA%\Helix\ssh-mcp.json`（Windows）/ `~/.config/helix/ssh-mcp.json`（Linux/macOS） |
| Credential Broker | `%APPDATA%\Helix\bin\helix-credential-broker-<sha16>.exe` |
| AI 操作指南 | `%APPDATA%\Helix\HELIX_AI_GUIDE.md` |
| 运维 Skill | `%APPDATA%\Helix\skills\helix-remote-operations\SKILL.md` |
| 凭据管理脚本 | `%APPDATA%\Helix\helix-admin.ps1` |
| 浏览器 MCP 配置 | `%APPDATA%\Helix\browser-mcp.json` |

## MCP 客户端注册

安装脚本末尾会输出 `mcpServers` JSON（`helix-ssh` + `helix-browser`），也可用 `register-mcp.ps1` 自动注册：

```powershell
.\scripts\register-mcp.ps1 -Client Auto
```

卸载：`unregister-mcp.ps1 -IncludeBrowser`。

## 平台支持矩阵

| 方向 | 认证 | 命令执行 | 文件传输 |
| --- | --- | --- | --- |
| Windows → Linux | openssh（密钥）/ windows-credential（密码，经 Broker） | ✅ | ✅ SCP / SFTP |
| Linux/macOS → Linux | openssh（密钥 / Agent） | ✅ | ✅ SCP |
| Windows → Windows | windows-credential（密码，经 Broker SFTP） | ✅（PowerShell） | ✅ SFTP |

**win→win 命令执行已支持（PowerShell）。** 对 `os: windows` 的主机，`ssh_exec` / `ssh_check` / `environment_probe` 会生成 PowerShell 脚本，并用 `-EncodedCommand`（UTF-16LE Base64）整体传参，避免命令行引号转义问题：脚本以 UTF-8 输出、`Set-Location -LiteralPath` 切换 cwd、`$env:` 注入环境变量、支持 `.` 点源 PowerShell 脚本，并按 `$LASTEXITCODE` / `$?` 返回退出码。`sudo_exec` 在 Windows 主机上暂不支持；`job_*` / `docker_*` / `compose_*` 仍生成 POSIX sh 脚本，仅适用于 unix 主机。win→win 的文件传输走 Broker 的 libssh2 SFTP，只要远端 Windows OpenSSH Server 启用 SFTP 子系统（默认开启）即可工作。

## 大文件传输

- **没有文件大小上限**：`ssh_upload` / `ssh_download` 使用 `scp`（openssh 认证）或 Broker SFTP（windows-credential 认证）流式拷贝；`maxOutputBytes` 只限制命令 stdout/stderr 的抓取，不影响传输字节。
- **超时**：默认 `defaultTimeoutSeconds = 60s`，大文件或慢网络建议显式传 `timeoutSeconds`（上限 3600）。超时会中断传输，目前没有断点续传和校验和验证。
- **目录**：`recursive=true` 支持整个目录。

## 升级与常见问题

- 升级：重新运行安装脚本即可；脚本保留已有 `ssh-mcp.json`，并以内容寻址文件名原子替换 Broker 二进制，运行中的旧 exe 不会被破坏。
- Windows 远端执行走 PowerShell（`-EncodedCommand`），`printf` 等 POSIX 命令不可用 → 见平台支持矩阵。
- 卸载后清理：`unregister-mcp.ps1` 移除注册，`helix-admin.ps1` 可删除本机存储的凭据。
