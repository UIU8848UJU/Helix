# TDD Development Brief

## Identity

- Work item ID: REPO-003
- Requirement IDs: ARCH-006, REPO-001, REPO-002, REPO-003 (requirements/technology_decisions.md, requirements/architecture_model.md)
- Defect IDs: n/a
- Change request IDs: Task pool extraction (user-approved 2026-08-08)
- Target release: helix-ai-infra 0.4.0
- Current release: 0.3.0
- Owner: user
- Primary implementer: engineering-workflow-tdd-coordinator
- Independent reviewer: engineering-workflow-delivery-quality-reviewer (G15)
- Created at: 2026-08-08
- Status: READY

## Goal

- User/business behavior to deliver: Extract the generic Task Runtime model into a shared library (`packages/jobs`) so SSH Runtime (ssh-mcp) and future Browser Runtime (browser-mcp) reuse one task state machine, pool, queue, priority, timeout, retention and metrics. ssh-mcp must keep its existing behavior; regression must stay green.
- Why this change is needed: browser-mcp (V1 baseline frozen) requires the shared Task Runtime + Browser Runtime + Session Scheduler. REPO-003 mandates refactor-first with ssh-mcp regression as the safety gate before browser-mcp V1.
- Observable success: `packages/jobs` exists as an npm workspace consumed by `@helix/ssh-mcp`; ssh-mcp `job_*` tools keep identical behavior; all existing 44 vitest tests still pass; new packages/jobs tests pass.
- Unacceptable outcome: ssh-mcp regression (44 tests) breaks; protocol builders/parsers silently change; SSH execution path degrades (privileged, broker, audit, concurrency limiter).

## Approved acceptance criteria

| Acceptance ID | Given | When | Then | Priority | Source |
|---|---|---|---|---|---|
| AC-REPO-001 | generic Task Runtime is extracted into packages/jobs | ssh-mcp imports it | ssh-mcp build/check/test all pass | MUST | REPO-001 |
| AC-REPO-002 | packages/jobs exposes TaskState/TaskStatus/TaskLogs + submit/status/cancel + bounded queue/worker limit/priority/timeout/retention/metrics | a unit test exercises the model | state transitions and pool limits behave per design | MUST | ARCH-006 |
| AC-REPO-003 | ssh-mcp jobs.ts is refactored to consume packages/jobs | full test suite runs | all 44 baseline tests pass (1 skip unchanged) and new package tests pass | MUST | REPO-003 |
| AC-REPO-004 | SSH-specific wire protocol (sh-script builders, HELIX_JOB_* markers, broker/runSsh execution) remains SSH-side | tools are exercised | no behavior change in job_start/status/logs/cancel output shape | MUST | ARCH-006, REPO-001 |

## Scope

### Allowed production changes

- Create `packages/jobs` npm workspace (`@helix/jobs`): generic Task Runtime (task types, state machine, TaskPool, Semaphore, protocol helpers, shellQuote).
- Update root `package.json` workspaces to include `packages/*`.
- Refactor `apps/ssh-mcp/src/jobs.ts` to import generic pieces from `@helix/jobs` and implement the SSH TaskExecutor.
- Move `Semaphore`/`shellQuote`/protocol helpers to `@helix/jobs` and re-export from ssh-mcp to avoid breaking imports.

### Allowed test/infrastructure changes

- Move/adjust `apps/ssh-mcp/test/jobs.test.ts` imports to `@helix/jobs` where the code under test moved.
- Add `packages/jobs` vitest + tsconfig + package.json.

### Forbidden changes

- Changing the SSH wire protocol field names, magic markers, or state semantics.
- Changing job_* tool input/output shape.
- Changing broker/privileged/audit/sudo behavior.
- Adding browser-mcp V1 features in this task.
- Rewiring job_* tools through TaskPool.submit() (double concurrency risk); TaskExecutor is interface conformance only.

### Preserved behavior

- `job_start` returns { ok, jobId, host, type, name, state, pid, privileged, logPath, next }.
- `job_status` / `job_logs` / `job_cancel` output shapes.
- Unix-only e2e test stays skipped on win32.
- Concurrency limit via maxConcurrentCommands.
- audit events, privileged execution via broker/runSsh, path allowlist enforcement.

### Future scope, not committed

- `packages/ssh` SSH Runtime package (session pool, SFTP, credential) — deferred.
- `packages/browser` Browser Runtime + Session Scheduler — browser-mcp V1 phase.
- Generalized TaskStatus for browser tasks (pid/logPath may differ) — later.
- Routing job_* tools through TaskPool.submit() — deferred, requires new behavior slice (BEH-SSH-POOL) with routing tests.
- Generalizing TaskState names/id prefix beyond ssh-mcp state names — later.

### Naming contract (pinned this task)

- Generic `TaskStatus` in packages/jobs uses field `taskId`.
- ssh-mcp `JobStatus` keeps `jobId` + `privileged` (SSH adapter type) so job_* output shapes stay byte-identical.
- `TaskState` reuses ssh-mcp state names (queued/running/succeeded/failed/cancelled/lost/not_found).

## Technical prerequisites

| Prerequisite | Evidence/ADR/research | Status | Owner |
|---|---|---|---|
| npm workspaces support apps/* + packages/* | npm 11.16.0 monorepo already uses workspaces | CONFIRMED | tdd-coordinator |
| vitest runs per workspace/package | ssh-mcp test suite runs via vitest | CONFIRMED | tdd-coordinator |
| Generic Task Runtime model design | requirements/architecture_model.md (user-approved) | CONFIRMED | user |
| Node 20+ + TS for package | Node v24.18.1, TS 5.8.3 | CONFIRMED | tdd-coordinator |

## Engineering environment topology

- Project topology ref: `.skillmatrix/engineering/environment-topology.yaml`
- Required bindings for this work item: SOURCE-EDIT-LOCAL, BUILD-LOCAL, UNIT-LOCAL
- Roles explicitly not required and rationale: integration/system/compatibility/deployment — no remote SSH target needed for this refactor; the Unix-only e2e already exists and stays skipped on Windows.
- Required real/target environments: none beyond local DEV-WINDOWS; Unix SSH target equivalence documented in topology (protocol logic equivalent; shell execution NOT equivalent locally).
- Environments unavailable at intake: LINUX-SSH-TARGET not reachable from this Windows box for live e2e (deferred to real-host validation).

| Binding ID | Role | Required? | Environment ID | Context ID | Real/Fake/Sandbox/CI | Required conclusion |
|---|---|---|---|---|---|---|
| SOURCE-EDIT-LOCAL | source_edit | Yes | DEV-WINDOWS | host-shell | Real | edit sources |
| BUILD-LOCAL | build | Yes | DEV-WINDOWS | host-shell | Real | tsc build/check green |
| UNIT-LOCAL | unit_test | Yes | DEV-WINDOWS | host-shell | Real | 44+new tests green |

## Compatibility and migration

- Public API/ABI impact: ssh-mcp internal modules re-export shared pieces; no external API change.
- Data/schema impact: none (remote job directory layout unchanged).
- Configuration impact: root package.json workspaces gains `packages/*`.
- Protocol/file format impact: none (HELIX_JOB_* markers, field names, base64 encoding unchanged).
- Backward compatibility: ssh-mcp job_* tools unchanged.
- Forward compatibility: browser-mcp can consume packages/jobs without SSH protocol.
- Upgrade path: npm install after adding workspace.
- Downgrade/rollback path: revert to previous commit (single logical refactor commit).

## Risks

| Risk ID | Description | Impact | Likelihood | Required validation | Owner |
|---|---|---|---|---|---|
| RISK-001 | Rename/move breaks jobs.test.ts imports or hidden coupling (Semaphore re-exported from process.ts used by other modules) | HIGH | MEDIUM | run full ssh-mcp test suite + check after refactor | tdd-coordinator |
| RISK-002 | TaskPool semantics drift from existing Semaphore concurrency behavior | MEDIUM | MEDIUM | unit tests on TaskPool + existing process.test.ts | tdd-coordinator |
| RISK-003 | packages/jobs build/tests not wired into root build/test (workspaces gap) | HIGH | LOW | root npm run build/test/check covers packages | tdd-coordinator |
| RISK-004 | Over-abstraction bloats packages/jobs beyond what browser-mcp needs | MEDIUM | MEDIUM | review seam boundaries with test-strategy-architect | tdd-coordinator |

## Release and rollback constraints

- Deployment model: npm workspaces, local stdio MCP server (no external deployment).
- Feature flag: none.
- Rollout unit: single refactor PR.
- Monitoring signals: ssh-mcp job_* tools still function; vitest suite green.
- Rollback trigger: any baseline test failure or tool behavior change.
- Data rollback/forward-fix strategy: revert commit.
- Maximum acceptable interruption: none (MCP server rebuilt in place).

## Readiness decision

- Decision: READY
- Blocking findings: none
- Conditions: G00 test-strategy-architect delegation must PASS before RED.
- Approved by: user
- Evidence paths: development/baseline/*.yaml, development/analysis/, development/strategy/
