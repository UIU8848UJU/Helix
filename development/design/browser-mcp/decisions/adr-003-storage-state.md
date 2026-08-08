# ADR-003 登录态: storageState 域名映射 + save/load 工具

- status: ACCEPTED
- date: 2026-08-08
- related: CON-S005, REQ-BRW-005, NFR-SEC-001, AC-BRW-005-01/02/03

## 背景
内部系统需登录访问; 凭据不经 AI(CON-005/NFR-SEC-001); bootstrap 首次人工 headed 登录并导出(REQ-BRW-005)。

## 候选
1. 每次人工注入凭据: 违反 CON-005, 拒绝。
2. storageState 文件 + 域名映射: Playwright 原生能力, spike 已验证往返有效(ASM-004)。

## 决策
采用方案 2:
- 配置 `storageStates: [{ domain, path }]`; 打开站点时按"最长后缀匹配"选择状态文件, 无匹配则不加载。
- `browser_save_state({ domain })`: 当前 context 状态写入该域名配置的 path(文件 0o600, 受控目录); 返回仅含路径, cookie 内容不返回(NFR-SEC-001)。
- `browser_load_state({ path })`: 显式加载(供 bootstrap 场景)。
- 过期检测: 打开后若跳转到登录页(/login 或 401/403 响应), 返回 "登录态失效, 需重新保存 storageState" 提示(AC-BRW-005-03), 不自动注入凭据。
- 状态文件路径必须位于受控目录(复用 ssh-mcp 本地路径策略思路)。

## 后果
- 登录态一次保存多次复用; 凭据全程不进 MCP 文本通道。
- bootstrap 需要 headed 窗口: settings.headless=false 临时切换(known_limitation, 需求已记录)。