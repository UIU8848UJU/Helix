# Helix

**Remote Execution Runtime for AI Agents / 面向 AI Agent 的远程执行 Runtime**

Helix gives AI agents a persistent, credential-aware remote execution layer. It combines an MCP adapter, a long-lived Rust daemon, reusable SSH sessions, persistent PTYs, bounded task lifecycles, secure Windows-backed credentials, SFTP/SCP, and durable remote jobs.

Helix 为 AI Agent 提供一个持久、可复用、具备本地凭据代理能力的远程执行层：通过 MCP 暴露能力，由 Rust 常驻 daemon 管理 SSH Session、PTY、Task、凭据、文件传输与远端持久任务。

[中文](#中文) · [English](#english)

---

# 中文

## Helix 是什么

Helix **不是把编译、部署、诊断等业务流程写死在 MCP 里**，而是提供稳定的远程执行能力，供 Agent、Skill、SOP 或其他上层编排使用。

```text
Agent / Skill / SOP
        │
       MCP
        │
        ▼
  Helix SSH Adapter
        │
        ▼
      helixd
   ┌────┼───────────────┐
   │    │               │
 Task  Terminal      Credential
Pool   Runtime        Runtime
   │    │               │
   └────┴──── Transport ┘
              │
             SSH
              │
              ▼
         Remote Host
```

当前主要 Transport 是 SSH，因此 MCP Adapter 仍命名为 `helix-ssh` / `apps/ssh-mcp`；项目本身的定位是更上层的 **Remote Execution Runtime**。

## 为什么需要 Helix

普通 SSH MCP 往往适合“一次请求 → 一次 SSH 命令 → 返回结果”。Helix 更关注 Agent 长时间工作的场景：

- **持久 PTY**：Shell 不因一次 MCP 调用结束而消失，`cwd`、环境、虚拟环境、容器上下文可以继续保留；
- **Terminal Task**：在持久 PTY 中提交一次有明确生命周期的命令，返回 `TaskID`，使用 `task_wait` 等待结束，不需要客户端 `sleep 25` 猜时间；
- **本地凭据代理**：Windows 密码认证可由 helixd 从 Windows Credential Manager 读取，密码不需要进入聊天、MCP payload、命令行参数或日志；
- **SSH Session 复用**：减少重复 TCP/KEX/auth 开销，多 Agent 并发统一经过有界任务队列；
- **远端持久 Job**：长时间编译、测试、部署等任务可以脱离一次 MCP/SSH 调用持续运行；
- **统一能力层**：执行、PTY、sudo、SFTP/SCP、Docker/Compose、环境探测、主机与凭据管理使用同一套 Runtime。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| Persistent Terminal | `terminal_open` 创建持久 PTY，返回 `TerminalID` |
| Async Terminal Task | `terminal_exec` 在现有 Terminal 中提交命令并返回 `TaskID` |
| Bounded Wait | `task_wait` 等待 Task 完成或超时返回当前快照，避免客户端 sleep/poll |
| Raw Interactive I/O | `terminal_write` 处理确认提示、REPL、交互输入等原始 stdin |
| Incremental Output | `terminal_read` / `terminal_tail` / `terminal_search` 按 cursor 或关键字读取输出 |
| Secure Credentials | Windows Credential Manager + helixd 本地凭据代理 |
| SSH Key / Agent Auth | `openssh` 路径继续支持系统 SSH key / ssh-agent 认证 |
| Remote Jobs | `job_start` / `job_status` / `job_logs` / `job_cancel` |
| File Transfer | `ssh_upload` / `ssh_download`，支持 SCP 或 broker SFTP |
| Direct sudo | `sudo_exec`，Harness 模式下不引入审批 token 流程 |
| Host Management | `host_list` / `host_get` / `host_onboard` / `host_update` / `host_offboard` |
| Runtime Utilities | Docker/Compose、环境探测、连接检查、审计、超时、输出上限 |

## Persistent Terminal + Task

这是 Helix 与普通一次性 SSH 执行最重要的区别之一。

```text
terminal_open
    │
    └── TerminalID = T1
            │
            ├── shell cwd / env / container context 持续存在
            │
            ├── terminal_exec("git pull")
            │       └── TaskID = K1
            │              └── task_wait(K1)
            │
            ├── terminal_exec("./build.sh")
            │       └── TaskID = K2
            │              └── task_wait(K2)
            │
            ├── terminal_search("error")
            └── terminal_close
```

推荐语义：

```text
terminal_exec + task_wait
  = 有明确开始/结束边界的命令

terminal_write
  = 原始交互输入，例如 y/n、REPL、提示符后的人工输入

terminal_read / tail / search
  = 获取 Terminal 的输出
```

`task_wait` 在 daemon 内等待 Task 状态变化，不要求 Agent 自己通过 `sleep` 猜测命令何时结束。等待超时时返回当前 Task 快照，不会因此终止 Terminal。

## TerminalID、TaskID、JobID

三种 ID 表示不同生命周期：

```text
TerminalID
  = 持久执行上下文
  = PTY / shell / cwd / env / interactive state
  = 直到 terminal_close、idle reap 或连接结束

TaskID
  = 本机 helixd 中的一次有界操作
  = queued / running / succeeded / failed / cancelled
  = terminal_exec 会返回 TaskID
  = 当前状态保存在 daemon 内存中

JobID
  = 远端持久任务
  = job_start 创建并在远端保存状态与日志
  = 可跨 MCP / Broker / SSH 会话继续运行
  = 不保证跨远端主机重启
```

不要把 `TaskID` 与 `JobID` 混用：Task 用于 Runtime 内的短/中等生命周期管理，Job 用于真正需要脱离连接持续执行的远端进程。

## Windows 凭据模型

Helix 支持两条主要认证路径：

```text
1. openssh
   └── 系统 SSH key / ssh-agent / OpenSSH 配置

2. windows-credential
   └── Windows Credential Manager
           ↓
         helixd
           ↓
      SSH password auth / SFTP / sudo password
```

使用 `windows-credential` 时，`host_onboard` 可以为主机创建凭据引用，例如：

```text
Helix/ssh/<alias>/login
Helix/ssh/<alias>/sudo
```

`credential_enroll_launch` 由本地进程弹出 Windows 原生凭据窗口。密码由 helixd 在本机读取和使用，不需要出现在：

- AI 对话；
- MCP tool 参数；
- JSON payload；
- CLI 参数；
- 环境变量；
- Helix 日志。

> 这里的 Windows Credential Manager 是 **credential-backed password authentication**。系统 OpenSSH 的 SSH private key / ssh-agent 认证仍由 `openssh` 路径提供，两者概念不同。

## 架构

```text
Claude / Codex / Agent / Skill-Matrix
                 │
              MCP stdio
                 │
                 ▼
        apps/ssh-mcp (TypeScript)
                 │
     Named Pipe / Unix Domain Socket
                 │
                 ▼
            helixd (Rust)
        ┌────────┼─────────┐
        │        │         │
     TaskPool  Terminal  Credential
        │      Registry    Runtime
        │        │         │
        └────────┴────┬────┘
                     │
              helix-core Transport
                     │
             helix-transport-ssh
                     │
        ┌────────────┼─────────────┐
        │            │             │
      exec          PTY         SFTP/sudo
        │            │             │
        └────────────┴─────────────┘
                     │
                 Remote Host
```

`helix-core` 负责通用执行语义，SSH 细节放在 `helix-transport-ssh`。MCP 层负责把这些能力暴露给 Agent，而不是承载具体业务 SOP。

## 快速安装

### Windows Release 包（推荐）

普通用户应使用预编译 Release 包，不需要 Rust 工具链，也不需要本地编译。

1. 从 [GitHub Releases](https://github.com/UIU8848UJU/Helix/releases) 下载 `helix-*-win-x64.zip`；
2. 解压；
3. 在解压目录执行：

```powershell
.\install.ps1
```

不希望自动注册 MCP Client：

```powershell
.\install.ps1 -RegisterClient None
```

Release 包运行依赖：

- Windows 10/11 x64；
- Node.js 20+；
- Windows OpenSSH Client（`ssh` / `scp`）。

Release 包应已包含 `helixd.exe` 与 `helix-ssh-mcp.bundle.mjs`，**不应要求 cargo、npm install 或本地 TypeScript/Rust 编译**。

### 从源码安装

开发者或需要修改 Helix 本身时再使用源码安装。

Windows：

```powershell
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
.\scripts\install.ps1 -RegisterClient Auto
```

源码构建需要 Node.js 20+、npm、OpenSSH Client、Rust 1.85+；Windows 首次编译 vendored OpenSSL 时还可能需要 Perl。

Linux/macOS：

```bash
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
./scripts/install.sh
```

完整说明见 [docs/guides/installation.md](docs/guides/installation.md)。

## 常用 MCP 工具

### Host / Credential

```text
host_list
host_get
host_onboard
host_update
host_offboard
credential_status
credential_enroll_launch
credential_enroll_request
```

### Execute / Transfer

```text
ssh_check
ssh_exec
sudo_exec
ssh_upload
ssh_download
environment_probe
```

### Persistent Terminal

```text
terminal_open
terminal_exec
task_wait
terminal_write
terminal_status
terminal_read
terminal_tail
terminal_search
terminal_resize
terminal_close
```

### Remote Job

```text
job_start
job_status
job_logs
job_cancel
```

### Docker / Compose

```text
docker_list
docker_exec
compose_ps
compose_exec
```

## 远端持久 Job

当任务需要真正脱离一次 MCP/SSH 调用继续执行，例如大型编译、完整测试、镜像构建、部署或数据任务，使用：

```text
job_start
  → job_status
  → job_logs
  → job_cancel   # 需要时
```

`job_start` 在 Unix 目标上将任务状态与日志存放于 `/tmp/helix/jobs/<jobId>`，并使用 `nohup` / `setsid` 等机制脱离原始 SSH 会话。它与持久 Terminal 是两种不同能力：Terminal 保留交互上下文，Job 强调脱离连接后的远端进程生命周期。

## 安全模型

Helix 默认面向开发 Harness 场景，目标是减少频繁审批对 Agent 连续执行的干扰。

Harness 默认倾向：

```text
allowHostMutation=true
allowPolicyMutation=true
strictHostKeyChecking=false
allowedRemotePaths=["/"]
direct sudo_exec
```

同时保留轻量危险命令 guard，拦截明显的破坏性操作，例如文件系统擦除、块设备写入、关机/重启、终止 PID 1、fork bomb 等。

这不是完整 shell sandbox。需要更严格的集中管理时使用 `EnterpriseLocked` 配置，并缩小 host、路径、sudo 与 host-key 策略。

## 平台与认证

| 控制端 → 目标端 | 认证方式 | 命令 | 文件传输 |
| --- | --- | --- | --- |
| Windows → Linux | OpenSSH key/agent 或 Windows Credential password | ✅ | ✅ SCP / SFTP |
| Linux/macOS → Linux | OpenSSH key/agent | ✅ | ✅ SCP |
| Windows → Windows | Windows Credential password | ✅ PowerShell | ✅ SFTP |

Windows 目标的命令执行使用 PowerShell `-EncodedCommand` 处理脚本、cwd 与环境变量。`sudo_exec` 仅适用于 Unix 目标。

## 目录结构

```text
apps/ssh-mcp/                 TypeScript MCP Adapter
apps/helixd/                  Rust long-lived daemon
crates/helix-core/            Task / terminal / spool / transport core
crates/helix-credential/      Windows credential storage and UI
crates/helix-transport-ssh/   SSH exec / PTY / SFTP / sudo transport
docs/architecture/            Architecture documents
docs/guides/                  Installation and operation guides
examples/                     Configuration examples
scripts/                      Build / install / register / admin scripts
```

## 开发验证

```bash
npm install
npm run check
npm test
npm run build
cargo test --release --workspace
cargo build --release --workspace
```

重点文档：

- [Credential Broker Daemon](docs/architecture/credential-broker-daemon.md)
- [AI Guide](docs/guides/HELIX_AI_GUIDE.md)
- [Installation Guide](docs/guides/installation.md)
- [Branch Policy](docs/guides/branch-policy.md)

## 分支策略

- `main` 只保留代码与正式文档；
- `requirements/`、`development/` 等流程产物只存在于 `develop`；
- 不整支 merge `develop` 到 `main`，代码改动按提交选择性合入；
- 详见 [docs/guides/branch-policy.md](docs/guides/branch-policy.md)。

---

# English

## What is Helix?

Helix is a **remote execution runtime for AI agents**. It intentionally keeps business procedures such as compilation, deployment, diagnostics, and project-specific SOPs outside the MCP layer. Agents, Skills, and SOPs orchestrate Helix capabilities instead.

```text
Agent / Skill / SOP
        │
       MCP
        │
        ▼
  Helix SSH Adapter
        │
        ▼
      helixd
   ┌────┼───────────────┐
   │    │               │
 Task  Terminal      Credential
Pool   Runtime        Runtime
   │    │               │
   └────┴──── Transport ┘
              │
             SSH
              │
              ▼
         Remote Host
```

SSH is the primary transport today, so the MCP adapter remains `helix-ssh` / `apps/ssh-mcp`. The Helix project itself sits one layer above that adapter.

## Why Helix?

A minimal SSH MCP is excellent for one-shot request/response execution. Helix targets longer-lived agent workflows:

- **Persistent PTY** — keep shell state, `cwd`, environment, virtualenv, and container context across MCP calls;
- **Terminal Tasks** — submit a bounded command inside an existing terminal, receive a `TaskID`, and use `task_wait` instead of guessing with client-side sleeps;
- **Local credential brokering** — on Windows, helixd can read password credentials from Windows Credential Manager without exposing them to the model or MCP payloads;
- **Reusable SSH sessions** — reduce repeated TCP/KEX/auth overhead and apply bounded concurrency centrally;
- **Durable remote jobs** — run long builds, tests, deployments, and batch work independently of one MCP/SSH call;
- **Capability-first design** — exec, PTY, sudo, SFTP/SCP, Docker/Compose, environment probing, hosts, and credentials are exposed as reusable primitives.

## Core capabilities

| Capability | Description |
| --- | --- |
| Persistent Terminal | `terminal_open` creates a persistent PTY and returns a `TerminalID` |
| Async Terminal Task | `terminal_exec` submits a command into an existing terminal and returns a `TaskID` |
| Bounded Wait | `task_wait` waits for task completion or returns the current snapshot on timeout |
| Raw Interactive I/O | `terminal_write` sends raw stdin for prompts, REPLs, and interactive programs |
| Incremental Output | `terminal_read` / `terminal_tail` / `terminal_search` retrieve output by cursor or pattern |
| Secure Credentials | Windows Credential Manager backed credential brokering through helixd |
| SSH Key / Agent Auth | The `openssh` path continues to use system SSH keys and ssh-agent |
| Remote Jobs | `job_start` / `job_status` / `job_logs` / `job_cancel` |
| File Transfer | `ssh_upload` / `ssh_download` via SCP or broker SFTP |
| Direct sudo | `sudo_exec` without an approval-token workflow in Harness mode |
| Host Management | `host_list` / `host_get` / `host_onboard` / `host_update` / `host_offboard` |
| Runtime Utilities | Docker/Compose, environment probing, connection checks, audit, timeouts, output bounds |

## Persistent Terminal + Task

This is one of the main differences between Helix and one-shot SSH execution.

```text
terminal_open
    │
    └── TerminalID = T1
            │
            ├── shell cwd / env / container context stays alive
            │
            ├── terminal_exec("git pull")
            │       └── TaskID = K1
            │              └── task_wait(K1)
            │
            ├── terminal_exec("./build.sh")
            │       └── TaskID = K2
            │              └── task_wait(K2)
            │
            ├── terminal_search("error")
            └── terminal_close
```

Recommended semantics:

```text
terminal_exec + task_wait
  = a command with an explicit start/end lifecycle

terminal_write
  = raw interactive input such as y/n, REPL input, or prompt responses

terminal_read / tail / search
  = terminal output retrieval
```

`task_wait` waits inside the daemon for task state changes. The agent does not need to run `sleep 25` and guess when a command is finished. A wait timeout returns the current task snapshot; it does not terminate the persistent terminal.

## TerminalID, TaskID, and JobID

These IDs represent different lifecycles:

```text
TerminalID
  = persistent execution context
  = PTY / shell / cwd / env / interactive state
  = lives until terminal_close, idle reap, or connection termination

TaskID
  = one bounded local helixd operation
  = queued / running / succeeded / failed / cancelled
  = returned by terminal_exec
  = currently stored in daemon memory

JobID
  = durable remote job
  = created by job_start with remote state and logs
  = can outlive MCP / Broker / SSH sessions
  = not guaranteed to survive a remote host reboot
```

Do not confuse `TaskID` with `JobID`: tasks model runtime operations; jobs model remote processes that need to outlive the connection that created them.

## Windows credential model

Helix supports two primary authentication paths:

```text
1. openssh
   └── system SSH key / ssh-agent / OpenSSH configuration

2. windows-credential
   └── Windows Credential Manager
           ↓
         helixd
           ↓
      SSH password auth / SFTP / sudo password
```

For `windows-credential` hosts, `host_onboard` can create credential references such as:

```text
Helix/ssh/<alias>/login
Helix/ssh/<alias>/sudo
```

`credential_enroll_launch` opens a native local Windows credential dialog. helixd reads and uses the password locally, so the secret does not need to appear in:

- the AI conversation;
- MCP tool arguments;
- JSON payloads;
- CLI arguments;
- environment variables;
- Helix logs.

> Windows Credential Manager here provides **credential-backed password authentication**. SSH private keys and ssh-agent remain part of the separate `openssh` authentication path.

## Architecture

```text
Claude / Codex / Agent / Skill-Matrix
                 │
              MCP stdio
                 │
                 ▼
        apps/ssh-mcp (TypeScript)
                 │
     Named Pipe / Unix Domain Socket
                 │
                 ▼
            helixd (Rust)
        ┌────────┼─────────┐
        │        │         │
     TaskPool  Terminal  Credential
        │      Registry    Runtime
        │        │         │
        └────────┴────┬────┘
                     │
              helix-core Transport
                     │
             helix-transport-ssh
                     │
        ┌────────────┼─────────────┐
        │            │             │
      exec          PTY         SFTP/sudo
        │            │             │
        └────────────┴─────────────┘
                     │
                 Remote Host
```

`helix-core` owns reusable execution semantics while SSH-specific behavior lives in `helix-transport-ssh`. The MCP layer exposes those capabilities to agents rather than encoding project-specific SOPs.

## Quick start

### Windows release package (recommended)

End users should install the prebuilt release package. No Rust toolchain or local build is required.

1. Download `helix-*-win-x64.zip` from [GitHub Releases](https://github.com/UIU8848UJU/Helix/releases);
2. Extract it;
3. Run from the extracted directory:

```powershell
.\install.ps1
```

Skip automatic MCP client registration:

```powershell
.\install.ps1 -RegisterClient None
```

Release runtime requirements:

- Windows 10/11 x64;
- Node.js 20+;
- Windows OpenSSH Client (`ssh` / `scp`).

A release package should already contain `helixd.exe` and `helix-ssh-mcp.bundle.mjs`; it **must not require cargo, npm install, or local TypeScript/Rust compilation**.

### Install from source

Use the source installer when developing or modifying Helix itself.

Windows:

```powershell
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
.\scripts\install.ps1 -RegisterClient Auto
```

Source builds require Node.js 20+, npm, OpenSSH Client, and Rust 1.85+. The first Windows build of vendored OpenSSL may also require Perl.

Linux/macOS:

```bash
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
./scripts/install.sh
```

See [docs/guides/installation.md](docs/guides/installation.md) for details.

## MCP tools

### Host / Credential

```text
host_list
host_get
host_onboard
host_update
host_offboard
credential_status
credential_enroll_launch
credential_enroll_request
```

### Execute / Transfer

```text
ssh_check
ssh_exec
sudo_exec
ssh_upload
ssh_download
environment_probe
```

### Persistent Terminal

```text
terminal_open
terminal_exec
task_wait
terminal_write
terminal_status
terminal_read
terminal_tail
terminal_search
terminal_resize
terminal_close
```

### Remote Job

```text
job_start
job_status
job_logs
job_cancel
```

### Docker / Compose

```text
docker_list
docker_exec
compose_ps
compose_exec
```

## Durable remote jobs

Use remote jobs when work needs to continue independently of one MCP/SSH call, for example large builds, complete test suites, image builds, deployments, or batch processing:

```text
job_start
  → job_status
  → job_logs
  → job_cancel   # when needed
```

On Unix targets, `job_start` stores state and logs under `/tmp/helix/jobs/<jobId>` and detaches the process from the original SSH session using mechanisms such as `nohup` / `setsid`. Persistent terminals and durable jobs solve different problems: terminals preserve interactive context; jobs preserve remote process lifetime.

## Security model

Helix defaults to a development-oriented Harness profile that minimizes approval interruptions during agent workflows.

Typical Harness defaults:

```text
allowHostMutation=true
allowPolicyMutation=true
strictHostKeyChecking=false
allowedRemotePaths=["/"]
direct sudo_exec
```

A lightweight dangerous-command guard still blocks obvious destructive operations such as filesystem wipes, block-device writes, power control, PID 1 termination, and fork bombs.

This is not a complete shell sandbox. Use the `EnterpriseLocked` profile and narrower host/path/sudo/host-key policies when centralized restrictions are required.

## Platform and authentication

| Controller → Target | Authentication | Commands | File transfer |
| --- | --- | --- | --- |
| Windows → Linux | OpenSSH key/agent or Windows Credential password | ✅ | ✅ SCP / SFTP |
| Linux/macOS → Linux | OpenSSH key/agent | ✅ | ✅ SCP |
| Windows → Windows | Windows Credential password | ✅ PowerShell | ✅ SFTP |

Commands targeting Windows are wrapped with PowerShell `-EncodedCommand` for scripts, working directories, and environment variables. `sudo_exec` applies to Unix targets only.

## Repository layout

```text
apps/ssh-mcp/                 TypeScript MCP Adapter
apps/helixd/                  Rust long-lived daemon
crates/helix-core/            Task / terminal / spool / transport core
crates/helix-credential/      Windows credential storage and UI
crates/helix-transport-ssh/   SSH exec / PTY / SFTP / sudo transport
docs/architecture/            Architecture documents
docs/guides/                  Installation and operation guides
examples/                     Configuration examples
scripts/                      Build / install / register / admin scripts
```

## Development

```bash
npm install
npm run check
npm test
npm run build
cargo test --release --workspace
cargo build --release --workspace
```

Key documents:

- [Credential Broker Daemon](docs/architecture/credential-broker-daemon.md)
- [AI Guide](docs/guides/HELIX_AI_GUIDE.md)
- [Installation Guide](docs/guides/installation.md)
- [Branch Policy](docs/guides/branch-policy.md)

## Branch policy

- `main` contains code and release-facing documentation;
- workflow artifacts such as `requirements/` and `development/` stay on `develop`;
- do not merge the entire `develop` branch into `main`; selectively integrate code commits;
- see [docs/guides/branch-policy.md](docs/guides/branch-policy.md).
