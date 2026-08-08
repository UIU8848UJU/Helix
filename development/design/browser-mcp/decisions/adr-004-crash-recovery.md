# ADR-004 崩溃恢复: disconnected 事件 + fire-and-forget CDP + 懒重启

- status: ACCEPTED
- date: 2026-08-08
- related: NFR-REL-002, AC-BRW-004-04, spike ASM-005 发现

## 背景
spike 发现(evidence.md):
1. `cdp.send("Browser.crash")` 的 Promise 在浏览器死亡后永不 settle —— 不能 await。
2. 已崩溃实例调用 `browser.close()` 可能挂起。
3. `browser.on("disconnected")` 在崩溃时立即触发。

## 决策
- 崩溃注入类 CDP 调用一律 fire-and-forget(不 await, 仅 catch)。
- 以 `disconnected` 事件 + `isConnected()` 探测作为唯一崩溃判定。
- 崩溃实例直接丢弃, 不调用 close; 下次工具调用经 BrowserManager 懒重启。
- 所有浏览器操作包超时看门狗(默认 30s), 防挂起。
- 崩溃期间的调用返回明确错误("浏览器崩溃已重启"), 不破坏 MCP 进程(NFR-REL-002 limit)。

## 后果
- 满足 NFR-REL-002 自动重启与"崩溃不导致 MCP 进程退出"。
- 需要注入测试: CDP Browser.crash + 断言后续调用可用。