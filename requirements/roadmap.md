# Roadmap — 浏览器 MCP

## Current Baseline (V1, 当前迭代)
- 目标:AI Agent 网页浏览闭环(打开/读/列按钮/点击/导航控制) + storageState 登录态
- 前置:安装 Playwright + Chromium
- 新能力:REQ-BRW-001~006 (REQ-BRW-006 经 RVW-007 确认纳入 V1)
- 成功指标:5 条 MUST 验收通过;安全 NFR 达标
- 技术债:无(绿地)

## Next Committed (V2)
- 目标:完整表单交互 + 文件能力
- 新能力:
  - REQ-BRW-007 表单填充
  - REQ-BRW-008 上传文件
  - REQ-BRW-009 下载文件 + 文件工具(受控目录衔接)
- 前置:V1 稳定;文件目录约定
- 兼容:V1 工具不变,增量新增

## Later Candidates (V3+)
- REQ-BRW-010 远端浏览器 CDP(复用 ssh-mcp 主机)
- REQ-BRW-011 多标签/多实例隔离
- REQ-BRW-012 页面结构深度(iframe/shadow DOM)
- REQ-BRW-013 登录凭据自动注入(需安全评审)

## 未承诺
- 反爬绕过 / 验证码破解(明确不做,合规边界)
- 定时调度(外部 Agent 负责)
