# ADR-002 URL 授权: 域名白名单 + scheme 白名单

- status: ACCEPTED
- date: 2026-08-08
- related: CON-S004, NFR-SEC-002/003, AC-BRW-001-02/03/04

## 背景
browser_open 只能访问已授权站点(CON-S004); 危险 scheme 全拒(NFR-SEC-002); 未授权域名不发起导航(AC-BRW-001-04)。

## 候选
1. 正则表达式 allowlist: 灵活但易写错、难审计。
2. 精确域名列表: 简单但子域需逐个列。
3. 域名列表 + 子域通配(host === d || host.endsWith("." + d)): 覆盖常见内网站点形态。

## 决策
采用方案 3:
- 配置 `allowedDomains: string[]`, 空列表 = 默认拒绝一切。
- 匹配规则: 精确相等或子域后缀匹配。
- scheme 白名单: `https`/`http`; 拒绝 `file:` `javascript:` `data:` `about:` `chrome:` 等。
- 拒绝 URL 内嵌凭据(user:pass@)。
- 错误分类: invalid_scheme / unauthorized_domain / invalid_url, 便于 Agent 区分处理。
- 校验在导航前完成(纯函数, 单测覆盖 NFR-SEC-002)。

## 后果
- 未授权域名零导航(满足 AC-BRW-001-04)。
- 白名单由管理员配置, 不随代码发布。