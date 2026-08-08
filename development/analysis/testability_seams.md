# Testability and Seam Analysis

## Change surface

| Component/file | Responsibility | Planned behavior change | Preserved behavior | Risk |
|---|---|---|---|---|
| apps/ssh-mcp/src/jobs.ts | job_* tools: wire protocol builders/parsers + SSH execution | Split into generic core (→ packages/jobs) + SSH TaskExecutor (stays); jobs.ts re-exports shared pieces | job_start/status/logs/cancel behavior, output shapes, privileged/audit/concurrency | HIGH |
| apps/ssh-mcp/src/process.ts | Semaphore + runProcess | Semaphore moves to packages/jobs; process.ts re-exports it | maxConcurrentCommands limiting, runProcess | MEDIUM |
| apps/ssh-mcp/src/policy.ts | shellQuote + path/sudo policy | shellQuote moves to packages/jobs; policy.ts re-exports it | shell quoting, allowlist enforcement | MEDIUM |
| packages/jobs (new) | generic Task Runtime: TaskState/TaskStatus/TaskLogs/TaskType, TaskPool (queue/priority/timeout/retention/metrics/worker limit), Semaphore, parseProtocol/base64/optional-number helpers, shellQuote, TaskExecutor interface | New shared library | n/a | MEDIUM |
| apps/ssh-mcp/src/server.ts | MCP server tool registration | keeps importing Semaphore (now re-exported) | unchanged | LOW |
| apps/ssh-mcp/src/ssh.ts | runSsh | keeps importing shellQuote (now re-exported) | unchanged | LOW |
| apps/ssh-mcp/test/jobs.test.ts | protocol + e2e tests | imports switch to @helix/jobs for moved pieces | same assertions | HIGH |
| apps/ssh-mcp/test/process.test.ts | runProcess tests | unchanged (tests runProcess, not Semaphore) | unchanged | LOW |
| apps/ssh-mcp/test/policy.test.ts | policy tests | unchanged (tests policy.ts) | unchanged | LOW |

## Dependency map

| Dependency | Type | Control mechanism | Observation mechanism | Evidence level | Real validation required |
|---|---|---|---|---|---|
| system clock | time | injectable clock (TaskPool accepts now/clock fn) | timestamps in TaskStatus | L1 | No |
| randomUUID (jobId) | randomness | generated at tool invocation | returned jobId | L1 | No |
| /tmp/helix/jobs (remote) | filesystem | builders produce paths; parsers read strings | JobStatus.logPath/logSizeBytes | L2 (unit) / L4 (e2e skipped on win32) | Yes, on Linux SSH target |
| broker/runSsh (SSH transport) | external | TaskExecutor interface; not unit-tested | ExecutionResult | L4 e2e (real) | Yes, live e2e deferred |
| Semaphore concurrency | scheduling | TaskPool worker limit | running-count metrics | L1 | No |
| zod/MCP SDK | library | static schemas | tool call validation | L1 | No |

## Seam inventory

| Seam ID | Boundary | Current coupling | Proposed seam | Production impact | Test use only? | Decision |
|---|---|---|---|---|---|---|
| SEAM-PROTOCOL | wire protocol (types + parsers) vs SSH execution | parseJobStatus/parseJobLogs/parseProtocol/helpers + builders all in jobs.ts | packages/jobs exports generic TaskStatus/TaskLogs/parseProtocol + helpers; SSH builders stay in ssh-mcp | jobs.ts slimmed to SSH adapter + tools | No | Extract generic core |
| SEAM-SEMAPHORE | concurrency limiter | Semaphore in process.ts imported by jobs.ts + server.ts | Semaphore in packages/jobs; process.ts re-exports | no behavior change | No | Move + re-export |
| SEAM-SHELLQUOTE | shell quoting util | shellQuote in policy.ts imported by jobs/ssh/server | shellQuote in packages/jobs; policy.ts re-exports | no behavior change | No | Move + re-export |
| SEAM-EXECUTOR | SSH transport execution | execute() inline in registerJobTools | SSH TaskExecutor implements TaskExecutor interface from packages/jobs (conformance only; tools stay on inline execute() + Semaphore, NOT routed through TaskPool.submit()) | tool flow unchanged | No | Introduce interface |
| SEAM-UNIX-E2E | real sh execution | itWithUnixShell skips on win32 | keep skip; mark as real-boundary follow-up | unchanged | Yes (skipped) | Preserve |

## Non-determinism

| Source | Risk | Control | Reproduction data |
|---|---|---|---|
| Time/timezone | builder/parser timestamps vary; TaskPool timeout/retention | assert substrings only; TaskPool MUST accept injectable clock (no real timers in time-based tests) | fixture strings; fake clock |
| Randomness/IDs | jobId unique per call | not asserted deterministically | n/a |
| Thread scheduling | TaskPool concurrency order | deterministic fake executor + count-based assertions | test scripts |
| Network/external service | broker/runSsh | not unit-tested; interface seam | n/a |
| Filesystem/path | /tmp/helix/jobs paths | builders produce paths; parsers read strings | fixtures |

## Observability

- Observable output: TaskStatus/TaskLogs structures with state/pid/exitCode/timestamps/logPath/logSizeBytes/nextCursor/eof/content.
- Error observation: invalid task id throws; unknown states normalize to "unknown"; not_found state for missing dir.
- State observation: queued→running→succeeded/failed/cancelled; lost when pid gone without exit code.
- Logs/events/metrics: TaskPool exposes metrics (running/queued/completed/failed/cancelled counts, queue depth, worker utilization, task latency).
- Sensitive information restrictions: builders never log command payload; command stored base64; storageState/auth not involved.

## Test infrastructure tasks

| Task ID | Change | Why separate from business GREEN | Completion condition |
|---|---|---|---|
| INFRA-001 | Add packages/jobs to root workspaces, package.json, tsconfig, vitest | shared lib must build/test under root | npm run test --workspaces covers it |
| INFRA-002 | process.ts/policy.ts re-export Semaphore/shellQuote from @helix/jobs | avoid breaking existing imports (server.ts, ssh.ts) | check passes |

## Real boundary requirements

- Boundaries that must not be mocked: none in unit layer (protocol is pure); the remote job engine e2e already requires real Unix shell and is skipped on win32.
- Required target-equivalent environment: LINUX-SSH-TARGET for the skipped e2e; documented in topology equivalence (not equivalent for shell execution on Windows).
- Evidence unavailable locally: live remote job e2e on a Unix SSH host.
- Follow-up integration stage: real-host validation after refactor, or during browser-mcp phase.

## Prohibited test-only design changes

- Do not weaken the Unix-only e2e to run on Windows.
- Do not mock broker/runSsh inside jobs.test.ts to claim integration coverage.
- Do not change HELIX_JOB_* markers or field names to make tests easier.

## Gate decision

- Decision: PASS
- Findings: Semaphore and shellQuote are imported by multiple modules; move must preserve re-export paths to avoid breaking server.ts/ssh.ts.
- Required actions: INFRA-001 + INFRA-002 before RED; run full suite after each cycle.
- Reviewer: engineering-workflow-test-strategy-architect (G00 delegation)
