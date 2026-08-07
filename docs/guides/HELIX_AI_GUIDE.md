# Helix AI Operations Guide

Helix 默认面向 AI Harness 场景：优先保证远程操作连续、可组合、无需人工复制命令，同时保证登录和 sudo 密码不进入聊天或 MCP 参数。

## 1. 主机字段

- **alias**：Helix 内部主机别名，例如 `ubuntu22-developer`。
- **hostname**：远端 IP 或域名，例如 `192.168.49.128`。
- **username**：SSH 登录账号，例如 `developer`。

实际连接关系是 `username@hostname`。不要把 alias 当成 username。

## 2. 默认 Harness 模式

Windows 默认安装方式：

```powershell
.\scripts\install.ps1 -RegisterClient Claude
```

等价于：

```text
DeploymentMode=Harness
allowHostMutation=true
allowPolicyMutation=true
strictHostKeyChecking=false
allowedRemotePaths=["/"]
```

这意味着 AI 可以直接：

- 新增、修改和删除主机；
- 访问远端任意绝对路径；
- 修改认证和连接配置；
- 运行普通 SSH、Docker、Compose 和 sudo 命令；
- 使用 `sudo_exec`，无需 sudo allowlist、审批请求、确认 token 或过期时间；
- 首次连接时不因缺少 `known_hosts` 条目而中断 Harness。

需要集中锁定时使用：

```powershell
.\scripts\install.ps1 -DeploymentMode EnterpriseLocked
```

锁定模式会关闭主机/策略写入并恢复严格 host-key 校验。

## 3. 一站式主机添加

优先调用：

```text
host_onboard
```

Windows 密码认证主机默认自动生成：

```text
Helix/ssh/<alias>/login
Helix/ssh/<alias>/sudo
```

`host_onboard` 成功后会直接启动一个独立、可见的本地 PowerShell 窗口。用户只需在窗口中输入密码，不需要从聊天复制命令。

默认一次输入同时保存登录和 sudo 密码。两者不同时设置：

```json
{
  "separatePasswords": true
}
```

窗口未出现或需要重新录入时调用：

```text
credential_enroll_launch
```

仅在无桌面或非 Windows 环境使用：

```text
credential_enroll_request
```

AI 永远不得要求用户把密码粘贴到对话中。

## 4. 标准连接流程

```text
host_list
  → host_get
  → credential_status
  → ssh_check
  → environment_probe
  → 根据任务时长选择短任务或持久作业
```

凭据不存在时，在 Windows 上调用 `credential_enroll_launch`。

### 4.1 Credential Broker Daemon

密码认证的 SSH/SFTP 请求不再为每次调用启动一次 `serve-once` Broker。MCP 会自动连接本机常驻 Broker：

```text
MCP / Skill-Matrix subprocesses
  → Windows Named Pipe / Unix Domain Socket
  → submit Broker TaskID
  → bounded queue
  → fixed worker pool
  → pooled SSH Session
  → remote host
```

Agent 不需要手动管理 Broker TaskID；普通 Helix MCP 工具会自动完成 `submit → task_status` 轮询并返回最终 SSH 结果。

多 Agent 并发规则：

- 可以并发提交请求，由 Broker 队列统一削峰；
- 不要因为想并发而自行启动多个 Broker Daemon；
- 不要调用 `serve-once` 绕过队列；
- Broker 队列满时降低 fan-out 或稍后重试；
- SSH 命令退出码非 0 是正常执行结果，不等于 Broker 崩溃；
- Broker 只在命令真正开始前对连接/KEX 类瞬时错误有限重试，不自动重放可能已经执行过的命令；
- Broker Task 是本机调度状态，remote `jobId` 是远端长任务状态，两者不能混用。

默认资源模型：

```text
workers = maxConcurrentCommands（默认 4）
queueCapacity = max(32, workers * 16)
SSH Session idle TTL = 120s
max idle Sessions/key = 2
handshake backoff = 200ms / 500ms / 1000ms
```

完整设计见 `docs/architecture/credential-broker-daemon.md`。

## 5. 普通短命令

预计数秒到几十秒内完成、输出有限、允许当前 MCP 调用等待时，使用：

```text
ssh_exec
```

优先传结构化参数：

- `cwd`
- `env`
- `sourceScripts`
- `timeoutSeconds`

例如：

```text
host: ubuntu22-developer
cwd: /workspace/project
sourceScripts:
  - /opt/ros/humble/setup.bash
command: git status --short
```

不要仅靠 MCP 客户端的 `run_in_background` 把长任务交给 `ssh_exec`。它不会让远端进程成为持久作业。

## 6. sudo 命令

需要 sudo 的短命令直接调用：

```text
sudo_exec
```

示例：

```json
{
  "host": "ubuntu22-developer",
  "command": "systemctl restart nginx"
}
```

不存在以下旧流程：

```text
sudo_request
APPROVE
sudo_execute
sudo allowlist
审批过期时间
```

密码认证主机由 Broker 从 Windows Credential Manager 读取 sudo 密码；OpenSSH 主机通过 `sudo -n` 执行。

## 7. 远端持久作业

满足以下任一条件时，优先使用 `job_start`，不要使用长时间阻塞的 `ssh_exec`：

- 预计超过约 30 秒；
- Docker 镜像构建、完整编译、全量测试、仿真、回放或数据导入；
- 输出很多，需要分批读取日志；
- 任务必须在 MCP 调用结束、Claude 重启或 SSH 短暂断开后继续；
- 需要获得稳定的 `jobId`，后续查询、取消或继续分析。

标准流程：

```text
job_start
  → 保存 jobId
  → job_status
  → job_logs
  → succeeded / failed 后分析结果
  → job_cancel（只有确实需要终止时）
```

作业状态和日志保存在远端：

```text
/tmp/helix/jobs/<jobId>/
```

因此它不依赖原始 SSH Session 或 MCP 会话。远端主机重启后进程不会继续运行，并且 `/tmp` 可能被清理。

### 7.1 任务类型选择

`type` 用于分类、日志和 AI 路由，不改变底层执行机制：

- `build`：CMake、Ninja、Cargo、colcon、普通工程编译；
- `test`：单元测试、集成测试、回归测试；
- `docker-build`：`docker build`；
- `compose-build`：`docker compose build`；
- `deploy`：发布、迁移、安装和部署流程；
- `service`：需要持续一段时间的服务维护任务；
- `data`：数据导入、回填、转换和批处理；
- `simulation`：仿真、回放、benchmark；
- `run`：长时间运行的普通程序；
- `custom`：以上都不匹配的任务。

不要为 Maven、Cargo、Docker、colcon 等工具分别发明新的后台接口。统一调用 `job_start`，用 `type`、`name`、`cwd`、`env` 和 `sourceScripts` 表达差异。

### 7.2 启动作业

Docker Compose 构建示例：

```json
{
  "host": "Ubuntu22.04_developer",
  "type": "compose-build",
  "name": "QuantX dev image",
  "cwd": "/home/xxx/QuantX",
  "command": "docker compose -f docker/docker-compose.yml build dev"
}
```

普通编译示例：

```json
{
  "host": "Ubuntu22.04_developer",
  "type": "build",
  "name": "QuantX release build",
  "cwd": "/home/xxx/QuantX",
  "env": {
    "CARGO_TERM_COLOR": "never"
  },
  "command": "cargo build --release"
}
```

需要 root 权限的长任务设置：

```json
{
  "useSudo": true
}
```

`startTimeoutSeconds` 只控制“创建远端后台作业”这一步，不控制作业本身的运行时长。

### 7.3 查询状态

调用：

```text
job_status(host, jobId)
```

状态含义：

- `queued`：作业目录已创建，后台进程正在启动；
- `running`：进程仍在运行；
- `succeeded`：退出码为 0；
- `failed`：退出码非 0；
- `cancelled`：已通过 `job_cancel` 终止；
- `lost`：记录存在，但进程和退出码都不可确认；
- `not_found`：远端不存在该作业记录。

### 7.4 查询日志

首次查看最近日志：

```json
{
  "host": "Ubuntu22.04_developer",
  "jobId": "job-...",
  "lines": 100
}
```

持续跟踪时，保存 `job_logs` 返回的 `nextCursor`，下一次传入：

```json
{
  "host": "Ubuntu22.04_developer",
  "jobId": "job-...",
  "cursor": 12345
}
```

这样只返回新增字节，避免重复日志占用 token。不要每次都重新读取完整构建日志。

### 7.5 取消作业

调用：

```text
job_cancel(host, jobId)
```

默认先对进程组发送 TERM，等待 5 秒，仍未退出才发送 KILL。通过 `useSudo=true` 启动的作业会自动使用 sudo 取消。

不要用 `ssh_exec` 手工拼接 `kill`、PID 文件和 `tail`，除非作业记录已经损坏且正在做故障诊断。

## 8. 危险命令保护

Helix 只保留一个轻量的防误操作 guard。它会在普通 SSH、直接 sudo、持久作业、Docker 和 Compose 命令执行前拦截明显危险的命令，包括：

- `rm`；
- `find -delete`；
- `shred`、`wipefs`；
- `mkfs`、`fdisk`、`sfdisk`、`cfdisk`、`parted`；
- `dd ... of=/dev/...`；
- 重定向写入块设备；
- `shutdown`、`poweroff`、`halt`、`reboot`；
- `systemctl reboot/poweroff/halt/kexec`；
- 终止 PID 1；
- fork bomb。

命令被 guard 拒绝后，不得通过编码、嵌套 shell、拆分命令或别名绕过。

这个 guard 是防误操作措施，不是完整的远端 shell 沙箱。

## 9. Docker 与 Compose

推荐流程：

```text
environment_probe
  → docker_list / compose_ps
  → 短操作：docker_exec / compose_exec
  → 长构建或长测试：job_start(type=docker-build/compose-build/test)
```

需要主机级 sudo Docker 短命令时使用 `sudo_exec`；长命令使用 `job_start(useSudo=true)`。

容器内命令同样经过危险命令 guard。

## 10. 文件传输

使用：

```text
ssh_upload
ssh_download
```

Harness 主机默认允许远端根目录 `/`，因此不会因远端路径白名单中断传输。默认本地范围为：

- Linux/macOS：本地根目录；
- Windows：当前目录、用户目录和临时目录所在盘。

设置 `HELIX_LOCAL_PATH_ROOTS` 可主动缩小本地传输范围。

## 11. 编译与调试

推荐顺序：

```text
ssh_check
  → environment_probe
  → 确认源码和容器
  → source 环境
  → 短诊断使用 ssh_exec
  → 完整构建使用 job_start
  → job_status / job_logs
  → 分析第一个有意义的错误
  → 最小诊断
  → 必要时 sudo_exec 或 job_start(useSudo=true)
```

不要在未分析错误前反复执行完整构建，也不要因为 Broker 调用超时就重复启动同一个构建。先使用返回的 `jobId` 查询状态。

## 12. 完成报告

至少说明：

- 使用的 alias 和 `username@hostname`；
- 主机、Docker 容器或 Compose service；
- 关键命令与退出码；
- cwd、sourceScripts 和环境变量；
- 上传或修改的文件；
- 是否使用 `sudo_exec`；
- 长任务的 `jobId`、type、最终状态和日志结论；
- 是否有命令被危险命令 guard 拦截；
- 剩余问题与下一步。
