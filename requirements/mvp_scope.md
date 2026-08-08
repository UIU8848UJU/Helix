# MVP Scope — 浏览器 MCP (V1)

## 验证的核心假设
- AI Agent 能通过 MCP 打开网页、理解页面内容、识别按钮并点击,完成基本浏览任务闭环
- 登录态 storageState 能满足内部系统访问(无需把凭据交给 AI)

## 必需用户与场景
- AI Agent 自动浏览:打开 → 读内容 → 列按钮 → 点击(导航/展开)
- 内部系统:storageState 登录态复用

## 包含的需求 ID
- REQ-BRW-001 打开页面
- REQ-BRW-002 读取页面内容
- REQ-BRW-003 列出按钮(含完整元数据)
- REQ-BRW-004 点击按钮
- REQ-BRW-005 登录态 storageState
- REQ-BRW-006 导航控制(back/forward/reload/wait) — 经 RVW-007 确认纳入 V1

## 明确排除的需求 ID
- REQ-BRW-007/008/009 表单/上传/下载(二期) — 经 RVW-001 确认,由业务 Owner 明确拍板推迟
- REQ-BRW-010/011/012/013(二期/三期)

## 成功 / 失败 / 停止标准
- 成功:6 条 MUST/SHOULD 需求全部通过验收;典型页面(公开站点 + 一个内部系统)端到端可用
- 失败:NFR-SEC-001 凭据泄露 >0;或按钮信息在标准页面上提取失败率过高
- 停止:Playwright Chromium 无法在目标环境安装运行;storageState 对目标内部系统完全无效

## 不能由 MVP 证明的结论
- 表单/上传/下载的完整交互(二期验证,已确认推迟)
- 多 Agent 并发/远端化(二期/三期)
- 复杂页面(iframe/shadow DOM)的按钮提取(二期)

## 进入正式版本的条件
- 核心场景 P0 通过;审计与安全 NFR 达标;经 requirements-review 独立评审通过
