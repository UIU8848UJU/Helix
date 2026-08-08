# Browser-MCP 技术选型与依赖

| 项 | 选型 | 理由 | 验证 |
|----|------|------|------|
| 语言/运行时 | TypeScript + Node >= 20 (ESM, strict) | CON-002, 与 ssh-mcp 同栈 | 本机 v24.18.1 |
| 浏览器控制 | Playwright ^1.62.1 + Chromium 151 | ARCH-001/004/005, spike 10/10 | development/research/browser-mcp-poc |
| MCP | @modelcontextprotocol/sdk (stdio) | CON-003, 与 ssh-mcp 一致 | 仓库现有依赖 |
| Schema | zod ^3 | 与 ssh-mcp 一致 | 仓库现有依赖 |
| 测试 | vitest ^3 | 与 ssh-mcp 一致 | 仓库现有依赖 |
| 并发/串行 | @helix/jobs (Semaphore) | NFR-REL-003, REPO-001 | packages/jobs 已存在 |
| 审计 | JSONL (镜像 ssh-mcp audit.ts) | NFR-AUD-001 | ssh-mcp 既有模式 |

## 明确不引入
- 不引入 agent 循环/浏览器编排框架(一期用不到, 见 architecture-candidates C)
- 不引入远程 CDP driver(二期 V2)
- 不引入表单/上传下载(二期 V2)

## 依赖下载方式
- npm 包: 经本机 Clash 代理(127.0.0.1:7890)
- Chromium: `npx playwright install chromium`(已装 chromium-1234 + headless_shell-1234, headed 完整版可用于 bootstrap)