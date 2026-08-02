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
10. `host_add`、`host_update`、`host_remove` 只用于用户明确发起的管理员配置任务。

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

## 4. 普通命令

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

## 5. sudo 人工审批

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
- 完整 sudo 命令；
- AI 提供的理由；
- 过期时间。

确认无误后输入大写：

```text
APPROVE
```

### 阶段三：执行

用户明确回复“已经批准”后，AI 调用：

```text
sudo_execute(host, requestId, exact_same_command)
```

审批是：

- 本地完成；
- 有效期有限；
- 绑定主机；
- 绑定完整命令哈希；
- 只能消费一次。

### allowlist 拒绝

AI 应报告：

- 被拒绝的完整命令；
- 当前主机 sudo 策略不允许；
- 管理员需要添加哪一类锚定规则。

AI 不得：

- 自动修改 `sudo.allow`；
- 把一条命令拆成几条以绕过规则；
- 使用编码、变量、通配符或 shell 包装绕过审核；
- 把命令改成允许但语义更宽的 shell。

## 6. 文件传输

使用：

- `ssh_upload`
- `ssh_download`

规则：

- 优先使用绝对路径；
- 目录传输时才设置 `recursive=true`；
- 本地路径必须位于允许根目录；
- 远端路径必须位于该主机 `allowedRemotePaths`；
- 路径被拒绝时，不得自动扩大白名单。

## 7. Docker 与 Compose

推荐流程：

```text
environment_probe
  → docker_list / compose_ps
  → docker_exec / compose_exec
```

`docker_exec` 和 `compose_exec` 支持：

- cwd
- env
- sourceScripts
- user
- shell

它们本身不是 sudo 工具。如果远端 Docker 需要 root，应针对最终完整 Docker 命令走 reviewed sudo 流程，而不是在容器执行工具里嵌入 sudo。

## 8. 远程编译推荐流程

1. `host_list` 选择 alias。
2. `ssh_check` 验证连接。
3. `environment_probe` 读取 OS、架构、Docker、编译器和 source 脚本。
4. 确认代码位于允许路径；需要时使用 `ssh_upload`。
5. 需要容器时先 `docker_list` 或 `compose_ps`。
6. 使用 `ssh_exec`、`docker_exec` 或 `compose_exec` 运行构建。
7. 构建失败时先分析 stderr 和退出码，再执行最小诊断命令。
8. 只有明确需要系统权限时才申请 sudo。
9. 输出编译结果、失败阶段、日志位置和下一步建议。

## 9. 配置变更

配置变更是独立的管理员任务。开始前 AI 必须说明：

- 要改哪个 host alias；
- 要改哪个字段；
- 为什么需要改；
- 会扩大还是收紧权限；
- 是否涉及凭据引用、路径或 sudo allowlist。

用户明确同意后才使用：

- `host_add`
- `host_update`
- `host_remove`

配置只保存 credential reference，不保存明文密码。

## 10. `helix_help`

AI 不确定流程时，应主动调用：

```text
helix_help(topic)
```

支持 topic：

- `overview`
- `connect`
- `exec`
- `sudo`
- `transfer`
- `docker`
- `configuration`
- `troubleshooting`

MCP 返回内容比这份静态文件更适合当前 Agent 直接消费。该文件用于人工阅读、离线检查和审计。

## 11. 人工提示词示例

### 普通远程任务

```text
使用 helix-ssh 在 jetson-dev 上检查环境并编译项目。先做 ssh_check 和 environment_probe，不要修改 Helix JSON；普通命令使用 ssh_exec，需要权限时走 sudo_request 并停下来等我审批。
```

### sudo 任务

```text
在 jetson-dev 上重启 test-agent 服务。必须使用 sudo_request → 本地人工审批 → sudo_execute；返回 approvalCommand 后停止，等我明确说已经批准。
```

### 排障任务

```text
检查 jetson-dev 为什么无法登录。按 host_get、credential_status、ssh_check 的顺序排查，只报告发现，不要自动修改 username、hostname 或 credentialRef。
```
