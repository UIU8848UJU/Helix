# Risk-based Test Strategy

## Strategy identity

- Work item: REPO-003 (Task pool extraction)
- Target release: 0.4.0
- Repository revision: 4be1d14 (baseline)
- Environment topology revision: 1
- Environment snapshot ref: development/baseline/environment_snapshot.yaml
- Strategy owner: engineering-workflow-tdd-coordinator
- Reviewed by: engineering-workflow-test-strategy-architect (G00/G05 delegation)
- Evidence scope: packages/jobs + apps/ssh-mcp

## Quality risks

| Risk ID | Behavior/source | Failure impact | Uncertainty | Dependency complexity | Priority | Required evidence level |
|---|---|---|---|---|---|---|
| RISK-001 | protocol move breaks jobs.test.ts / imports | HIGH | MEDIUM | MEDIUM | CRITICAL | L2 (unit, full suite) |
| RISK-002 | TaskPool concurrency/timeout/retention semantics | MEDIUM | MEDIUM | HIGH | HIGH | L2 (unit, deterministic fake executor) |
| RISK-003 | packages/jobs not wired to root build/test | HIGH | LOW | LOW | HIGH | L2 (root commands) |
| RISK-004 | over-abstraction of packages/jobs | MEDIUM | MEDIUM | MEDIUM | MEDIUM | review |
| RISK-005 | Unix-only e2e weakened | MEDIUM | LOW | LOW | HIGH | L2 (diff review) |
| RISK-006 | job_* tools accidentally rewired through TaskPool (double concurrency) | HIGH | MEDIUM | HIGH | CRITICAL | L2 (identity.test.ts + full suite + diff review) |

## Test level and environment-role responsibilities

| Level | Behaviors covered | Binding ID | Execution role | Environment/context | Real/Fake/Mock/Sandbox/Replay | What it proves | What it cannot prove |
|---|---|---|---|---|---|---|---|
| Unit | BEH-CORE (TaskPool, protocol, Semaphore) | UNIT-LOCAL | unit_test | DEV-WINDOWS/host-shell | Real (local vitest) | state machine, queue/priority/timeout/retention/metrics, parseProtocol, task-id validation | real SSH execution, shell behavior on Unix |
| Unit | BEH-SSH-ADAPTER (builders/parsers regression) | UNIT-LOCAL | unit_test | DEV-WINDOWS/host-shell | Real (local vitest) | ssh-mcp job protocol unchanged, 44 tests green | remote job engine on real Unix host |
| Integration | remote job engine e2e (existing skipped test) | n/a (skipped win32) | integration_test | LINUX-SSH-TARGET/remote-shell | Real (deferred) | detached job lifecycle + logs on real sh | not available on this Windows box |

## Environment equivalence and gaps

| Source environment | Target environment | Equivalent for | Not equivalent for | Required follow-up | Evidence |
|---|---|---|---|---|---|
| DEV-WINDOWS | LINUX-SSH-TARGET | pure protocol logic (parsers/builders string ops) | unix-shell-job-execution, signals, setsid, process-groups, /tmp/helix/jobs | real-host e2e run when a Linux SSH target is reachable | environment-topology.yaml + snapshot |

## Test data

- Data sources: fixture protocol strings (HELIX_JOB_STATUS_V1/LOGS_V1 frames) matching real broker output.
- Synthetic/production-like: same fixtures used by existing jobs.test.ts.
- Privacy constraints: none.
- Seeds and reproducibility: deterministic string fixtures; no RNG in tests.
- Setup: none beyond vitest.
- Cleanup: TaskPool tests use in-memory state; no filesystem.
- Retention: n/a for unit.
- Time determinism: TaskPool timeout/retention tests MUST use the injectable clock (no real timers).

## Platform matrix

| Platform | Version | Architecture | Topology role | Environment ID | Required tests | Evidence level | Owner |
|---|---|---|---|---|---|---|---|
| Windows 11 Pro | 26100 | x86_64 | unit_test | DEV-WINDOWS | all unit tests | L2 | tdd-coordinator |
| Linux SSH target | varies | varies | integration_test | LINUX-SSH-TARGET | e2e (deferred) | L4 | tdd-coordinator |

## Regression strategy

- Target tests: new packages/jobs unit tests (BEH-CORE) + ssh-mcp jobs.test.ts (BEH-SSH-ADAPTER).
- Target execution binding: UNIT-LOCAL.
- Target execution role: unit_test.
- Module tests: ssh-mcp policy/config/safety/ssh/guidance/admin/process tests (44 baseline).
- Contract tests: n/a this task.
- Integration tests: remote engine e2e stays skipped on win32 (preserved).
- Critical E2E: deferred to Linux SSH target.
- Historical defect family: none specific.
- Platform regression: Unix-only test must remain skipped on Windows.
- Time/resource budget: suites are < 5s; no budget issue.

## NFR strategy

| NFR ID | Metric | Target | Unacceptable limit | Method | Execution binding/role/environment | Failure action |
|---|---|---|---|---|---|---|
| NFR-REL-003 (concurrency) | concurrent tasks limited by worker limit | maxConcurrentCommands honored | exceeding limit | TaskPool unit tests | UNIT-LOCAL/unit_test/DEV-WINDOWS | fix pool |
| NFR-REL-002 (crash) | task state survives process death (remote filesystem model) | unchanged | state regressions | existing e2e (deferred) | LINUX-SSH-TARGET | real-host follow-up |

## Failure and recovery

- Timeout: TaskPool per-task timeout marks task failed; ssh-mcp tool timeouts unchanged.
- Retry: TaskPool does not auto-retry (SSH tool semantics unchanged).
- Cancellation: TaskPool cancel → cancelled state; SSH job_cancel grace behavior unchanged.
- Partial failure: parse errors normalize to unknown/lost per existing logic.
- Crash/restart: remote filesystem model preserved; no new in-memory-only state for jobs.
- Idempotency: job_id pattern validation unchanged.
- Data rollback: n/a.
- Degraded mode: n/a.

## Coverage policy

- Coverage metric used: none hard-gated; assertion-focused.
- Minimum or delta rule: full ssh-mcp suite (44) + packages/jobs suite must pass.
- Critical branches requiring direct assertions: TaskPool state transitions, worker limit, priority order, timeout, retention, cancel; parseProtocol magic-marker missing → error.
- Excluded/generated code: n/a.
- Why coverage is not sufficient alone: behavior equivalence (job_* output shapes) verified by regression assertions, not coverage numbers.

## Flaky policy

- Maximum retry for diagnosis: 2.
- Quarantine authority: tdd-coordinator.
- Blocking test classes: any flaky test blocks cycle done.
- Owner/due requirements: tdd-coordinator.
- Required reproduction data: execution binding/env/context + seed.

## Stage tailoring

| Stage/test type | Included? | Reason | Residual risk | Approval |
|---|---|---|---|---|
| Unit | Yes | core + regression | low | user |
| Component | No | no new component boundary this task | n/a | — |
| Contract | No | no external contract change | n/a | — |
| Integration | Deferred | real Unix host unavailable | remote engine e2e unverified locally | — |
| Security | No | no auth/secret surface changed | n/a | — |
| Performance | No | concurrency limit logic unit-tested | n/a | — |

## Decision

- Decision: CONDITIONAL_PASS
- Conditions: G00 test-strategy-architect delegation must PASS; integration e2e remains a documented follow-up on Linux SSH target.
- Required actions: proceed to cycle planning; run root build/check/test after each cycle.
