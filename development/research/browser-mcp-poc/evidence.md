# Browser-MCP 技术预研证据 (POC)

- work_item_id: BRW-RES-001
- date: 2026-08-08
- status: PASS — 全部 10 项 spike 通过,建议 GO(带条件)
- 前置: 需求基线 V1 (requirements/baseline/approved_requirements.yaml), 11 NFR

## 环境

- 平台: Windows 11 x64 (NFR-COM-001 验收目标平台)
- Node: v24.18.1, npm 11.16.0
- Playwright: ^1.62.1
- Chromium: 151.0.7922.34 (playwright chromium-1234 完整版 + chromium_headless_shell-1234)
- 安装方式: `npm install playwright` + `npx playwright install chromium`(经本机 Clash 代理)
- 浏览器缓存: %LOCALAPPDATA%\ms-playwright

## 验证项 (development/research/browser-mcp-poc/spike.mjs)

| 编号 | 场景 | 结果 |
|------|------|------|
| ASM-002 | headless 启动 + goto + 标题/URL/加载状态 | PASS (本机 543ms) |
| ASM-wait | 等待 selector 可见 | PASS |
| ASM-003 | 页面可见文本提取 | PASS |
| ASM-buttons | 按钮枚举(id/text) | PASS |
| ASM-click | 点击按钮改变 DOM | PASS |
| ASM-dialog | alert 自动 dismiss 且捕获内容 | PASS |
| ASM-popup | target=_blank 弹窗关闭,主标签保持 | PASS |
| ASM-004 | storageState 保存→新 context 加载→localStorage 保留 | PASS |
| ASM-nav | back / forward / reload | PASS |
| ASM-005 | CDP Browser.crash → disconnected 检测 → 重新 launch | PASS |

证据文件: spike-results.jsonl (原始结果)。

## 关键发现(对工程设计的约束)

1. **崩溃恢复**: `cdp.send("Browser.crash")` 的 Promise 在浏览器死亡后永不 settle。
   设计上不得 await 该调用,必须 fire-and-forget + `browser.on("disconnected")` 事件 + 看门狗超时。
2. **崩溃后的 close**: 已崩溃实例调用 `browser.close()` 可能挂起,直接丢弃实例并重新 launch。
3. **storageState 往返**: cookie/localStorage 持久化生效;凭据只落在受控状态文件,不进入返回内容。
   CON-S005(域名→状态文件映射)与 NFR-SEC-001 可行。
4. **对话框**: 全局 page.on("dialog") 自动 dismiss 可覆盖 AC-BRW-004-03。
5. **弹窗**: context.on("page") 捕获新标签,关闭后主标签不受影响,可覆盖 AC-BRW-004-04。
6. **headed bootstrap**: 完整 Chromium 已安装,首次人工登录保存 storageState 可行。

## 未覆盖/留待 TDD 的内容

- URL 授权白名单(CON-S004)与危险 scheme 拦截: 属应用层逻辑,spike 未测,需单元测试覆盖
- NFR-PERF-001/002 真实网络 P95: 本机 543ms 远低于 8s/2s 上限,正式验收需真实站点测量
- NFR-AUD-001 审计与凭据脱敏: 复用 ssh-mcp audit 模式
- NFR-REL-003 并发串行化: 复用 @helix/jobs Semaphore 模式

## Gate 结论

**GO(带条件)** — 进入 engineering-design + TDD。
条件: ① 工程设计阶段必须给出 URL 授权与 storageState 路径映射配置; ② 崩溃恢复按上述 fire-and-forget + disconnected 事件实现,并加注入测试。