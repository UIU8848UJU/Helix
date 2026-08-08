# Current State — 浏览器 MCP

## 仓库现状
- **helix-ai-infra** monorepo,现有:
  - `apps/ssh-mcp`: TypeScript MCP server(stdio transport),提供 SSH 执行/sudo/文件传输/Docker/任务池(job_start 等)
  - `apps/credential-broker`: Rust daemon,Windows 凭据管理 + session pool,通过命名管道/socket 与 ssh-mcp 通信
- **无任何现成浏览器/自动化工具链**:grep 无 playwright/puppeteer/selenium/CDP 相关代码(匹配到的都是 Rust 编译产物字符串)
- 开发环境:Windows 11, Node >= 20, TypeScript, vitest

## 可复用基础设施
- MCP server 模式(StdioServerTransport)已有成熟先例:apps/ssh-mcp
- 凭据管理:credential-broker(Windows 凭据窗口)可用于内部系统登录凭据
- 任务池(persistent jobs):如果浏览器操作耗时长,可复用 job 模式

## As-Is 浏览器访问方式(用户侧)
- 目前无浏览器自动化能力;AI Agent 无法自动访问网页、读取按钮、交互
- 目标站点:公开网站 + 内部系统(需登录)都要支持
- 需要:读取页面/按钮信息、点击交互、上传(填表单/文件)、下载(表单数据/文件)

## 技术债 / 风险
- 无历史浏览器代码,是绿地开发
- 内部系统登录凭据处理是敏感点
- 反爬/合规风险(自动访问第三方站点)需明确边界
