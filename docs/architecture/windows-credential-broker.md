# Helix Windows Credential Broker

## 1. 目的

`helix-credential-broker.exe` 是 Helix 的本地高安全执行边界，用于处理无法使用 SSH 私钥的 Windows 单机内网场景。

TypeScript SSH MCP 不读取、返回或记录明文密码。密码只由 Rust Broker 从 Windows Credential Manager 读取，并直接用于 SSH 密码认证、SFTP 或审核后的 `sudo -S` 标准输入。

```text
AI / MCP Client
  -> Helix SSH MCP (host + command, no password)
  -> helix-credential-broker.exe
  -> Windows Credential Manager
  -> SSH / SFTP / sudo stdin
```

Broker 不提供 `get_password`、`decrypt_password` 或输出秘密的接口。

## 2. 构建

需要 Rust 1.85+：

```powershell
cargo build --release --manifest-path apps/credential-broker/Cargo.toml
```

产物：

```text
apps/credential-broker/target/release/helix-credential-broker.exe
```

运行环境只需要编译后的 EXE；内网机器不一定需要安装 Rust。

## 3. 录入凭据

登录密码：

```powershell
helix-credential-broker.exe credential-store `
  --target "Helix/ssh/build-password/login" `
  --username "developer"
```

sudo 密码：

```powershell
helix-credential-broker.exe credential-store `
  --target "Helix/ssh/build-password/sudo" `
  --username "developer"
```

密码通过隐藏终端输入读取，不进入命令行参数、环境变量或配置文件。

检查是否存在：

```powershell
helix-credential-broker.exe credential-exists `
  --target "Helix/ssh/build-password/login"
```

删除：

```powershell
helix-credential-broker.exe credential-delete `
  --target "Helix/ssh/build-password/login"
```

## 4. 主机配置

```json
{
  "hostname": "10.0.0.30",
  "port": 22,
  "username": "developer",
  "allowedRemotePaths": ["/workspace", "/tmp/helix"],
  "auth": {
    "type": "windows-credential",
    "credentialRef": "Helix/ssh/build-password/login"
  },
  "sudo": {
    "mode": "reviewed-password",
    "credentialRef": "Helix/ssh/build-password/sudo",
    "allow": [
      "^systemctl restart test-[A-Za-z0-9_.@-]+$"
    ],
    "approvalTtlSeconds": 300
  }
}
```

`settings.credentialBrokerPath` 或环境变量 `HELIX_CREDENTIAL_BROKER` 指向 Broker EXE。

## 5. sudo 审批流程

1. AI 调用 `sudo_request(host, command, reason)`。
2. MCP 校验主机级锚定正则 allowlist，并创建只读待审 JSON 文件。
3. 用户在本地终端运行工具返回的 `approvalCommand`。
4. Broker 显示主机、用户、完整命令、理由和过期时间。
5. 用户输入大写 `APPROVE`。
6. Broker 将绑定 `requestId + hostAlias + commandHash + expiry` 的一次性批准记录写入 Windows Credential Manager。
7. AI 调用 `sudo_execute`，命令必须与待审文件逐字一致。
8. Broker 消费并删除批准记录，然后执行命令；记录不能重放。

密码 sudo 使用：

```text
sudo -k -S -p <unique prompt> -- sh -lc <approved command>
```

密码只写入 SSH Channel 的 stdin，不拼接到远程命令中。

`reviewed-nopasswd` 同样要求人工审批，但最终使用 `sudo -n` 和远端精确 sudoers/NOPASSWD 权限。

## 6. 安全边界

- 配置仅保存 `credentialRef`。
- MCP JSON-RPC 不携带密码。
- Broker stdout 只返回执行结果。
- 凭据缓冲区使用 `zeroize` 包装并尽量缩短生命周期。
- 严格主机指纹检查默认开启，密码后端读取当前用户的 `~/.ssh/known_hosts`。
- sudo 必须同时通过 allowlist、待审文件、一次性批准 token 和命令哈希校验。
- 批准必须在独立本地终端完成，不提供 MCP 审批工具，避免 AI 自我批准。

该设计不能防御已经完全控制当前 Windows 用户或拥有管理员/调试权限的恶意程序；它主要防止密码进入源码、配置、日志、命令行和模型上下文。
