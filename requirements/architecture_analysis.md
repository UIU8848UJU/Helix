# 架构分析 — 浏览器 MCP 部署形态与技术选型

## 目标
AI Agent 通过 MCP 控制浏览器:打开页面、读内容/按钮信息、点击交互、上传/下载。

## 部署形态对比

| 形态 | 优点 | 缺点 | 适配 |
|------|------|------|------|
| A. 本机 Playwright | 简单、调试直观、无网络依赖 | 浏览器消耗本机资源;Agent 与浏览器同机 | 开发期/单机 |
| B. 远端浏览器 + CDP | 复用 SSH 基础设施;浏览器跑服务器 | 复杂度高;需管理 CDP 连接/生命周期 | 多 Agent / 服务化 |
| C. 容器浏览器服务 | 隔离干净、可扩展 | 运维成本;与本仓库 SSH 模式不同 | 大规模 / 平台化 |

## 推荐:混合分层架构

```
┌─────────────────────────────────────────────┐
│  browser-mcp (TypeScript MCP server, stdio) │
│   - browser_open / browser_read             │
│   - browser_buttons / browser_click         │
│   - browser_fill / browser_upload / download│
└──────────────────┬──────────────────────────┘
                   │ 抽象 driver 接口
        ┌──────────┴──────────┐
        ▼                     ▼
   LocalDriver          RemoteDriver(可选,二期)
   (Playwright 本机)   (CDP 连远端浏览器,复用 ssh-mcp 主机)
```

**核心决策:**
1. **本机 Playwright 起步**:MCP server 直接控制本机 Chromium,最快形成可用闭环。
2. **driver 抽象层**:把"浏览器能力"封装成接口,二期可加远端 CDP driver,复用现有 ssh-mcp 的主机连接。避免一开始就把复杂度堆进 SSH 链路。
3. **TypeScript + Playwright**:与 ssh-mcp 同栈(Node/TS/vitest),Playwright 支持 selectors/点击/上传(setInputFiles)/下载(Download 事件),和需求字段(text/selector/位置/aria)匹配。

## 登录态设计(内部系统)
- 方式一:配置文件里给目标站点配好 cookie / storage state(Playwright 支持 `storageState`)
- 方式二:首次人工登录,导出 storage state
- 方式三(二期):复用 credential-broker 的凭据窗口注入登录凭据
- 安全原则:凭据不经 AI/日志,存本地加密或 Windows 凭据库

## 上传/下载
- 上传:`setInputFiles` 支持本地文件路径注入 input[type=file]
- 下载:监听 `page.on('download')`,保存到受控目录
- 需要与 Agent 的"拿到文件"衔接:下载目录暴露给 Agent 或提供读取工具

## 待确认
- 一期是否只要本机 driver?(推荐:是)
- 内部系统登录态用 storage state 还是凭据注入?
- 下载的文件存哪、怎么给 Agent?
