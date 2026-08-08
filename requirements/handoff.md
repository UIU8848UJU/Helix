# Handoff — 浏览器 MCP V1 (基线已冻结)

- 基线: V1.0 (2026-08-08, 已批准)
- 批准人: user
- 交付对象: 架构设计 / 技术预研 / TDD 开发

## 交付范围
- 6 条功能需求 + 18 AC + 11 NFR(带 NFR-AC)
- 完整追踪: traceability_matrix.csv (18 行)、nfr_traceability.yaml

## 对下一阶段(TDD)的要求
1. **编辑环境**: 新 app `apps/browser-mcp`, TypeScript + Node 20+
2. **构建**: tsc;测试: vitest
3. **依赖**: playwright + Chromium (需安装);@modelcontextprotocol/sdk ^1.17.5
4. **测试接缝**:
   - Playwright 可启动 Chromium(单元测试前先验证安装)
   - driver 抽象层便于 mock(不真连浏览器跑单测)
   - storageState 注入路径
5. **验收驱动**: 每条 MUST 有 AC,作为 TDD 验收来源;NFR 有 NFR-AC

## 关键技术前提(需在 TDD 前验证,若失败回退需求)
- ASM-001: Chromium 在本机可安装运行
- ASM-004: storageState 对目标内部系统有效
- 若两者任一不成立,走 Change Request 调整基线

## 已知限制
- bootstrap 需 headed 人工登录
- iframe/shadow DOM 按钮穿透二期
- 内容边界为域名级(白名单),不做站内 PII 脱敏

## 下一步建议
1. technology-research / PoC: 验证 Playwright 在本机 + storageState 对内部系统(若尚未验证)
2. **仓库重构(REPO-003)**:抽离通用 Task Runtime 共享库 → SSH Runtime 接入 → ssh-mcp 回归测试通过
3. **browser-mcp 一期开发**:基于共享 Task Runtime + Browser Runtime + Session Scheduler,以本基线的 REQ/AC/NFR-AC 为验收源

## 开发顺序(用户定案 REPO-003)
先重构共享任务池并回归验证 ssh-mcp,确认无回归后再进入 browser-mcp 一期。重构本身也应走 TDD。
