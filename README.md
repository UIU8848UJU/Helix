# Helix

Helix 是面向 AI Agent 的远程操作基础设施。当前模块提供 SSH MCP、Rust Windows Credential Broker、主机管理、文件传输、Docker/Compose、环境探测和直接 sudo。

## 设计目标

Helix 默认运行在 **Harness 模式**：优先保证 AI 可以连续完成远程编译、调试、部署和环境维护，不使用会频繁打断工作流的权限审批链。

默认行为：

```text
allowHostMutation=true
allowPolicyMutation=true
strictHostKeyChecking=false
allowedRemotePaths=["/"]
sudo_exec 直接执行
无 sudo allowlist
无 sudo_request / APPROVE / sudo_execute
无审批 token 和过期时间
```

正常 SSH、sudo、文件传输和配置修改不再被安全流程阻断。只保留一个轻量的危险命令 guard，用于防止明显误操作。

`EnterpriseLocked` 模式仍会关闭主机/策略写入并恢复严格 host-key 校验。

## 目录结构

```text
apps/ssh-mcp/                 TypeScript MCP 控制层
apps/credential-broker/       Rust Windows 凭据与密码 SSH 执行器
docs/guides/                  AI 与人工操作指南
skills/                       Helix 远程操作 Skill
examples/                     配置示例
scripts/                      安装、注册、管理和卸载脚本
```

## 主要能力

- `host_list` / `host_get`：查询主机配置；
- `host_onboard`：一站式新增主机；
- `host_update`：修改连接、路径和认证配置；
- `host_offboard`：删除主机配置；
- `credential_status`：检查凭据是否存在；
- `credential_enroll_launch`：由 MCP 直接弹出本地 PowerShell 密码窗口；
- `credential_enroll_request`：无桌面环境的命令行备用方案；
- `ssh_check` / `ssh_exec`：连接检查和普通命令；
- `sudo_exec`：直接 sudo；
- `ssh_upload` / `ssh_download`：文件传输；
- `docker_list` / `docker_exec`；
- `compose_ps` / `compose_exec`；
- `environment_probe`：探测 OS、架构、工具链、容器和环境脚本；
- JSONL 审计、超时、输出上限和并发控制。

## Windows 一站式凭据录入

`host_onboard` 使用 Windows 密码认证时会自动生成：

```text
Helix/ssh/<alias>/login
Helix/ssh/<alias>/sudo
```

随后 MCP 自动启动一个独立的本地 PowerShell 窗口。用户只需在窗口中输入密码，不需要把命令复制到终端，也不需要把密码提供给 AI。

默认一次输入同时保存 login 和 sudo 密码。两者不同时设置：

```json
{
  "separatePasswords": true
}
```

窗口未出现时可重新调用：

```text
credential_enroll_launch
```

## 直接 sudo

需要 root 权限时直接调用：

```json
{
  "host": "ubuntu22-developer",
  "command": "systemctl restart nginx"
}
```

对应工具：

```text
sudo_exec
```

密码认证主机由 Rust Broker 从 Windows Credential Manager 读取 sudo 密码；密码不进入 MCP、聊天、JSON、命令行参数、环境变量或日志。

OpenSSH 主机使用 `sudo -n`。

## 危险命令 guard

Guard 会在 `ssh_exec`、`sudo_exec`、`docker_exec` 和 `compose_exec` 的用户命令执行前拦截明显危险的操作，包括：

- `rm`；
- `find -delete`；
- `shred`、`wipefs`；
- `mkfs`、`fdisk`、`sfdisk`、`cfdisk`、`parted`；
- `dd ... of=/dev/...`；
- 重定向写入块设备；
- `shutdown`、`poweroff`、`halt`、`reboot`；
- systemd 电源控制；
- 终止 PID 1；
- fork bomb。

这是防误操作措施，不是完整 shell 沙箱。

## 文件传输默认范围

远端主机默认：

```text
allowedRemotePaths=["/"]
```

本地未设置 `HELIX_LOCAL_PATH_ROOTS` 时：

- Linux/macOS 默认允许本地根目录；
- Windows 默认允许 MCP 当前目录所在盘、用户目录所在盘和临时目录所在盘。

需要更窄范围时，可以显式设置 `HELIX_LOCAL_PATH_ROOTS` 或使用 `EnterpriseLocked` 部署配置。

## 安装

### Windows PowerShell

```powershell
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
.\scripts\install.ps1 -RegisterClient Claude
```

默认 `DeploymentMode=Harness`。重新执行安装脚本会把旧配置迁移为：

```text
allowHostMutation=true
allowPolicyMutation=true
strictHostKeyChecking=false
每台已有主机 allowedRemotePaths=["/"]
```

也可选择：

```powershell
# Claude Code
.\scripts\install.ps1 -RegisterClient Claude

# Codex
.\scripts\install.ps1 -RegisterClient Codex

# 自动检测 Claude/Codex
.\scripts\install.ps1 -RegisterClient Auto

# 集中锁定模式
.\scripts\install.ps1 `
  -DeploymentMode EnterpriseLocked `
  -RegisterClient Claude
```

安装依赖：

- Node.js 20+
- npm
- OpenSSH Client
- Rust 1.85+
- Windows 首次编译 vendored OpenSSL 时需要 Perl

### Linux/macOS

```bash
bash scripts/install.sh
```

可用环境变量：

```bash
HELIX_DEPLOYMENT_MODE=EnterpriseLocked bash scripts/install.sh
```

## 标准 AI 流程

```text
host_list
  → host_get
  → credential_status
  → credential_enroll_launch（凭据缺失时）
  → ssh_check
  → environment_probe
  → ssh_exec / sudo_exec / Docker / Compose / 传输
```

## 开发验证

```bash
npm install
npm run check
npm test
npm run build
cargo test --release --manifest-path apps/credential-broker/Cargo.toml
cargo build --release --manifest-path apps/credential-broker/Cargo.toml
```

完整 AI 操作说明：

- `docs/guides/HELIX_AI_GUIDE.md`
- `skills/helix-remote-operations/SKILL.md`
