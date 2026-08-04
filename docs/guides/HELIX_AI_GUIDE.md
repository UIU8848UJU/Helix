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
```

这意味着 AI 可以直接：

- 新增、修改和删除主机；
- 修改远端路径与认证配置；
- 运行普通 SSH、Docker、Compose 和 sudo 命令；
- 使用 `sudo_exec`，无需 sudo allowlist、审批请求、确认 token 或过期时间。

需要集中锁定时使用：

```powershell
.\scripts\install.ps1 -DeploymentMode EnterpriseLocked
```

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
  → 执行任务
```

凭据不存在时，在 Windows 上调用 `credential_enroll_launch`。

## 5. 普通命令

使用：

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
command: colcon build
```

## 6. sudo 命令

需要 sudo 时直接调用：

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

## 7. 危险命令保护

Helix 只保留一个轻量的防误操作 guard。它会在普通 SSH、直接 sudo、Docker 和 Compose 命令执行前拦截明显危险的命令，包括：

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

## 8. Docker 与 Compose

推荐流程：

```text
environment_probe
  → docker_list / compose_ps
  → docker_exec / compose_exec
```

需要主机级 sudo Docker 命令时直接使用 `sudo_exec`。

容器内命令同样经过危险命令 guard。

## 9. 文件传输

使用：

```text
ssh_upload
ssh_download
```

路径需要位于 `allowedRemotePaths` 和本地允许根目录中。Harness 模式允许 AI 根据用户任务通过 `host_update` 调整路径。

## 10. 编译与调试

推荐顺序：

```text
ssh_check
  → environment_probe
  → 确认源码和容器
  → source 环境
  → 执行构建
  → 分析第一个有意义的错误
  → 最小诊断
  → 必要时 sudo_exec
```

不要在未分析错误前反复执行完整构建。

## 11. 完成报告

至少说明：

- 使用的 alias 和 `username@hostname`；
- 主机、Docker 容器或 Compose service；
- 关键命令与退出码；
- cwd、sourceScripts 和环境变量；
- 上传或修改的文件；
- 是否使用 `sudo_exec`；
- 是否有命令被危险命令 guard 拦截；
- 剩余问题与下一步。
