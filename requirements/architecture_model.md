# 架构模型 — 通用 Task Runtime (用户定案)

## 决策来源
用户 2026-08-08 拍板:把任务调度核心模型抽离为通用 Task Runtime,SSH 与 Browser 各自实现;Browser 还需在 Task Pool 之上加 Session Scheduler 层。

## 分层模型
```
┌─────────────────────────────────────────────┐
│ 通用 Task Runtime 模型 (共享库)             │
│  TaskID                                     │
│  queued/running/done/failed                 │
│  submit / status / cancel                   │
│  bounded queue                              │
│  worker limit                               │
│  priority                                   │
│  timeout                                    │
│  retention                                  │
│  metrics                                    │
└──────────────┬──────────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
 SSH Runtime       Browser Runtime
 Session Pool      Browser Pool
 libssh2           Context Pool
 SFTP              Page Pool
 Credential        Playwright
```

## 关键点
- **Task Runtime 核心模型**独立于具体执行器:状态机、队列、worker、优先级、超时、保留、指标。
- **SSH Runtime** 是其一实现:session pool、libssh2、SFTP、credential(现有 credential-broker 已是雏形)。
- **Browser Runtime** 是其二实现:但因浏览器非简单 worker,需在 Task Pool 之上加 **Session Scheduler** 层:
  - Browser Pool:浏览器实例池
  - Context Pool:浏览器上下文(登录态隔离单元,storageState 属此层)
  - Page Pool:页面池(标签页管理)

## 仓库结构
- `apps/`: ssh-mcp, credential-broker, browser-mcp(新增)
- `packages/`: 共享库(如 packages/jobs 通用 Task Runtime、packages/ssh、packages/browser)
- npm workspaces 支持 `apps/*` 与 `packages/*`

## 开发顺序(用户定案)
1. **先重构**:抽离通用 Task Runtime 共享库,SSH Runtime 接入
2. **回归测试**:确认 ssh-mcp 重构后基本功能不受影响
3. **再开发**:browser-mcp 一期,基于共享 Task Runtime + Browser Runtime + Session Scheduler

## 对需求基线的影响
- 一期 browser-mcp 需求(REQ-BRW-001~006)不变
- 但开发前置条件是共享库重构 + ssh-mcp 回归通过
- 新增架构需求/任务:任务池抽取、共享库建立、ssh-mcp 回归(走 TDD)
