# Browser-MCP 候选架构与权衡

## 候选方案

### A. 单体单文件 (index.ts 内联全部工具)
- 优点: 起步最快, 文件最少
- 缺点: 配置/策略/会话/审计混杂, 无法单元测试核心逻辑, 与 ssh-mcp 结构不一致
- 结论: 拒绝

### B. 分层模块 (镜像 ssh-mcp 结构)
- 模块:
  - config.ts        ConfigStore + zod schema + 校验 + redact
  - policy.ts        URL scheme/域名白名单/路径策略 + 工具命令构建
  - session.ts       BrowserManager: 单例 Browser/Context/Page 生命周期 + 崩溃重启 + 串行化
  - driver.ts        Driver 抽象(LocalPlaywrightDriver), 二期可加 RemoteCdpDriver
  - tools.ts         browser_* 工具注册(输入/输出契约)
  - audit.ts         JSONL 审计 + 脱敏
  - guidance.ts      指令/帮助(镜像 ssh-mcp)
  - index.ts         stdio 入口
- 优点: 可测、可复用 ssh-mcp 模式、满足 CON-002/003 与 TDD 2.1
- 结论: 采用

### C. 框架化(agent 循环 / browser-use 类)
- 优点: 能力上限高
- 缺点: 依赖重、一期 6 REQ 用不到、违反"默认简单"
- 结论: 拒绝

## 关键取舍
- 单例浏览器(持久) vs 每次调用起新浏览器: 持久实例保登录态与性能(NFR-PERF-001), 用 Semaphore 串行化(NFR-REL-003)
- 默认拒绝 vs 默认放行: 浏览器可访问内网/含凭据站点, 采用默认拒绝(空白名单 = 全部拒绝)
- 真实浏览器测试: 本地可跑(Chromium 已装), CI 需 `npx playwright install chromium` 或 skip 守卫