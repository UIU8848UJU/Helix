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

## 2. 可用性优先的变更分级

Helix 不会用安全开关阻断正常使用，而是只拦真正的策略扩权。

### 主机生命周期层

个人模式默认开启，允许用户明确要求后的正常操作：

- `host_onboard` / `host_offboard`；
- 修改 hostname、port、username、identityFile、proxyJump、tags；
- 使用标准的 `Helix/ssh/<alias>/login` 和 `Helix/ssh/<alias>/sudo`；
- 使用 `/home/<username>`、`/workspace`、`/tmp/helix`、`/opt/ros`；
- 生成本地凭据录入、状态检查和删除请求。

AI 应直接使用工具，不应先要求用户手改 `ssh-mcp.json`。

### 安全策略层

默认关闭，只保护真正扩大权限或削弱保护的变更：

- 增加安全默认范围以外的远端根目录；
- 新增 sudo allowlist 规则；
- 替换已有主机的认证方式或 credential reference；
- 延长 sudo 审批有效时间；
- 关闭严格主机密钥校验或审计。

AI 遇到拒绝时先调用：

```text
mutation_capabilities
```

只有确实需要上述变更时，才说明具体旧值、新值和影响，并请求开启 `allowPolicyMutation`。不得把普通新增主机、修改 IP 或录入密码误报成策略扩权。

## 3. AI 必须遵守的规则

1. 正常远程操作、排障和主机生命周期管理时，不得直接编辑 `ssh-mcp.json`。
2. 不得要求用户把登录密码或 sudo 密码粘贴进对话。
3. 不得输出、读取或记录明文凭据；只能通过 `credential_status` 检查凭据是否存在。
4. 新增主机优先使用 `host_onboard`，删除主机优先使用 `host_offboard`。
5. `ssh_exec`、`docker_exec`、`compose_exec` 都是非特权执行工具，不得在命令中偷偷加入 `sudo`。
6. 需要 sudo 时必须走 `sudo_request → 本地人工审批 → sudo_execute`。
7. `sudo_request` 返回后，AI 必须把 `approvalCommand` 和完整命令展示给用户，然后停止。
8. 只有用户明确表示已经在本地完成审批后，AI 才能调用 `sudo_execute`。
9. `sudo_execute` 的 host、requestId 和 command 必须与审批请求完全一致。
10. allowlist、路径或主机密钥校验失败时，应报告准确边界，不得通过拆命令、混淆命令或切换工具绕过。
11. `credential_enroll_request` 或 `credential_delete_request` 返回本地命令后，AI 必须展示命令并停止，不能代替用户输入或删除密码。

## 4. 标准连接流程

AI 应按以下顺序操作：

```text
host_list
  → host_get（需要确认详细配置时）
  → credential_status（密码认证主机）
  → ssh_check
  → environment_probe（陌生环境）
  → 具体操作工具
```

### 添加新主机

```text
mutation_capabilities
  → host_onboard
  → credential_enroll_request（密码认证）
  → 展示 enrollmentCommand 并停止
  → 用户本地录入
  → credential_status
  → ssh_check
```

`host_onboard` 会自动生成标准凭据引用和实用的安全默认路径。不要改用 `host_add` 手工拼 credentialRef，除非有明确的底层管理需求。

### 登录失败时

依次检查：

- 选中的是否是正确 alias；
- hostname 是否是正确 IP/域名；
- username 是否是正确 SSH 用户；
- `credential_status` 是否显示凭据存在；
- 网络和 22 端口是否可达；
- known_hosts/主机密钥是否匹配；
- 错误来自认证、网络、主机密钥还是策略。

用户明确要求修正 hostname、port 或 username 时，可以直接使用 `host_update`；不要要求用户先修改 JSON。

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

command 必须是最终完整命令，不能先申请一个宽泛 shell，再在 shell 内执行其他内容。

### 阶段二：人工审批

AI 必须把 `approvalCommand` 原样展示给用户并停止。

用户在独立本地终端核对主机、完整命令、理由和过期时间，确认无误后输入：

```text
APPROVE
```

### 阶段三：执行

用户明确回复“已经批准”后，AI 调用：

```text
sudo_execute(host, requestId, exact_same_command)
```

审批是本地完成、有效期有限、绑定主机、绑定完整命令哈希且只能消费一次。

### allowlist 拒绝

新增 sudo 规则属于安全策略层。AI 应报告被拒绝的完整命令和建议的最窄锚定规则，不得自动修改规则、拆分命令、编码或使用更宽的 shell 绕过。

## 8. 文件传输

使用：

- `ssh_upload`
- `ssh_download`

规则：

- 优先使用绝对路径；
- 目录传输时才设置 `recursive=true`；
- 本地路径必须位于允许根目录；
- 默认远端路径包括用户 home、`/workspace`、`/tmp/helix`、`/opt/ros`；
- 增加其他远端根目录属于安全策略层。

## 9. Docker 与 Compose

推荐流程：

```text
environment_probe
  → docker_list / compose_ps
  → docker_exec / compose_exec
```

`docker_exec` 和 `compose_exec` 支持 cwd、env、sourceScripts、user 和 shell。它们本身不是 sudo 工具。如果远端 Docker 需要 root，应针对最终完整 Docker 命令走 reviewed sudo 流程。

## 10. 远程编译推荐流程

1. `host_list` 选择 alias。
2. `ssh_check` 验证连接。
3. `environment_probe` 读取 OS、架构、Docker、编译器和 source 脚本。
4. 确认代码位于允许路径；需要时使用 `ssh_upload`。
5. 需要容器时先 `docker_list` 或 `compose_ps`。
6. 使用 `ssh_exec`、`docker_exec` 或 `compose_exec` 运行构建。
7. 构建失败时先分析 stderr 和退出码，再执行最小诊断命令。
8. 只有明确需要系统权限时才申请 sudo。
9. 输出编译结果、失败阶段、日志位置和下一步建议。

## 11. `helix_help`

AI 不确定流程时，应主动调用：

```text
helix_help(topic)
```

配置变更相关优先使用：

```text
helix_help({ "topic": "configuration" })
mutation_capabilities()
```

MCP 返回内容比这份静态文件更适合当前 Agent 直接消费。该文件用于人工阅读、离线检查和审计。

## 12. 人工提示词示例

### 添加主机

```text
使用 helix-ssh 添加主机。先调用 mutation_capabilities，然后使用 host_onboard。正常生命周期操作直接执行，不要让我修改 JSON。只有确实涉及额外路径或 sudo 规则时才说明具体策略扩权。密码通过 credential_enroll_request 在本地录入。
```

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
检查 jetson-dev 为什么无法登录。按 host_get、credential_status、ssh_check 的顺序排查。修正 hostname、port 或 username 时使用 host_update，不要直接编辑配置文件。
```
