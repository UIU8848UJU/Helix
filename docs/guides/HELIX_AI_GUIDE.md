# Helix AI Operations Guide

这份文件同时面向 AI Agent 和人工操作者。它是 Helix SSH MCP 的本地操作说明，但安全边界仍以 MCP 工具校验和主机配置为准。

## 1. 核心概念

一个主机配置包含三个不同概念：

- **alias**：Helix 内部主机别名，例如 `jetson-dev`。
- **hostname**：远端 IP 或域名，例如 `192.168.0.110`。
- **username**：SSH 登录账号，例如 `jetson_developer`。

实际连接关系是：

```text
username@hostname
```

不能把 alias 当成 username，也不能因为登录失败就自动重写 hostname 或 username。

## 2. AI 必须遵守的规则

1. 正常远程操作和排障时，不得直接编辑 `ssh-mcp.json`。
2. 不得要求用户把登录密码或 sudo 密码粘贴进对话。
3. 不得输出、读取或记录明文凭据；只能通过 `credential_status` 检查凭据是否存在。
4. `ssh_exec`、`docker_exec`、`compose_exec` 都是非特权执行工具，不得在命令中偷偷加入 `sudo`。
5. 需要 sudo 时必须走 `sudo_request → 本地人工审批 → sudo_execute`。
6. `sudo_request` 返回后，AI 必须把 `approvalCommand` 和完整命令展示给用户，然后停止。
7. 只有用户明确表示已经在本地完成审批后，AI 才能调用 `sudo_execute`。
8. `sudo_execute` 的 host、requestId 和 command 必须与审批请求完全一致。
9. allowlist、路径或主机密钥校验失败时，应报告边界，不得通过改配置、拆命令或混淆命令绕过。
10. `host_add`、`host_update`、`host_remove`、`host_onboard`、`host_offboard` 只用于用户明确发起的管理员配置任务。
11. `credential_enroll_request` 或 `credential_delete_request` 返回本地命令后，AI 必须展示命令并停止，不能代替用户输入或删除密码。

## 3. 标准连接流程

AI 应按以下顺序操作：

```text
host_list
  → host_get（需要确认详细配置时）
  → credential_status（密码认证主机）
  → ssh_check
  → environment_probe（陌生环境）
  → 具体操作工具
```

### 登录失败时

依次检查：

- 选中的是否是正确 alias；
- hostname 是否是正确 IP/域名；
- username 是否是正确 SSH 用户；
- `credential_status` 是否显示凭据存在；
- 网络和 22 端口是否可达；
- known_hosts/主机密钥是否匹配；
- 错误来自认证、网络、主机密钥还是策略。

在用户没有明确要求修改配置前，只报告事实和建议，不直接编辑 JSON。

## 4. 主机新增、查询和删除

查询使用：

```text
host_list
host_get
```

用户明确要求新增主机时，优先使用 `host_onboard`，不要让 AI 手工拼接 JSON。输入至少包含：

- alias；
- hostname；
- username；
- authType；
- sudoMode。

Windows 密码认证默认自动生成：

```text
Helix/ssh/<alias>/login
Helix/ssh/<alias>/sudo
```

主机写操作仍受 `allowHostMutation` 或 `HELIX_ALLOW_HOST_MUTATION=1` 控制。

下线主机使用 `host_offboard`。它只删除非敏感主机配置，不自动删除 Windows Credential Manager 中的凭据。工具会返回：

- `orphanedCredentials`；
- `credentialsDeleted=false`；
- 可选的本地 `cleanupCommand`。

AI 必须询问用户是否清理凭据，不能因为用户要求删除主机就推断可以同时删除秘密。

## 5. 凭据录入与更新

AI 调用：

```text
credential_enroll_request(host, kind, separatePasswords)
```

工具返回 `enrollmentCommand` 后：

1. 展示命令和涉及的 credentialRef；
2. 告诉用户密码只会在本地隐藏终端输入；
3. 停止，等待用户明确确认录入完成；
4. 再调用 `credential_status`；
5. 最后调用 `ssh_check`。

默认 `separatePasswords=false`，Broker 只提示一次密码，并把同一密码写入所选 login/sudo 目标。登录密码和 sudo 密码不同时，才设置 `separatePasswords=true`。

本地脚本默认位置：

```text
%APPDATA%\Helix\helix-admin.ps1
```

手工录入示例：

```powershell
& "$env:APPDATA\Helix\helix-admin.ps1" credential set `
  -Host "jetson-dev" `
  -Kind all
```

凭据删除使用 `credential_delete_request`，同样必须把本地命令交给用户执行，不能通过 MCP 直接删除。

## 6. 普通命令

普通远端命令使用 `ssh_exec`。

尽量使用结构化参数：

- `cwd`：远端工作目录；
- `env`：环境变量；
- `sourceScripts`：需要 source 的环境脚本；
- `timeoutSeconds`：超时。

例如 ROS/编译任务应优先表达为：

```text
host: jetson-dev
cwd: /workspace/project
sourceScripts:
  - /opt/ros/humble/setup.bash
  - /workspace/install/setup.bash
command: colcon build
```

不要把一长串 `cd && export && source && command` 全部塞进一条脆弱命令，除非确实需要 shell 语义。

执行后检查：

- `ok`
- `exitCode`
- `stdout`
- `stderr`
- `timedOut`
- `truncated`

## 7. sudo 人工审批

### 阶段一：申请

AI 调用：

```text
sudo_request(host, exact_command, reason)
```

其中 command 必须是最终完整命令，不能先申请一个宽泛 shell，再在 shell 内执行其他内容。

工具返回：

- `requestId`
- 完整命令及哈希
- 过期时间
- `approvalCommand`

### 阶段二：人工审批

AI 必须把 `approvalCommand` 原样展示给用户并停止。

用户在独立本地终端运行命令，核对：

- 主机 alias；
- 远端 hostname/username；
- 完整命令；
- 申请理由；
- 有效期。

确认无误后输入大写：

```text
APPROVE
```

### 阶段三：执行

用户明确回复已完成审批后，AI 调用：

```text
sudo_execute(host, requestId, exact_command)
```

host、requestId、command 必须完全一致。批准不能复用，也不能用于相似命令。

### allowlist 拒绝

AI 应报告：

- 被拒绝的完整命令；
- 当前 sudo 模式；
- 需要管理员评估的最窄锚定规则。

不得自动修改 JSON、拆分命令、编码命令或申请宽泛 shell 绕过限制。

## 8. Docker 与 Compose

先使用：

```text
environment_probe
docker_list
compose_ps
```

再根据实际名称调用：

```text
docker_exec
compose_exec
```

优先使用结构化的 cwd、env、sourceScripts、user 和 shell 参数。

如果 Docker 本身要求 root 权限，应为最终完整 Docker 命令申请 reviewed sudo，不得在 `docker_exec` 中加入 sudo。

## 9. 文件传输

使用：

```text
ssh_upload
ssh_download
```

要求：

- 尽量使用绝对路径；
- 目录传输才设置 `recursive=true`；
- 本地路径和远端路径必须在 allowlist 中；
- 路径被拒绝时只报告策略边界，不自动扩大路径权限。

## 10. 编译任务建议流程

```text
host_list
  → credential_status
  → ssh_check
  → environment_probe
  → 确认源码路径和容器
  → 必要时上传文件
  → source 环境
  → 执行编译
  → 分析第一个有意义的错误
  → 最小化诊断
  → 必要时申请精确 sudo
```

不要在编译失败后盲目反复全量执行。优先识别：

- 编译器或架构不匹配；
- 依赖缺失；
- source 环境遗漏；
- 磁盘空间；
- 权限问题；
- 容器或工作目录错误。

## 11. 配置修改

只有用户明确要求新增、修改或删除主机/策略时，才能进入配置管理模式。

修改前说明：

- 修改哪个 alias；
- 修改哪个字段；
- 原值和新值；
- 修改原因；
- 是否扩大网络、路径或 sudo 权限；
- 如何验证。

配置中只能保存 credentialRef，不能保存明文密码。

## 12. 完成报告

远程任务完成后至少说明：

- 使用的主机 alias；
- 执行环境：主机、Docker 容器或 Compose service；
- 实际执行的关键命令；
- 是否使用了 sourceScripts；
- 是否发生 sudo 审批；
- exit code 和关键输出；
- 修改或上传了哪些文件；
- 仍存在的问题及下一步。
