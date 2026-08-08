# Priority Matrix — 浏览器 MCP

## 一期需求优先级
| REQ | 需求 | 价值 | 风险 | 成本 | 依赖 | 优先级 |
|-----|------|------|------|------|------|--------|
| REQ-BRW-001 | 打开页面 | 高 | 低 | 低 | Playwright | MUST (P0) |
| REQ-BRW-003 | 列出按钮 | 高 | 中 | 中 | REQ-BRW-001 | MUST (P0) |
| REQ-BRW-002 | 读取页面内容 | 高 | 低 | 低 | REQ-BRW-001 | MUST (P0) |
| REQ-BRW-004 | 点击按钮 | 高 | 中 | 中 | REQ-BRW-003 | MUST (P0) |
| REQ-BRW-005 | 登录态 storageState | 高 | 中 | 中 | Playwright | MUST (P0, 内部系统必需) |
| REQ-BRW-006 | 导航控制(back/fwd/reload/wait) | 中 | 低 | 低 | REQ-BRW-001 | SHOULD (P1, 已确认纳入 V1) |

## 二期需求状态
| REQ | 需求 | 状态 |
|-----|------|------|
| REQ-BRW-007 | 表单填充 | LATER_CANDIDATE |
| REQ-BRW-008 | 上传文件 | LATER_CANDIDATE |
| REQ-BRW-009 | 下载文件 | LATER_CANDIDATE |
| REQ-BRW-011 | 多标签/多实例 | LATER_CANDIDATE |
| REQ-BRW-012 | 页面结构深度(iframe/shadow DOM) | LATER_CANDIDATE |

## 三期需求状态
| REQ | 需求 | 状态 |
|-----|------|------|
| REQ-BRW-010 | 远端浏览器 CDP 驱动 | LATER_CANDIDATE |
| REQ-BRW-013 | 登录凭据自动注入(复用 broker) | LATER_CANDIDATE (需安全评审) |
