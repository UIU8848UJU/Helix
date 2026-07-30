# Helix SSH MCP v1 技术设计

状态：实施中  
版本：v1  
目标仓库：`UIU8848UJU/Helix`

## 1. 背景与定位

Helix 是面向 AI Agent 的基础设施仓库。SSH MCP 是首个正式能力模块，为 AI 提供受控的远程主机操作能力，包括主机配置、连接检查、命令执行、文件传输、sudo、Docker/Compose 操作、环境探测和审计。

SSH MCP 只负责确定性的远程能力，不负责网页抓取和业务决策。后续 Web Research MCP 与 SSH MCP 必须分进程、分配置和分权限部署，避免网页提示词注入直接获得远程执行权限。

## 2. v1 目标

v1 必须具备以下可交付能力：

1. 可在 Linux、macOS 和 Windows（安装 OpenSSH Client）上安装运行。
2. 通过 MCP stdio 与 Claude Desktop、Claude Code、Cursor、Codex 等 MCP 客户端集成。
3. 支持读取、添加、修改、删除和列出主机配置。
4. 支持 SSH 连通性检查和远程命令执行。
5. 支持上传和下载文件或目录。
6. 支持经过主机级策略约束的 sudo 命令。
7. 支持 Docker 容器发现、容器内命令执行和 Docker Compose 服务执行。
8. 支持 `cwd`、环境变量和 `source` 脚本，覆盖“进入目录 -> source 环境 -> 编译”的常见工作流。
9. 支持环境探测，返回 OS、CPU 架构、Shell、工具链、Docker、候选环境脚本等结构化信息。
10. 支持超时、输出上限、并发限制、主机指纹校验和 JSONL 审计。
11. 不把 SSH 密码、sudo 密码或私钥内容暴露给模型。

## 3. 非目标

v1 不实现：

- 网页爬取、浏览器自动化或搜索引擎访问。
- 长期任务调度器和后台守护任务管理。
- 交互式 TTY 会话透传。
- 密码保管库；密码认证应由 OpenSSH/SSH Agent/系统凭据能力处理。
- 任意 root shell。
- 在 MCP 参数中直接输入密码或私钥。

## 4. 仓库结构

```text
Helix/
├── apps/
│   └── ssh-mcp/
│       ├── src/
│       │   ├── audit.ts
│       │   ├── config.ts
│       │   ├── index.ts
│       │   ├── policy.ts
│       │   ├── process.ts
│       │   ├── server.ts
│       │   ├── ssh.ts
│       │   └── types.ts
│       ├── test/
│       ├── package.json
│       └── tsconfig.json
├── docs/architecture/ssh-mcp-v1.md
├── examples/ssh-mcp.config.json
├── scripts/install.sh
├── scripts/install.ps1
├── package.json
└── README.md
```

## 5. 技术选型

- Runtime：Node.js 20+
- Language：TypeScript，ESM，严格类型检查
- MCP：官方 TypeScript SDK v1.x 稳定线，stdio transport
- Schema：Zod
- SSH 后端：系统原生 `ssh` / `scp`
- 配置：JSON 文件
- 测试：Vitest

选择原生 OpenSSH 而非在进程内实现 SSH 协议，原因是可以直接复用：

- `~/.ssh/config`
- SSH Agent
- ProxyJump / 跳板机
- 企业已有密钥和证书
- `known_hosts` 主机指纹校验
- 操作系统已有的 ssh/scp 行为

## 6. 配置模型

默认配置路径：

- Linux/macOS：`~/.config/helix/ssh-mcp.json`
- Windows：`%APPDATA%\\Helix\\ssh-mcp.json`
- 可通过 `HELIX_SSH_CONFIG` 覆盖

示例：

```json
{
  "version": 1,
  "settings": {
    "allowHostMutation": false,
    "defaultTimeoutSeconds": 60,
    "maxOutputBytes": 1048576,
    "maxConcurrentCommands": 4,
    "strictHostKeyChecking": true,
    "auditEnabled": true
  },
  "hosts": {
    "build-dev": {
      "hostname": "10.0.0.20",
      "port": 22,
      "username": "developer",
      "identityFile": "~/.ssh/id_ed25519",
      "tags": ["development", "docker"],
      "allowedRemotePaths": ["/workspace", "/tmp/helix"],
      "sudo": {
        "enabled": true,
        "allow": [
          "^systemctl status [a-zA-Z0-9_.@-]+$",
          "^systemctl restart test-[a-zA-Z0-9_.@-]+$",
          "^docker (ps|info)$"
        ]
      }
    }
  }
}
```

约束：

- 配置文件不存储密码或私钥内容。
- `identityFile` 只保存本机路径。
- `allowHostMutation=false` 时，主机写操作工具返回拒绝；管理员通过环境变量 `HELIX_ALLOW_HOST_MUTATION=1` 临时开启。
- 主机别名必须匹配 `[a-zA-Z0-9._-]+`。
- 工具只能选择已配置的主机别名，不能在每次调用中提交任意 IP、用户名或密钥。

## 7. MCP 工具清单

### 7.1 主机配置

- `host_list`：列出主机摘要，敏感字段脱敏。
- `host_get`：读取单个主机配置摘要。
- `host_add`：添加主机；受 `allowHostMutation` 控制。
- `host_update`：修改主机；受 `allowHostMutation` 控制。
- `host_remove`：删除主机；受 `allowHostMutation` 控制。

### 7.2 SSH 与文件

- `ssh_check`：执行 BatchMode 连通性检查。
- `ssh_exec`：执行普通远程命令。
- `ssh_upload`：通过 scp 上传文件或目录。
- `ssh_download`：通过 scp 下载文件或目录。

`ssh_exec` 参数支持：

- `host`
- `command`
- `cwd`
- `env`
- `sourceScripts`
- `timeoutSeconds`

远程包装顺序：

```text
set -e
cd <cwd>
export KEY=<value>
source <script>
<command>
```

所有值必须经过 shell quoting，`sourceScripts` 和 `cwd` 还要通过路径策略检查。

### 7.3 sudo

- `sudo_exec`：执行主机策略允许的 sudo 命令。

安全规则：

1. 默认关闭，每台主机显式启用。
2. 命令必须完整匹配至少一个以 `^` 开头、以 `$` 结尾的 allow 正则。
3. 使用 `sudo -n`，仅允许系统 sudoers 中已配置的 NOPASSWD 权限。
4. 不接收 sudo 密码。
5. 不提供 unrestricted root shell。
6. 审计记录主机、命令、调用时间、退出码和耗时。

推荐 sudoers 示例：

```sudoers
helix-agent ALL=(root) NOPASSWD: /bin/systemctl status *
helix-agent ALL=(root) NOPASSWD: /bin/systemctl restart test-*
```

生产环境优先使用固定 root helper，而不是宽泛通配符。

### 7.4 Docker 与 Compose

- `docker_list`：列出容器及状态。
- `docker_exec`：在指定容器中执行命令。
- `compose_ps`：在项目目录读取 Compose 服务状态。
- `compose_exec`：进入 Compose 服务容器执行命令。

`docker_exec` / `compose_exec` 支持：

- `command`
- `cwd`
- `env`
- `sourceScripts`
- `user`
- `timeoutSeconds`

容器名、服务名、工作目录和 source 脚本均需要验证。Docker 权限使用远程账号自身权限；v1 不自动通过 sudo 调用 Docker。

### 7.5 环境探测

- `environment_probe`：执行只读探测并返回结构化 JSON。

输出至少包含：

```json
{
  "os": {},
  "arch": "x86_64",
  "shell": "/bin/bash",
  "cwd": "/home/developer",
  "tools": {
    "git": "2.x",
    "docker": "27.x",
    "gcc": "12.x",
    "cmake": "3.x",
    "python": "3.x",
    "node": "20.x"
  },
  "containers": [],
  "candidateSourceScripts": []
}
```

候选脚本搜索必须限制深度和目录，默认检查 `/opt/ros/*/setup.bash`、当前用户常用工作区的 `install/setup.bash`、`env.sh`、`activate` 等，不执行搜索到的脚本。

## 8. 执行与安全边界

### 8.1 本地进程

- 使用 `child_process.spawn`，禁止本地 `shell: true`。
- 参数以数组形式传递给 `ssh`/`scp`。
- stdout/stderr 分离收集。
- 超时后发送 SIGTERM，再升级到 SIGKILL。
- 超过输出上限后中止并标记 `truncated=true`。

### 8.2 SSH 参数

默认使用：

```text
BatchMode=yes
ConnectTimeout=10
ServerAliveInterval=15
ServerAliveCountMax=2
StrictHostKeyChecking=yes
```

可配置主机端口、用户、IdentityFile、ProxyJump 和额外受控选项。禁止通过 MCP 工具输入任意 `-o` 参数。

### 8.3 路径策略

上传目标、下载源、远程 cwd、source 脚本必须位于该主机 `allowedRemotePaths` 中。路径检查采用规范化后的绝对路径前缀匹配，并拒绝 NUL、换行和明显的路径逃逸。

本地上传/下载目录可通过环境变量配置允许根目录：

```text
HELIX_LOCAL_PATH_ROOTS=/workspace;/tmp/helix
```

### 8.4 审计

默认审计路径：

- Linux/macOS：`~/.local/state/helix/ssh-mcp/audit.jsonl`
- Windows：`%LOCALAPPDATA%\\Helix\\ssh-mcp\\audit.jsonl`
- 可通过 `HELIX_SSH_AUDIT_LOG` 覆盖

每条记录包括：

- timestamp
- requestId
- tool
- host
- command 或操作摘要
- durationMs
- exitCode
- timedOut
- truncated
- success

不记录密码、私钥内容或完整环境变量值。可配置对命令进行 SHA-256 摘要化。

## 9. 安装与集成

### 9.1 Linux/macOS

```bash
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
./scripts/install.sh
```

安装脚本负责：

1. 检查 Node.js 20+、npm、ssh、scp。
2. 安装依赖并构建。
3. 创建默认配置目录和示例配置。
4. 输出 MCP 客户端配置片段。

### 9.2 Windows PowerShell

```powershell
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
.\\scripts\\install.ps1
```

要求 Windows OpenSSH Client 已安装。

### 9.3 MCP 客户端配置

```json
{
  "mcpServers": {
    "helix-ssh": {
      "command": "node",
      "args": ["/absolute/path/to/Helix/apps/ssh-mcp/build/index.js"],
      "env": {
        "HELIX_SSH_CONFIG": "/absolute/path/to/ssh-mcp.json"
      }
    }
  }
}
```

## 10. 错误模型

工具返回结构化结果：

```json
{
  "ok": false,
  "exitCode": 1,
  "stdout": "",
  "stderr": "...",
  "timedOut": false,
  "truncated": false,
  "durationMs": 123
}
```

配置错误、策略拒绝和参数错误作为 MCP InvalidParams；SSH/进程错误作为工具结果返回，避免丢失 stdout/stderr。

## 11. 测试与验收

### 11.1 自动测试

- 配置 schema 和原子写入测试。
- 主机别名校验测试。
- 远程路径允许/拒绝测试。
- sudo 正则必须锚定测试。
- sudo 允许/拒绝测试。
- shell quoting 和命令包装测试。
- 超时、输出截断和退出码测试。
- MCP 工具注册冒烟测试。

### 11.2 人工验收

在一台测试 Linux 主机验证：

1. 添加和读取主机。
2. `ssh_check` 成功。
3. 普通命令、cwd、env、source 执行成功。
4. 文件上传和下载内容一致。
5. 未在 allowlist 的 sudo 被拒绝。
6. allowlist 内且 sudoers 授权的 sudo 成功。
7. 列出 Docker 容器并进入容器执行命令。
8. Compose 服务执行成功。
9. 环境探测返回有效 JSON。
10. 所有操作写入审计日志。

## 12. 里程碑

- M1：技术设计、Monorepo 骨架和安装脚本。
- M2：配置、策略、进程执行和审计基础库。
- M3：主机 CRUD、SSH 执行和文件传输工具。
- M4：sudo、Docker、Compose 和环境探测工具。
- M5：测试、CI、文档和人工验收说明。

## 13. 后续版本

- Web Research MCP：Fetch/Playwright/内网域名白名单，独立进程。
- Vault/Secret Provider：对接系统钥匙串或企业密钥服务。
- 长任务会话与日志流式读取。
- 主机分组、审批流和 RBAC。
- HTTP transport 与集中式网关。
- 基于 Skill 的远程编译、部署和故障排查 SOP。
