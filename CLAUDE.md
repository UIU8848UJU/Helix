# CLAUDE.md — Helix 项目规则

> 本文件是 Claude Code 在本仓库的默认行为约定。冲突时优先级：**用户手写规则 > 本文件 > 通用习惯**。

## 0. 用户项目规则（在此填写）

<!-- 用户在此填写自定义规则。留空表示全部使用下方默认规则。 -->

## 1. 项目定位

Helix = 面向 AI Agent 的远程执行与会话 Runtime，不是业务编排器。

- 核心只提供稳定能力（SSH exec/PTY/SFTP/task/job、HTTP request、Browser），业务逻辑放在 Skill/SOP
- SSH 是第一个 Transport；`apps/ssh-mcp`、`apps/http-mcp`、`apps/browser-mcp` 是并列能力层
- 不把编译、部署、诊断等流程写死进 MCP

## 2. 三层生命周期（禁止合并成一个万能 Task）

| ID | 含义 | 生命周期 | 归属 |
|---|---|---|---|
| TaskID | 本机任务调度 | 毫秒 ~ 几十秒 | 有界任务池 / worker 池 |
| TerminalID | 持久交互 PTY | 分钟 ~ 小时 | Terminal Runtime |
| JobID | 远端后台作业 | 分钟 ~ 天 | Remote Job Runtime |

## 3. 仓库结构

```text
apps/ssh-mcp/          TypeScript MCP 控制层（协议客户端、工具注册、guidance）
apps/http-mcp/         独立 HTTP MCP（策略、过滤、审计）
apps/browser-mcp/      Playwright 浏览器 Runtime
apps/helixd/           Rust 常驻 daemon（协议服务、engine 接线）
crates/helix-core/     协议、任务池、终端、传输抽象、输出解码
crates/helix-credential/ Windows 凭据存储
crates/helix-transport-ssh/ SSH Transport（exec/PTY/SFTP/sudo/auth）
docs/                  架构与实现文档（docs/superpowers/ 放设计与计划）
development/           TDD 工作区（tdd_state.yaml、cycles/、evidence/）
scripts/               安装、注册、E2E 脚本
```

## 4. 构建 / 测试命令（改动前后必须跑）

| 范围 | 命令 |
|---|---|
| Rust 全量 | `cargo test --workspace` |
| 单 crate | `cargo test -p helix-core` / `-p helix-transport-ssh` / `-p helixd` |
| Rust 格式 / lint | `cargo fmt --all -- --check`；`cargo clippy --workspace -- -D warnings` |
| TS 全量 | `npm run test` / `npm run check` / `npm run build` |
| ssh-mcp | `npm run test --workspace @helix/ssh-mcp`（vitest）；`npx tsc --noEmit -p apps/ssh-mcp` |
| 协议契约 | `npm run protocol:contract` |
| E2E SFTP | `python scripts/e2e-sftp-recursive.py`（需真实 sshd） |

真实主机相关测试（127.0.0.1:2222 / 凭据后端）属环境前提，失败时要如实区分"环境缺失"和"代码回归"。

## 5. TDD 工作流（硬性）

1. **RED**：先写失败测试，实际运行并保存真实失败输出
2. **GREEN**：只写让该测试通过的最小实现
3. **REFACTOR**：保持全绿的前提下重构
4. 每个切片都要跑：目标测试 → 受影响范围回归 → 全 workspace / 全 TS
5. 证据写入 `development/evidence/`，以实际命令输出为准，**禁止伪造或推测测试结果**
6. 确实无法先测的场景（真机 OpenSSH/SFTP、Windows ABI）必须单独标记为 INTEGRATION/真机验证，并写明"未验证"
7. 禁止"先实现后补测试"冒充 TDD

## 6. 提交与工作区纪律

- 未经用户明确指示：**不 commit、不 push、不发布、不安装包**
- 不使用 `git add -A`；按文件名暂存
- 当前工作区存在用户进行中的改动（SSH backend 选择相关）与 `PLAAN2.md`，**默认不修改、不暂存、不清理**
- `PLAAN2.md` 为用户所有（`do_not_stage`）
- 提交信息用 conventional commits：`fix(scope): ...` / `feat(scope): ...` / `test(...)` / `docs(...)`

## 7. 协议兼容性

- 修改 daemon ↔ MCP 协议必须：bump 协议版本 + 在能力集合中登记新能力（如 `task_watch_v1`、`identity_file_v1`）
- daemon 与 MCP bundle 必须**一起重建**；旧 daemon 由能力握手明确拒绝，不允许静默降级
- 新字段对旧版本用 `serde(default)` 保持反序列化兼容
- daemon 请求类型**拒绝未知字段**：客户端本地标志（如 `detach`）不得上线到请求 JSON
- 请求键集有测试钉住时，改动必须同步更新测试

## 8. 跨平台规则（Linux 与 Windows 都必须成立）

- 测试矩阵：Linux（CI / 真机）+ Windows 11（真机）。只在单平台通过的结论必须标注
- **ABI 陷阱**：C 长度参数区分 `size_t` 与 `c_uint`；x86-64 SysV 在 Linux 上会清零寄存器高 32 位，Windows 上不会 —— 这类缺陷 Linux 永远测不出
- 路径：Windows `%APPDATA%\Helix\`，Linux/macOS `~/.config/Helix/`；注意 `HELIX_*` 环境变量覆盖
- 换行：仓库按 `.gitattributes` 使用 LF，不提交 CRLF
- 文件系统语义差异：Windows 无 POSIX 权限位、symlink/rename 行为不同；symlink 默认拒绝而不是跟随
- `~` 在**客户端**展开，daemon 侧不展开（daemon 的 home 是服务账号）

## 9. 配置文件规则

- 新增/修改配置项时必须同步：默认值、schema/类型、`examples/*.json` 示例、单元测试
- 配置文件安全默认值：`allowedDomains` 收窄、`allowPrivateNetworks` 默认 false、大小限制必填
- 凭据类配置只存引用（`credentialRef` / 凭据 target），不得存明文密码

## 10. 安全不变量

- 敏感 header（`Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`X-API-Key`）不得进入审计日志、错误信息、MCP 返回
- 密码不得进入聊天、MCP payload、命令行参数或日志；只经 Windows Credential Manager / helixd 代理
- SFTP 原子覆盖：写 `<target>.helix.part.<task id>`，成功后改名落位；**禁止**用"先删目标再改名"模拟原子性；任何失败路径都必须清理 `.part`
- 目录传输是**合并**（类似 `rsync` 不带 `--delete`），不是镜像
- SSRF：重定向后的目标地址必须重新执行协议/域名/DNS/IP/私网策略检查

## 11. 验证纪律

- 本地单测 ≠ 真机兼容。涉及 OpenSSH / SFTP / Windows OpenSSH 的结论必须真机验证，或明确写"未验证"
- 每次"验证通过"必须确认测的是哪个构建/二进制（历史教训：曾用错误构建验证通过）
- 失败路径的清理逻辑独立测试（写成功但改名失败也必须清理 `.part`）

## 12. 沟通

- 用中文回复；简洁，先结论和下一步
- 报告结果时给出：改了哪些文件、跑了什么命令、真实输出摘要、哪些未验证
