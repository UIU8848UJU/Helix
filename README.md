# Helix

Helix 是面向 AI Agent 的基础设施（AI Infra）仓库。首个模块是受控的 SSH MCP，用于主机管理、远程命令、文件传输、sudo、Docker/Compose 和环境探测。

## 当前结构

```text
apps/ssh-mcp/                 TypeScript MCP 控制层
apps/credential-broker/       Rust Windows 凭据与密码 SSH 执行器
docs/architecture/            技术设计
docs/guides/                  人工与 AI 操作指南
skills/                       Helix 复杂工作流 Skill
examples/                     配置示例
scripts/                      安装、注册、管理和卸载脚本
```

网页抓取和浏览器自动化不会与 SSH MCP 放在同一个进程中。后续 Web Research MCP 将独立部署，避免不可信网页内容直接获得远程执行权限。

## 功能

- 主机配置：列出、读取、添加、修改、删除
- 高层主机管理：`host_onboard` 自动生成凭据引用，`host_offboard` 安全下线并保留凭据恢复能力
- 可用性优先的双层变更权限：正常主机生命周期默认开启，真正的安全策略扩权默认关闭
- `mutation_capabilities` 明确告诉 AI 当前允许的生命周期操作和受保护的策略操作
- 两种认证后端：系统 OpenSSH/SSH Agent，或 Windows Credential Manager 密码认证
- 凭据录入请求：AI 只生成本地命令，密码通过本地隐藏终端输入
- 默认一次密码输入同时写入 login/sudo 两个凭据目标；不同密码可显式分开录入
- SSH 连通性检查与普通命令执行，支持 cwd、环境变量和 source 脚本
- SCP 或 SFTP 上传、下载文件/目录
- `credential_status` 只检查凭据是否存在，不返回秘密
- `credential_delete_request` 只生成本地清理命令，不通过 MCP 直接删除秘密
- 两阶段 sudo：`sudo_request` 本地人工审核，`sudo_execute` 一次性执行
- `reviewed-nopasswd` 与 `reviewed-password` 两种 sudo 模式
- Docker 容器列表、容器内执行、Docker Compose 执行
- OS、架构、工具链、容器和环境脚本探测
- MCP 初始化 instructions、强化工具描述和 `helix_help` 自描述工具
- 本地 `HELIX_AI_GUIDE.md` 与 `helix-remote-operations` Skill
- 超时、输出上限、并发控制和 JSONL 审计
- Claude Code / Codex CLI 自动注册与安全注销

## 可用性优先的安全分级

Helix 不把所有配置写操作都视为同一风险级别。

### 主机生命周期层：个人模式默认开启

以下操作在用户明确要求后可以直接执行，不需要先修改 JSON：

- `host_onboard` / `host_offboard`
- 修改 hostname、port、username、identityFile、proxyJump 和 tags
- 使用标准的 `Helix/ssh/<alias>/login` 与 `Helix/ssh/<alias>/sudo` 凭据引用
- 使用用户目录、`/workspace`、`/tmp/helix`、`/opt/ros` 等生命周期安全路径
- 生成本地凭据录入、状态检查和删除请求

### 安全策略层：默认关闭

只有以下真正扩大权限或削弱保护的变更才需要 `allowPolicyMutation=true`：

- 增加生命周期安全范围以外的远端根目录
- 新增 sudo allowlist 规则
- 替换已有主机的认证方式或凭据引用
- 延长 sudo 审批有效时间
- 关闭严格主机密钥校验或审计

所有 MCP 配置写入都会经过同一套中央策略比较，不能通过换一个工具绕过分级。

## AI 操作引导的四层结构

Helix 不依赖 AI 自己猜测工具流程，而是提供四层一致的引导：

1. **MCP instructions 与工具描述**：客户端连接时获得跨工具约束；正常主机生命周期应直接走工具，策略扩权才请求第二层授权。
2. **`helix_help`**：AI 可按 `overview`、`connect`、`exec`、`sudo`、`transfer`、`docker`、`configuration`、`troubleshooting` 查询权威流程。
3. **本地指南**：安装时复制到 `%APPDATA%\Helix\HELIX_AI_GUIDE.md` 或 `~/.config/helix/HELIX_AI_GUIDE.md`，供人工阅读、离线检查和审计。
4. **Skill**：`skills/helix-remote-operations/SKILL.md` 编排环境探测、文件传输、Docker、source、编译、诊断和 reviewed sudo 等复杂任务。

核心规则：

- 正常操作和排障时不得自动修改 `ssh-mcp.json`；
- alias、hostname、username 是三个不同字段；
- 不得要求或泄露明文密码；
- `ssh_exec`、`docker_exec`、`compose_exec` 不得嵌入 sudo；
- `sudo_request` 返回后必须展示 `approvalCommand` 并停止；
- 只有用户明确确认本地审批完成后，才能用完全相同的 host、requestId、command 调用 `sudo_execute`；
- AI 不得把普通主机生命周期操作误报成高风险策略变更；
- allowlist 或路径策略拒绝时只报告准确边界，不得通过改写命令绕过。

## 安装

### Linux/macOS

```bash
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
bash scripts/install.sh
```

Linux/macOS 当前使用 OpenSSH/SSH Agent 后端。默认使用 `Personal` 部署模式；企业锁定模式可设置：

```bash
HELIX_DEPLOYMENT_MODE=EnterpriseLocked bash scripts/install.sh
```

### Windows PowerShell

```powershell
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
.\scripts\install.ps1
```

安装脚本默认使用：

```text
DeploymentMode = Personal
allowHostMutation = true
allowPolicyMutation = false
RegisterClient = Auto
```

因此个人开发机重装后，添加、删除和修正主机连接信息会直接可用，旧配置中的 `allowHostMutation:false` 也会迁移为可用状态；安全策略扩权仍保持关闭。

企业锁定部署：

```powershell
.\scripts\install.ps1 `
  -DeploymentMode EnterpriseLocked `
  -RegisterClient Claude
```

该模式会把两个变更层都关闭，等待本地管理员显式开放。

也可以显式选择客户端：

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
- Windows vendored OpenSSL 首次编译需要 Perl

内网正式运行只需要编译后的 JavaScript、Node.js、Broker EXE，以及所选后端需要的系统组件；不要求安装 TypeScript、Rust 或 Perl。

默认配置：

- Linux/macOS：`~/.config/helix/ssh-mcp.json`
- Windows：`%APPDATA%\Helix\ssh-mcp.json`

Windows 本地引导和管理文件默认安装在配置同级目录：

```text
HELIX_AI_GUIDE.md
helix-admin.ps1
skills/helix-remote-operations/SKILL.md
```

可使用 `HELIX_SSH_CONFIG`、`HELIX_CREDENTIAL_BROKER`、`HELIX_AI_GUIDE`、`HELIX_ADMIN_SCRIPT` 覆盖路径。

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

脚本执行前会备份现有配置文件，然后删除同名旧条目并重新注册，因此可重复执行。注册时会同时传入 `HELIX_AI_GUIDE` 和 `HELIX_ADMIN_SCRIPT`。注册完成后重启 Claude Code 或 Codex，通过 `/mcp` 或 MCP 列表检查连接。

注销：

```powershell
.\scripts\unregister-mcp.ps1 -Client Auto
.\scripts\unregister-mcp.ps1 -Client Claude -ClaudeScope user
.\scripts\unregister-mcp.ps1 -Client Codex
```

Claude Code 的 `project` scope 会修改当前目录的 `.mcp.json`；`local` 和 `user` scope 由 Claude Code CLI 管理在用户配置中。Codex 当前通过官方 CLI 注册到用户级配置。

## 主机管理与凭据录入

查询主机和变更层状态：

```text
host_list
host_get
mutation_capabilities
```

新增主机时使用 `host_onboard`：

```json
{
  "alias": "jetson-dev",
  "hostname": "192.168.0.110",
  "username": "jetson_developer",
  "authType": "windows-credential",
  "sudoMode": "reviewed-password"
}
```

Helix 自动生成：

```text
Helix/ssh/jetson-dev/login
Helix/ssh/jetson-dev/sudo
```

并默认配置以下实用路径：

```text
/home/jetson_developer
/workspace
/tmp/helix
/opt/ros
```

随后 AI 调用 `credential_enroll_request`。工具只返回本地 `enrollmentCommand`，AI 必须展示命令并停止。用户在本地终端执行后，Broker 通过隐藏输入读取密码。

本地手工方式：

```powershell
# 默认只输入一次密码，同时写入 login 和 sudo
& "$env:APPDATA\Helix\helix-admin.ps1" credential set `
  -Host "jetson-dev" `
  -Kind all

# 登录密码和 sudo 密码不同时分别输入
& "$env:APPDATA\Helix\helix-admin.ps1" credential set `
  -Host "jetson-dev" `
  -Kind all `
  -SeparatePasswords

# 检查凭据是否存在，不读取秘密
& "$env:APPDATA\Helix\helix-admin.ps1" credential status `
  -Host "jetson-dev"
```

录入完成后执行：

```text
credential_status
  → ssh_check
```

下线主机使用 `host_offboard`。它只删除非敏感主机配置，并返回孤立凭据引用及本地 `cleanupCommand`；凭据不会自动删除。

完整说明见：[主机与凭据管理](docs/guides/host-credential-administration.md)。

## 临时开放策略层

只有确实需要扩大路径、增加 sudo 规则或替换凭据策略时才开放：

```powershell
$env:HELIX_ALLOW_POLICY_MUTATION = "1"
```

或者在配置中设置：

```json
{
  "settings": {
    "allowHostMutation": true,
    "allowPolicyMutation": true
  }
}
```

完成策略调整后应恢复为 `false`。企业锁定环境还可使用 `HELIX_ALLOW_HOST_MUTATION=0` 强制关闭生命周期写操作。

## Windows 密码凭据边界

Broker 不提供读取明文密码的接口。配置文件只保存凭据引用：

```json
{
  "auth": {
    "type": "windows-credential",
    "credentialRef": "Helix/ssh/jetson-dev/login"
  }
}
```

密码只由本地 Broker 隐藏读取并写入 Windows Credential Manager，不进入 MCP、聊天、命令行参数、环境变量或日志。

## sudo 人工审核

1. AI 调用 `sudo_request`，Helix 校验主机级锚定正则 allowlist。
2. 工具返回一个本地 `approvalCommand`。
3. AI 必须把审批命令和完整 sudo 命令展示给用户，然后停止。
4. 用户在独立终端运行该命令，核对主机、完整命令和理由，输入大写 `APPROVE`。
5. 用户明确确认已经审批后，AI 才调用 `sudo_execute`。
6. 一次性批准 token 与主机和完整命令哈希绑定，消费后立即删除。

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

AI 不确定操作流程时应调用：

```text
helix_help({ "topic": "configuration" })
mutation_capabilities()
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
        "HELIX_CREDENTIAL_BROKER": "C:\\Tools\\Helix\\helix-credential-broker.exe",
        "HELIX_AI_GUIDE": "C:\\Users\\user\\AppData\\Roaming\\Helix\\HELIX_AI_GUIDE.md",
        "HELIX_ADMIN_SCRIPT": "C:\\Users\\user\\AppData\\Roaming\\Helix\\helix-admin.ps1"
      }
    }
  }
}
```

完整设计和操作说明见：

- [SSH MCP v1 技术设计](docs/architecture/ssh-mcp-v1.md)
- [Windows Credential Broker](docs/architecture/windows-credential-broker.md)
- [Helix AI Operations Guide](docs/guides/HELIX_AI_GUIDE.md)
- [主机与凭据管理](docs/guides/host-credential-administration.md)
- [Helix Remote Operations Skill](skills/helix-remote-operations/SKILL.md)
