# Browser-MCP 代码风格基线

原则: 简洁明了第一; 与 ssh-mcp 保持一致的工程习惯。

## 规则
- TypeScript strict; ESM; import 带 `.js` 后缀(与 ssh-mcp 一致, tsc NodeNext)
- 无 barrel 文件; 模块按职责拆分(config/policy/session/driver/tools/audit)
- 工具命名 `browser_*`; 输出统一 `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`
- 错误统一 `McpError(ErrorCode.InvalidParams, message)`; 内部异常经 `throwInvalid` 包装
- 函数单一职责; 短函数; 命名表达意图; 注释解释 Why 不重复 What
- 测试: `test/*.test.ts`; 单元测试不依赖浏览器; 真实浏览器测试用 skip 守卫
- 格式化: 沿用仓库现有 tsc/vitest, 不新增 linter/formatter