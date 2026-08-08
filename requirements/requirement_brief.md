# Requirement Brief — 浏览器 MCP

## 一句话需求
做一个浏览器 MCP,可以通过浏览器访问页面信息、识别页面上的按钮,并拿到按钮的信息。

## 输入来源
- 用户口头需求 (2026-08-08)

## 已知约束
- 在 helix-ai-infra 仓库生态内开发(monorepo,已有 ssh-mcp / credential-broker)
- 走 requirements-engineering → TDD 完整流程

## 初始未知项
- 目标用户是谁?给谁用?什么场景?
- 与已有 helix-ssh MCP 是并列、组合还是替换?
- 浏览器技术栈:Playwright / Puppeteer / Chrome DevTools Protocol / 系统浏览器?
- 运行形态:本机 MCP / 远端主机 / Docker?
- "拿到按钮的信息"具体指什么:text / selector / aria / 位置 / 可点击性?
- 是否需要交互(点击按钮),还是只读?
- 是否需要多页面 / 登录态 / cookie 处理?
- 安全边界:是否要防注入、防敏感信息泄露?
