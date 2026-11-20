# 测试与验证标准

> 本文件记录 Helix 原子传输（protocol v7）与进度/watch 能力的测试范围、方法标准和最近一次验证结果。
> 最近验证：2026-11-20，提交 `0c6835b`。

## 1. 采用的测试标准

采用 **testing-workflow 1.0**（STANDARD profile），完整链路：

| 阶段 | 动作 | 本次结果 |
|---|---|---|
| Intake | 固定源 revision、目标环境、范围与风险 | STANDARD（真实 OS/网络；写入限定临时目录） |
| Scenario Discovery | 独立 Scenario Explorer 产出输入面/维度/向量/oracle | 4 个输入面、32 cases、43 场景行 |
| G01 Coverage Review | 检查漏测、无效 N/A、oracle 来源 | READY |
| G02 User Selection | 展示 MUST/RECOMMENDED/OPTIONAL 并由用户选定 | APPROVED（全部 MUST + 可执行 RECOMMENDED） |
| G03 Readiness | 核验 revision/环境/凭据/命令 | 通过 |
| Execute | 用项目原生 runner 执行并保存原始日志 | 见第 4 节 |
| G04 Evidence | 逐 case 日志、退出码、复现路径 | 见 `.skillmatrix/testing/runs/` |
| G05 Decision | PASS/FAIL/BLOCKED/INCONCLUSIVE + regression claim | 见第 6 节 |

工件（本地、gitignored）：

```text
.skillmatrix/testing/runs/helix-sftp-atomic-progress-20261120/
  test-plan.json           # 32 cases，digest 绑定
  test-approval.json       # 用户选定
  test-results.json        # 逐 case 结果
  test-report.md
  raw/                     # 原始日志
  checkpoint.yaml
```

### Oracle 原则

- 优先**确定性断言**：最终内容 SHA-256、失败后无 `.helix.part`、进度 `total` 恒定且最终 `done == total`。
- 并发读者采用**有界采样**：只允许观察到旧内容或新内容，任何 `MISSING` 即失败；未观察到重叠时标记 INCONCLUSIVE，不伪造 PASS。
- 负向用例（预期非零退出）在 v2 工件合同中无法表达，报告中单独说明。

## 2. 被测能力

1. **原子覆盖**：写 `<target>.helix.part.<taskId>` → `posix-rename@openssh.com` 落位；无扩展时回退 unlink+rename；失败统一清理。
2. **进度**：任务池 `done/total/version` 原子量；首次上报必唤醒 watcher，之后 100ms 节流；`task_watch(since_version)` 在版本推进/终态/超时返回。
3. **取消**：分块循环内复查取消与 deadline；只删除 `.part`，不改动已落地文件。
4. **目录语义**：递归合并（不镜像）、整树单一 total、逐文件偏移累加。
5. **边界**：空文件/空目录、大量小文件、Unicode/空格/元字符文件名、深目录、符号链接拒绝。
6. **错误码**：`CREDENTIAL_MISSING`、`AUTH_FAILED`、`TRANSFER_CANCELLED`、`TRANSFER_TIMEOUT`。
7. **CI 契约**：测试必须真正在 CI 执行，跳过必须失败。

## 3. 测试分层与环境

| 层 | runner | 环境 | 说明 |
|---|---|---|---|
| Unit | `cargo test` | 本机 Windows / CI ubuntu+windows | 纯逻辑与假实现，确定性 |
| Protocol contract | `npm run protocol:contract` | CI ubuntu | 25 个 TS 请求被 Rust serde 解析 |
| Integration E2E | `python scripts/e2e-sftp-recursive.py` | Linux 实机 + CI Docker OpenSSH | 直连 helixd JSON IPC |
| Windows real-host E2E | `verify-windows.mjs`（本地验证脚本） | Windows 10 + Win32-OpenSSH | 验证 `size_t` ABI 与 Windows 文件语义 |

真机环境：

- Linux：Ubuntu 22.04（OpenSSH 支持 `posix-rename@openssh.com`）
- Windows：Windows 10 19045，Win32-OpenSSH，AMD64
- 凭据：Windows Credential Manager（密码）与 RSA 私钥（`identity_file`）

## 4. 最近一次结果

提交：`0c6835b`（源基线 `3cfbc62` + 本次修复）

| 套件 | 命令 | 结果 |
|---|---|---|
| Rust workspace | `cargo test --workspace` | 91 + 7 + 29 + 14 passed，0 failed，8 ignored |
| 格式 / lint | `cargo fmt --check`、`cargo clippy -D warnings` | 0 |
| TS 单元 | `npm run test --workspace @helix/ssh-mcp` | 144 passed / 8 skipped |
| TS 类型/构建 | `npm run check`、`npm run build` | 0 |
| 协议契约 | `npm run protocol:contract` | 25/25 |
| Linux E2E | `HELIX_SFTP_E2E=1 python scripts/e2e-sftp-recursive.py` | **70/70 PASS**（19.6s） |
| Windows E2E（本地） | `node verify-windows.mjs` | **31/31 PASS** |

### 新增单元断言

- `progress_notify_throttled_to_100ms`：假时钟 0 / 99 / 100ms 的精确通知边界
- `watch_since_version_contract`：since 领先时不提前返回；终态立即返回
- `task_response_progress_presence_and_endless_total`：version=0 无进度；未知 total 为 `None`
- `task_response_progress_sequence_is_monotonic`：版本与 done 单调
- `replace_local_file_overwrites_and_removes_part`：本地替换成功且清理 part
- `empty_copy_reports_zero_bytes_once`：零字节最终上报 `(0, Some(0))`
- `local_symlink_is_rejected`（Unix）：符号链接拒绝

### Linux E2E 覆盖（70 项断言）

单文件/递归往返、目录合并、覆盖、取消无残留、`recursive=false` 拒绝、改名失败清理、整树进度、**同尺寸覆盖**、**并发读者（零 MISSING，观察到新旧两态）**、空文件 0/0 进度、空目录、120 个小文件、Unicode/空格/emoji/全角文件名、元字符文件名、40 层深目录、不可写父目录、本地/远端符号链接拒绝、下载侧整树进度、下载取消保留旧文件、取消后会话复用、并发写者、运行时预算。

### Windows E2E 覆盖（31 项断言）

中文/`-EncodedCommand` UTF-8 输出、上传/下载往返、同尺寸覆盖（`size_t` ABI）、递归进度、取消无残留、空文件、Unicode 文件名、下载侧进度、改名失败清理、下载取消保留本地文件、取消后复用。

## 5. CI 强制断言

`.github/workflows/ci.yml` 中与本能力相关的 job：

| job | 作用 |
|---|---|
| `protocol-contract` | TS → Rust serde 契约（25 请求） |
| `helixd`（ubuntu + windows） | `cargo test --release --workspace`，包含新增单元测试 |
| `ssh-runtime-e2e` | 现有 SSH 运行时 E2E |
| `sftp-recursive-e2e` | Docker OpenSSH + `--features test-credentials` daemon + 扩展脚本 |

关键约束：`sftp-recursive-e2e` 设置 `HELIX_SFTP_E2E_REQUIRE=1`。未设置 `HELIX_SFTP_E2E=1` 时脚本退出码为 1，防止环境变量丢失导致 job 假绿。

## 6. 结论与限制

- 软件断言：**无失败**；32 个批准用例均已执行。
- 工件门禁 verdict：**BLOCKED**，原因仅两条：
  - `U6` 为 `cfg(unix)` 单测，本机 Windows 不编译；CI ubuntu job 会执行，但本次尚未运行。
  - `C2` 为“预期非零退出”的守卫用例，`commercial_gate` v2 无法表达该语义，记为 BLOCKED。
- `regression_claim = NOT_ASSESSED`：没有同环境历史基线。
- 已知限制：
  - ed25519 密钥受 libssh2 构建能力限制（RSA 已验证）；系统 `ssh` 可用不代表 libssh2 可用。
  - 无 `posix-rename` 服务器的回退路径无法在当前测试服务器触发。
  - Windows 本地替换在 rename 失败时才删除目标（非严格原子）；Windows 真机 E2E 目前不在 CI 中。
  - 255 字节文件名叠加 `.part` 后缀可能超过 `NAME_MAX`，未作为必测项。

## 7. 复现

```bash
# 本地全量门禁
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run check
npm test --workspace @helix/ssh-mcp
npm run build --workspace @helix/ssh-mcp
npm run protocol:contract

# Linux 真机 / CI 同款
cargo build -p helixd
HELIX_SFTP_E2E=1 \
HELIX_SFTP_HOST=<host> HELIX_SFTP_PORT=22 HELIX_SFTP_USER=<user> \
HELIX_TEST_CREDENTIAL_TARGET=<credential-ref> \
HELIX_BROKER_ENDPOINT=<pipe-or-socket> \
python scripts/e2e-sftp-recursive.py

# CI 守卫自检（预期退出码 1）
HELIX_SFTP_E2E_REQUIRE=1 python scripts/e2e-sftp-recursive.py
```
