# ADR-005 配置与测试策略: JSON+zod、审计复用、浏览器测试守卫

- status: ACCEPTED
- date: 2026-08-08
- related: CON-002/003, NFR-AUD-001, CI 现状

## 背景
与 ssh-mcp 同栈(CON-002/003); NFR-AUD-001 要求全调用审计且凭据脱敏; CI(ubuntu) 未安装 Playwright 浏览器。

## 决策
- 配置: JSON 文件 + zod schema 校验, 镜像 ssh-mcp ConfigStore(getConfigPath/read/write/mutate), 敏感字段 redact。
- 审计: 复用 ssh-mcp audit JSONL 模式; 记录 tool/domain/ok/duration/error; URL 仅记录域名与路径, 去掉 query(防 token 泄漏), storageState 内容永不入审计。
- 测试分层:
  - 单元(纯逻辑, 无浏览器): URL 授权/scheme 校验、配置 schema、storageState 映射解析、审计脱敏 —— CI 必跑。
  - 集成(真实 Chromium): 会话生命周期、open/read/buttons/click/nav/wait、storageState 往返、dialog/popup、崩溃恢复 —— 本地默认跑(Chromium 已装), CI 用 skip 守卫(检测不到浏览器则跳过)并给 ssh-mcp job 增加 `npx playwright install chromium`。
- 并发: 复用 @helix/jobs Semaphore; 工具输出形状与 ssh-mcp 一致(JSON text, ok 字段)。

## 后果
- 单测无需浏览器依赖, CI 稳定; 集成测试覆盖 NFR 关键路径。
- 新增 browser-mcp CI job(或扩展现有 unit job)需安装 chromium(约 1 分钟)。