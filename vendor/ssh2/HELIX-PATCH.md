# HELIX PATCH — ssh2 0.9.6

本目录是 `ssh2 0.9.6` 的 vendored 副本，根 `Cargo.toml` 通过 `[patch.crates-io]` 指向它。

## 补丁内容

### 1. `src/sftp.rs`：暴露 `posix-rename@openssh.com`

新增 `extern "C"` 声明与 `Sftp::posix_rename(&self, src: &Path, dst: &Path)`。

原因：`libssh2` 只在 SFTP 协议 v5+ 才发送 `SSH_FXP_RENAME` 的 flags 字段；OpenSSH 一直只协商 v3，
所以 `OVERWRITE` 被静默丢弃，覆盖已存在目标一律失败。`posix-rename@openssh.com` 是 OpenSSH
为这种情况提供的扩展。

### 2. 长度参数必须是 `size_t`

C 原型：

```c
int libssh2_sftp_posix_rename_ex(
    LIBSSH2_SFTP *sftp,
    const char *source_filename, size_t source_filename_len,
    const char *dest_filename,   size_t dest_filename_len);
```

旁边的 `libssh2_sftp_unlink_ex` 用的是 `unsigned int`。照抄成 `c_uint` 会在 x86-64 Windows
上留下垃圾高位并触发 `LIBSSH2_ERROR_OUT_OF_BOUNDARY (-41)`；Linux SysV 调用约定恰好清零高位，
所以 Linux 测不出该缺陷。**升级 ssh2 时必须保持 `size_t`。**

## 升级 ssh2 的步骤

1. 用新版本覆盖 `vendor/ssh2/`
2. 重新应用上述两处改动（extern 声明 + `posix_rename` 方法，长度为 `size_t`）
3. `cargo build` 后确认 `crates/helix-transport-ssh` 仍能链接该符号
4. Windows 真机执行一次“覆盖已存在文件”的上传
