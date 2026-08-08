# Review 001 — 浏览器 MCP V1 需求独立评审

- 日期: 2026-08-08
- Reviewer: engineering-workflow-requirements-review-coordinator (独立,非自评)
- Agent ID: ab150a88c4a68af52
- 结论: **BLOCKED**
- 评审范围: REQ-BRW-001 ~ 006, NFR, Scope, MVP, Traceability

## BLOCKER

### RVW-001 — 范围冲突未关闭 (blocker / 范围)
访谈 Q1 用户明确要"上传和下载能力"(表单提交、下载表单信息),但 MVP-001 与 scope_matrix 把表单/上传/下载全部移到二期。requirements_log.ndjson 第 16 行登记了 conflict 后从未关闭,也没有用户确认记录。
- **评审不能代为确认**:上传/下载推迟是否可接受是业务规则。
- 处理: 需用户明确拍板。

### RVW-002 — 状态台账过期 (blocker / 追踪)
requirements_state.yaml 仍 phase="00_INTAKE"/IN_PROGRESS/baseline=null/owner=TBD;但日志最后一条已是 14_INDEPENDENT_REVIEW。按此恢复会退回启动阶段。
- 处理: 协调者(我)更新状态文件与 checkpoint。

## MAJOR

- **RVW-003** (技术假设): storageState bootstrap 循环依赖——需要登录会话才能保存,但登录流程未定义;"过期"无检测;URL→storageState 映射未定义。
- **RVW-004** (安全): 无 URL 授权/白名单;browser_read 把整页文本(含内部系统 PII)返回给 Agent,仅 cookie 脱敏不够。
- **RVW-005** (遗漏): 并发浏览器操作无串行化/排队策略;浏览器崩溃检测/重启语义未定义。
- **RVW-006** (追踪): MUST 级 NFR(PERF/SEC/REL)无 AC、无矩阵行、无验收映射;缺 AC→REQ 反向索引。
- **RVW-007** (矛盾): REQ-BRW-006 是否属 V1 在 scope_matrix / mvp_scope / priority_matrix / roadmap / traceability 中互相矛盾。
- **RVW-008** (伪精确): clickable=enabled 不符合 Playwright actionability;browser_read"主要"无定义;browser_open"网络空闲/超时"无值且与 NFR-PERF-001(≤8s)冲突;登录态 AC 无断言依据。
- **RVW-009** (遗漏): alert/confirm/prompt、target=_blank 新标签、下载类点击等常见场景未覆盖。

## MINOR
- **RVW-010** (追踪): REQ-ORG-001/SESS-001/MVP-001 决策只在 log,不在 technology_decisions.md。
- **RVW-011** (范围): 工具清单含 V2 的 fill/upload/download 未标注阶段;architecture_analysis "待确认"与"已批准 ARCH-001"矛盾。
- **RVW-012** (伪精确): NFR "尽力"措辞不可测;冷启动排除方式未定义。
- **RVW-013** (追踪): open_questions 状态陈旧,progress 仍写 INTAKE。

## 处理状态
- [ ] RVW-001 用户拍板上传/下载归属
- [ ] RVW-002 状态文件更新(协调者)
- [ ] RVW-003~013 需求修订(协调者+用户决策)

## 后续
全部关闭后重开本评审 Gate,通过后方可冻结基线。
