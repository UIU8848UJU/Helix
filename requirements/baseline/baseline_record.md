# Baseline Record — 浏览器 MCP V1

- 基线版本: V1.0
- 冻结日期: 2026-08-08
- 批准人: user (需求 Owner)
- 评审: 独立评审 APPROVED (review-003.md, agent a818603c16223042b)
- 前置评审记录: review-001.md (BLOCKED), review-002.md (REVISE)

## 基线范围
6 条功能需求 (REQ-BRW-001~006),18 条验收条件 (AC)
- REQ-BRW-001 打开页面
- REQ-BRW-002 读取页面内容
- REQ-BRW-003 列出按钮
- REQ-BRW-004 点击按钮
- REQ-BRW-005 登录态 storageState
- REQ-BRW-006 导航控制

## NFR
11 项 (PERF/SEC/REL/OPS/COM/AUD),每项有 NFR-AC (nfr_traceability.yaml)

## 二期范围 (不属本基线)
- REQ-BRW-007 表单填充
- REQ-BRW-008 上传文件
- REQ-BRW-009 下载文件
- REQ-BRW-010 远端浏览器 CDP
- REQ-BRW-011 多标签/多实例
- REQ-BRW-012 页面结构深度
- REQ-BRW-013 登录凭据注入

## 关键决策
- ARCH-001 本机 Playwright 起步,driver 抽象留二期
- ARCH-002 storageState 登录态,不经 AI/日志
- ARCH-003 受控目录+文件工具衔接(二期)
- MVP-001 一期=读+列按钮+点击+导航;二期=表单/上传/下载
- SESS-001 一期单实例单标签

## 开放问题
- 无 (全部 OQ 已核销)

## 假设风险
- ASM-001 Playwright Chromium 可安装(待验证)
- ASM-004 storageState 对目标内部系统有效(待验证)
- 见 assumptions.yaml

## 变更规则
基线后任何需求变更须走 Change Request (requirements/changes/),不得直接覆盖本基线。
