# ADR-001 会话模型: 单例浏览器 + 串行化 + 崩溃自动重启

- status: ACCEPTED
- date: 2026-08-08
- related: SESS-001, NFR-PERF-001, NFR-REL-001/002/003, REQ-BRW-005

## 背景
一期单浏览器实例、单标签(SESS-001)。操作必须串行(NFR-REL-003), 浏览器崩溃需自动重启(NFR-REL-002), 失败可恢复(NFR-REL-001)。

## 候选
1. 每次调用 launch 新浏览器: 冷启动慢、登录态丢失, 违反 NFR-PERF-001。
2. 持久单例 Browser+Context+Page, 复用 @helix/jobs Semaphore 串行化, 崩溃后懒重启。

## 决策
采用方案 2:
- BrowserManager 持有唯一 Browser/Context/Page; 首次调用时惰性创建。
- 所有工具操作经 `Semaphore(1)` 排队, 按到达顺序执行(NFR-REL-003)。
- 监听 `browser.on("disconnected")`: 置实例为 dead, 不调用 close(避免挂起), 下次调用自动重新 launch(NFR-REL-002)。
- 单次操作失败不销毁实例(元素缺失/超时只返回错误), 仅进程级崩溃触发重启(NFR-REL-001)。

## 后果
- 登录态自然跨调用保持(REQ-BRW-005)。
- 需要配套 headless/headed 切换: headed 仅 bootstrap 保存 storageState 时使用。