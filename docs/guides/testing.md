# Helix 测试方法与流程

> 适用范围：ssh-mcp / browser-mcp / helixd（Rust daemon）。发布前门禁必须全绿。
> 最近一次全绿基线：Rust 42 passed / 7 ignored；ssh-mcp 89 passed / 4 skipped；browser-mcp 53 passed。

## 1. 自动化门禁（发布前本地必跑）

在仓库根目录按以下顺序执行：

| 步骤 | 命令 | 覆盖 |
| --- | --- | --- |
| Rust 全量测试（release） | `cargo test --release --workspace` | helixd、helix-core、helix-credential、helix-transport-ssh |
| TS 类型检查 | `npm run check` | 全部 workspace |
| TS 单元测试 | `npm test` | ssh-mcp（含 spool 分块读、PTY 请求构建、凭证自动录入、broker v3 能力契约）、browser-mcp |
| TS 构建 | `npm run build` | `apps/*/build` 产物 |
| 单文件 bundle | `npx esbuild apps/ssh-mcp/src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/helix-ssh-mcp.bundle.mjs --log-level=warning` | 离线安装使用的 MCP server 单文件 |
| Daemon IPC 集成 | `node scripts/test-broker-daemon.mjs`（需先 `cargo build --release`） | v3 能力契约、owner-only 管道 ACL、64 连接读/写饱和、启动竞争收敛、大响应有界写 |
| PS 脚本行为 | `.\scripts\test-mcp-registration.ps1`、`.\scripts\test-helix-admin.ps1` | 注册/注销脚本与管理脚本的解析与行为 |

一键打包（自动按上述顺序跑门禁，任一步失败即中止）：

```powershell
.\scripts\build-beta.ps1 -Version 0.4.0-beta.1
```

## 2. CI 自动执行

`.github/workflows/ci.yml`，push 到 `main` / `agent/**` 与 PR 时触发，共 3 个 job：

- `ssh-mcp`：Node 20/22 上 `npm run check` + `npm test` + `npm run build`。
- `helixd`：ubuntu/windows 上 `cargo test --release --workspace` + `cargo build --release` + `node scripts/test-broker-daemon.mjs`；Windows 额外跑 PS 脚本解析、`test-mcp-registration.ps1`、`test-helix-admin.ps1`。
- `browser-mcp`：Node 20/22 上 Playwright Chromium + check/test/build。

## 3. 手工验证清单（自动化覆盖不到的）

- 离线安装：解压 `dist\helix-<version>-win-x64.zip`，在沙箱/干净环境运行 `.\install.ps1 -RegisterClient None`，确认无 cargo/npm 依赖；配置、guide、skill、admin 全部落盘，daemon 内容寻址命名 `helixd-<sha16>.exe`。
- Bundle 冒烟：`node dist\helix-ssh-mcp.bundle.mjs`，stdio 下发 `initialize` + `tools/list`，确认握手与工具列表正常。
- 真实 SSH 冒烟（需可联网目标机）：
  - win→linux 与 win→win：`host_add` 后 `ssh_exec`，检查返回、退出码、stderr。
  - PTY 交互：`ssh_pty` 分配真实 TTY，向远端交互提示符输入并读取输出。
  - 大文件：`scp`/SFTP 传输大文件并校验 SHA-256。
  - 大命令输出：超过 IPC 有界缓冲的输出走 spool 分块读，确认完整返回。
- 凭证弹窗：`credential_enroll` 触发 Windows 原生 Credential UI，确认前台弹窗、取消/输入密码两条路径正常。

## 4. beta 发布流程

1. `.\scripts\build-beta.ps1 -Version 0.4.0-beta.1`（自动跑门禁 + 组装包 + SHA256SUMS + zip）。
2. 按第 3 节沙箱验证离线安装与 bundle 冒烟。
3. 提交脚本与本文档：`scripts/build-beta.ps1`、`scripts/install-beta.ps1`、`docs/guides/testing.md`，分步 commit 并 push。
4. 打标签：`git tag v0.4.0-beta.1` + `git push origin v0.4.0-beta.1`。
5. GitHub Release（prerelease）：上传 `dist\helix-0.4.0-beta.1-win-x64.zip` 并附 SHA-256。beta 阶段仅 win-x64；Linux/macOS 安装走 `install.sh`，待后续提供 Linux 二进制。