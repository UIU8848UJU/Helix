# Technology Decisions — 浏览器 MCP

## 已批准决策
| ID | 决策 | 依据 |
|----|------|------|
| ARCH-001 | 一期本机 Playwright 起步,driver 抽象层预留二期远端 CDP | 与 ssh-mcp 同栈(Node/TS/vitest),最快闭环,留远端化空间 |
| ARCH-002 | 内部系统登录态用 Playwright storageState,人工首次登录导出,不经 AI/日志 | 简单安全,凭据不暴露给模型 |
| ARCH-003 | 上传/下载走受控目录(~ 下指定目录)+ 文件工具,Agent 通过工具拿路径 | 大文件不经过 MCP 文本通道,清晰边界 |
| REQ-ORG-001 | 页面读取与按钮提取分工具组织 | 访谈确认,接口清晰 |
| SESS-001 | 一期单浏览器实例、单标签 | 访谈确认,简化会话管理 |
| MVP-001 | 一期=读页面+列按钮+点击+导航控制;二期=表单/上传/下载 | 访谈确认,经 RVW-001/RVW-007 定案(2026-08-08) |
| ARCH-004 | 主路径 Playwright,底层保留 CDP escape hatch(二期远端直接连) | 用户拍板,flexibility 与易用平衡 |
| ARCH-005 | 浏览器引擎 Chromium | 用户拍板 |
| ARCH-006 | 抽离通用 Task Runtime 模型,SSH/Browser 两个 Runtime 实现 | 用户拍板,见 architecture_model.md |
| ARCH-007 | Browser Runtime 在 Task Pool 上再加 Session Scheduler(Browser/Context/Page Pool) | 用户拍板,浏览器非简单 worker |
| REPO-001 | 任务池抽离共享库,ssh-mcp 与 browser-mcp 复用 | 用户拍板 |
| REPO-002 | 仓库结构 apps + packages 共享 | 用户拍板 |
| REPO-003 | 开发顺序:先重构共享库→ssh-mcp 回归→再 browser-mcp 一期 | 用户拍板 |

## 技术栈
- 语言/运行时: TypeScript, Node >= 20
- 浏览器控制: Playwright(Chromium)
- MCP: @modelcontextprotocol/sdk(与 ssh-mcp 一致)
- 测试: vitest(与 ssh-mcp 一致)
- 运行形态: stdio transport MCP server

## 架构草图
```
browser-mcp (TS, stdio)
 ├─ tools (V1): browser_open / browser_read / browser_buttons /
 │              browser_click / browser_save_state / browser_load_state /
 │              browser_back / browser_forward / browser_reload / browser_wait
 ├─ tools (V2): browser_fill / browser_upload / browser_download / 文件工具
 ├─ Driver 抽象: LocalDriver(Playwright, CDP escape hatch) [二期: RemoteDriver(CDP)]
 ├─ 登录态: storageState 加载/保存
 └─ 文件 (V2): 受控下载/上传目录 + 文件工具

共享层 (packages/):
 ├─ Task Runtime: 状态机/队列/worker/priority/timeout/retention/metrics
 ├─ SSH Runtime: session pool / libssh2 / SFTP / credential
 └─ Browser Runtime: Browser/Context/Page Pool + Session Scheduler
```

## 开发顺序(REPO-003)
1. 重构:抽离通用 Task Runtime,SSH Runtime 接入,ssh-mcp 回归
2. browser-mcp 一期:基于共享 Task Runtime + Browser Runtime + Session Scheduler

## 评价指标(后续 Gate 用)
- 按钮信息提取正确率(标准页面上定位准确)
- 点击/上传/下载端到端成功率
- 登录态复用(一次登录,N 次会话)
- 安全:凭据/敏感数据不进入 Agent 上下文
