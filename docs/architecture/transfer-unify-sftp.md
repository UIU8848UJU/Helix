# 传输统一：密钥认证与 transferBackend

本文件记录协议 v6（`identity_file_v1`）引入后的传输分派规则。

## 认证分派

| 主机配置 | daemon 行为 |
|---|---|
| 无 `identityFile` | 从 Windows Credential Manager 读取密码，`userauth_password` |
| 有 `identityFile` | 不读取凭据，`userauth_pubkey_file` |

`auth.rs` 在建立连接**之前**校验密钥路径：

| 情况 | 错误码 |
|---|---|
| 空路径或文件不存在 | `IDENTITY_FILE_MISSING` |
| 以 `~` 开头 | `IDENTITY_FILE_UNREADABLE`（daemon 不展开 `~`） |
| 文件不可读 | `IDENTITY_FILE_UNREADABLE` |
| 含 `ENCRYPTED` 的私钥 | `IDENTITY_FILE_ENCRYPTED` |

`~` 由**客户端**展开（`expandHomePath`）；daemon 的 home 是服务账号的。

## transferBackend

| 值 | 行为 |
|---|---|
| `auto`（默认） | `windows-credential` 主机走 broker SFTP；其余走外部 `scp`（历史行为） |
| `scp` | 强制外部 `scp` 子进程；仅适用于 `openssh` 认证主机 |
| `broker` | 强制 daemon SFTP；`openssh` 认证主机必须配置 `identityFile` |

配置校验规则：

- `transferBackend=broker` + `auth.type=openssh` + 无 `identityFile` → 拒绝
- `transferBackend=scp` + `auth.type=windows-credential` → 拒绝（scp 无法非交互提供密码）

## 与会话池的关系

`SessionKey` 包含 `identityFile`，切换密钥不会复用旧会话。密钥主机的 `acquire()` 跳过
`credential::read`，因此“凭据不存在”不会再误伤密钥主机。

## 协议字段

`identity_file` 出现在六个操作上：`execute`、`pty`、`sudo_execute`、`upload`、
`download`、`terminal_open`。字段为 `Option` + `serde(default)`，旧客户端请求保持可解析；
客户端只有在密钥主机上才发送该键。协议版本 6，能力集新增 `identity_file_v1`。

`transferBackend` 是**配置/客户端本地字段**，不进入请求 JSON（daemon 使用
`deny_unknown_fields`，未知字段会导致反序列化失败）。
