# Helix

Helix 是面向 AI Agent 的基础设施（AI Infra）仓库。首个模块是受控的 SSH MCP，用于主机管理、远程命令、文件传输、sudo、Docker/Compose 和环境探测。

## 当前结构

```text
apps/ssh-mcp/                 TypeScript MCP 控制层
apps/credential-broker/       Rust Windows 凭据与密码 SSH 执行器
docs/architecture/            技术设计
examples/                      配置示例
scripts/                       安装、注册和卸载脚本
```

网页抓取和浏览器自动化不会与 SSH MCP 放在同一个进程中。后续 Web Research MCP 将独立部署，避免不可信网页内容直接获得远程执行权限。

## 功能

- 主机配置：列出、读取、添加、修改、删除
- 两种认证后端：系统 OpenSSH/SSH Agent，或 Windows Credential Manager 密码认证
- SSH 连通性检查与普通命令执行，支持 cwd、环境变量和 source 脚本
- SCP 或 SFTP 上传、下载文件/目录
- `credential_status` 只检查凭据是否存在，不返回秘密
- 两阶段 sudo：`sudo_request` 本地人工审核，`sudo_execute` 一次性执行
- `reviewed-nopasswd` 与 `reviewed-password` 两种 sudo 模式
- Docker 容器列表、容器内执行、Docker Compose 执行
- OS、架构、工具链、容器和环境脚本探测
- 超时、输出上限、并发控制和 JSONL 审计
- Claude Code / Codex CLI 自动注册与安全注销

## 安装

### Linux/macOS

```bash
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
bash scripts/install.sh
```

Linux/macOS 当前使用 OpenSSH/SSH Agent 后端。

### Windows PowerShell

```powershell
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
.\scripts\install.ps1
```

安装脚本默认使用 `-RegisterClient Auto`：检测到 `claude` 或 `codex` CLI 后，自动通过它们的官方 MCP 子命令注册 `helix-ssh`。Claude Code 默认使用用户级 scope，Codex 使用用户级 `config.toml`。

也可以显式选择：

```powershell
# 只注册 Claude Code
.\scripts\install.ps1 -RegisterClient Claude -ClaudeScope user

# 只注册 Codex
.\scripts\install.ps1 -RegisterClient Codex

# 两者都必须存在并注册
.\scripts\install.ps1 -RegisterClient All

# 只安装，不修改任何客户端配置
.\scripts\install.ps1 -RegisterClient None
```

开发构建要求：

- Node.js 20+
- npm
- OpenSSH Client（密钥后端）
- Rust 1.85+（构建 Credential Broker）

内网正式运行只需要编译后的 JavaScript、Node.js、Broker EXE，以及所选后端需要的系统组件；不要求安装 TypeScript 或 Rust。

默认配置：

- Linux/macOS：`~/.config/helix/ssh-mcp.json`
- Windows：`%APPDATA%\Helix\ssh-mcp.json`

可使用 `HELIX_SSH_CONFIG`、`HELIX_CREDENTIAL_BROKER` 覆盖路径。

## MCP 客户端注册

安装完成后可以单独注册：

```powershell
# 自动注册所有检测到的客户端
.\scripts\register-mcp.ps1 -Client Auto

# Claude Code：user / local / project
.\scripts\register-mcp.ps1 -Client Claude -ClaudeScope user

# Codex 用户级配置
.\scripts\register-mcp.ps1 -Client Codex
```

脚本执行前会备份现有配置文件，然后删除同名旧条目并重新注册，因此可重复执行。注册完成后重启 Claude Code 或 Codex，通过 `/mcp` 或 MCP 列表检查连接。

注销：

```powershell
.\scripts\unregister-mcp.ps1 -Client Auto
.\scripts\unregister-mcp.ps1 -Client Claude -ClaudeScope user
.\scripts\unregister-mcp.ps1 -Client Codex
```

Claude Code 的 `project` scope 会修改当前目录的 `.mcp.json`；`local` 和 `user` scope 由 Claude Code CLI 管理在用户配置中。Codex 当前通过官方 CLI 注册到用户级配置。

## Windows 密码凭据

Broker 不提供读取明文密码的接口。密码通过隐藏终端输入写入 Windows Credential Manager：

```powershell
$Broker = ".\apps\credential-broker\target\release\helix-credential-broker.exe"

& $Broker credential-store `
  --target "Helix/ssh/build-password/login" `
  --username "developer"

& $Broker credential-store `
  --target "Helix/ssh/build-password/sudo" `
  --username "developer"
```

配置文件只保存：

```json
{
  "auth": {
    "type": "windows-credential",
    "credentialRef": "Helix/ssh/build-password/login"
  }
}
```

## sudo 人工审核

1. AI 调用 `sudo_request`，Helix 校验主机级锚定正则 allowlist。
2. 工具返回一个本地 `approvalCommand`。
3. 用户在独立终端运行该命令，核对主机、完整命令和理由，输入大写 `APPROVE`。
4. AI 调用 `sudo_execute`。
5. 一次性批准 token 与主机和完整命令哈希绑定，消费后立即删除。

密码 sudo 的密码只由 Rust Broker 从 Credential Manager 读取并写入 SSH Channel stdin，不进入 MCP、命令行参数、环境变量或日志。

## 开发

```bash
npm install
npm run check
npm test
npm run build
cargo test --manifest-path apps/credential-broker/Cargo.toml
cargo build --release --manifest-path apps/credential-broker/Cargo.toml
```

启动 MCP Server：

```bash
node apps/ssh-mcp/build/index.js
```

## MCP 客户端手工配置

自动注册不可用时，可以手工使用：

```json
{
  "mcpServers": {
    "helix-ssh": {
      "command": "node",
      "args": ["/absolute/path/to/Helix/apps/ssh-mcp/build/index.js"],
      "env": {
        "HELIX_SSH_CONFIG": "/absolute/path/to/ssh-mcp.json",
        "HELIX_CREDENTIAL_BROKER": "C:\\Tools\\Helix\\helix-credential-broker.exe"
      }
    }
  }
}
```

## 主机配置写操作

`host_add`、`host_update`、`host_remove` 默认关闭。管理员可设置：

```bash
export HELIX_ALLOW_HOST_MUTATION=1
```

或在配置中设置 `settings.allowHostMutation=true`。

完整设计见：

- [SSH MCP v1 技术设计](docs/architecture/ssh-mcp-v1.md)
- [Windows Credential Broker](docs/architecture/windows-credential-broker.md)
