# Helix

Helix 是面向 AI Agent 的远程操作基础设施。当前模块提供 SSH MCP、Rust Credential Broker Daemon、主机管理、文件传输、Docker/Compose、环境探测、直接 sudo 和远端持久作业。

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
apps/credential-broker/       Rust 常驻凭据、SSH Session 与任务 Broker
docs/architecture/            Broker 等架构设计文档
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
- `job_start` / `job_status` / `job_logs` / `job_cancel`：远端持久后台作业；
- `ssh_upload` / `ssh_download`：文件传输；
- `docker_list` / `docker_exec`；
- `compose_ps` / `compose_exec`；
- `environment_probe`：探测 OS、架构、工具链、容器和环境脚本；
- 常驻 Broker、SSH Session 复用、有界任务队列、固定 worker 池；
- JSONL 审计、超时、输出上限和并发控制。

## Credential Broker Daemon

旧架构每次密码 SSH/SFTP 调用都会：

```text
MCP
  → spawn helix-credential-broker serve-once
  → TCP connect
  → SSH KEX
  → password auth
  → execute
  → Broker 退出
```

这种方式在 Skill-Matrix 多子进程、多 Agent 并发时会产生大量进程启动和 SSH 握手，也容易放大 `MaxStartups`、KEX 抖动和 65 秒 Broker 超时问题。

当前架构改为：

```text
MCP / Skill-Matrix subprocesses
  → Named Pipe (Windows) / Unix Domain Socket (Unix)
  → Credential Broker Daemon
  → submit TaskID
  → bounded queue
  → fixed worker pool
  → persistent SSH Session pool
  → remote host
```

IPC endpoint：

```text
Windows: \\.\pipe\helix-credential-broker-v1
Unix:    /tmp/helix-credential-broker-v1.sock
```

MCP 第一次需要密码 SSH 时会自动启动 Broker Daemon。正常调用不需要人工启动守护进程，也不会再为每条命令创建一个 Rust 进程。

Broker 协议从同步 stdin RPC 改成：

```text
submit
  → TaskID
  → task_status 轮询
  → succeeded / failed / cancelled
```

默认资源模型：

```text
workers = maxConcurrentCommands（默认 4）
queueCapacity = max(32, workers * 16)（默认 64）
SSH idle Session TTL = 120s
max idle Sessions / connection key = 2
握手重试 = 200ms / 500ms / 1000ms
Broker Task 完成态保留 = 600s
```

因此即使 Skill-Matrix 同时启动 20 个子进程请求远端信息，也不会同时创建 20 个 Broker 进程和 20 个 SSH 握手。请求先进入有界队列，最多由固定数量 worker 执行。

SSH Session 按凭据、host、port、username 和 host-key 策略复用。复用前会检查认证状态和 keepalive；失效 Session 会丢弃。连接/KEX 类瞬时错误会在命令真正开始前有限重试，但**不会在命令可能已经执行后自动重放命令**。

注意两个 Task 概念不同：

```text
Broker TaskID
  = 本机 Daemon 内部的短/中等 RPC 调度状态
  = MCP 自动 submit + poll

remote jobId
  = job_start 创建的远端持久任务
  = 用于长时间编译、测试、Docker build、部署等
```

Broker Task 当前使用内存状态；Daemon 崩溃后本地 TaskID 会丢失。远端 `job_*` 不依赖 Broker Task 内存，所以 Broker/MCP 重启不会自动杀掉已经启动的远端持久作业。

详细设计：`docs/architecture/credential-broker-daemon.md`。

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

## 远端持久作业

预计超过约 30 秒，或者不能因为 MCP 超时、Claude 重启、SSH 短暂断开而中止的任务，不要使用长时间阻塞的 `ssh_exec`，改用：

```text
job_start
  → job_status
  → job_logs
  → job_cancel（需要时）
```

`job_start` 会在远端 `/tmp/helix/jobs/<jobId>` 创建作业目录，通过 `nohup` 和 `setsid` 脱离当前 SSH 会话，然后立即返回 `jobId`。作业状态和日志位于远端，所以原 MCP 调用结束后仍可继续查询。

示例：Docker Compose 镜像构建。

```json
{
  "host": "Ubuntu22.04_developer",
  "type": "compose-build",
  "name": "QuantX dev image",
  "cwd": "/home/xxx/QuantX",
  "command": "docker compose -f docker/docker-compose.yml build dev"
}
```

支持的任务类型：

```text
build
test
docker-build
compose-build
deploy
service
data
simulation
run
custom
```

任务类型只用于分类、日志和 AI 路由，执行机制保持统一，不为每种构建工具写一套专用接口。

### 查询状态

```json
{
  "host": "Ubuntu22.04_developer",
  "jobId": "job-..."
}
```

可能状态：

```text
queued / running / succeeded / failed / cancelled / lost / not_found
```

### 查询日志

首次查看末尾日志：

```json
{
  "host": "Ubuntu22.04_developer",
  "jobId": "job-...",
  "lines": 100
}
```

持续增量读取时，把上次返回的 `nextCursor` 作为下一次的 `cursor`，可避免重复传输日志和消耗上下文 token。

### 取消作业

`job_cancel` 先向整个进程组发送 TERM，等待默认 5 秒；仍未退出时才发送 KILL。使用 `useSudo=true` 启动的作业会自动使用 sudo 取消。

作业可跨 MCP/SSH 会话继续运行，但不会跨远端主机重启继续运行；`/tmp` 也可能在系统重启后被清理。

## 危险命令 guard

Guard 会在 `ssh_exec`、`sudo_exec`、`job_start`、`docker_exec` 和 `compose_exec` 的用户命令执行前拦截明显危险的操作，包括：

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
  → 短任务：ssh_exec / sudo_exec / Docker / Compose / 传输
      ↳ 密码主机由 Broker Daemon 自动 submit + poll + Session 复用
  → 长任务：job_start → job_status / job_logs
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

- `docs/architecture/credential-broker-daemon.md`
- `docs/guides/HELIX_AI_GUIDE.md`
- `skills/helix-remote-operations/SKILL.md`
