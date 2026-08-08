# Cycle Evidence — TDD-101 (packages/jobs core)

## RED

- execution_binding_id: UNIT-LOCAL
- execution_role: unit_test
- environment_id: DEV-WINDOWS
- execution_context_id: host-shell
- working_directory: F:/AI_infra/Helix
- command: `npm run test --workspace @helix/jobs`
- pre_implementation_revision: 4be1d14 (src/index.ts is an empty `export {}` stub)
- exit_code: 1
- failure_classification: TARGET_BEHAVIOR_MISSING
- raw_log (excerpt):
  ```
  Test Files  4 failed (4)
  Tests       21 failed | 2 passed (23)
  TypeError: TaskPool is not a constructor
    ❯ test/task-pool.test.ts:141:18
  TypeError: assertTaskId is not a function
  TypeError: parseProtocol is not a function
  TypeError: Semaphore is not a constructor
  ```
- control_experiment: stub exports nothing; failures are "not a function / not a constructor" for every requested symbol — confirms missing implementation, not environment error.

## GREEN

- execution_binding_id: UNIT-LOCAL
- execution_role: unit_test
- environment_id: DEV-WINDOWS
- execution_context_id: host-shell
- working_directory: F:/AI_infra/Helix
- command: `npm run test --workspace @helix/jobs`
- implementation_revision: 4be1d14 + working-tree (packages/jobs implementation uncommitted at evidence time)
- exit_code: 0
- target_log (excerpt):
  ```
  Test Files  4 passed (4)
  Tests       23 passed (23)
  ```
- minimal_green_boundary check: all four test files pass; TaskPool, Semaphore, parseProtocol, TaskStatus, TaskLogs, TaskState, TaskType, assertTaskId, shellQuote all exported from packages/jobs (defined locally, not re-exported from ssh-mcp). TaskStatus uses `taskId`; TaskState reuses ssh-mcp state names (queued/running/succeeded/failed/cancelled/lost/not_found). TaskPool timeout/retention tests use the injectable clock (no real timers).
- regression_commands (all PASS, exit_code 0):
  - `npm run check --workspace @helix/ssh-mcp` → tsc --noEmit, clean
  - `npm run test --workspace @helix/ssh-mcp` → 44 passed | 1 skipped (45)
  - `npm run build` → @helix/jobs + @helix/ssh-mcp build PASS
  - `npm run test` → @helix/jobs 23 passed + @helix/ssh-mcp 44 passed | 1 skipped
- assertions_weakened: false
- skips_added: false
- tolerances_expanded: false
- core_boundary_mocked: false

## REFACTOR

- No behavior-changing refactor required; the implementation was written to satisfy RED tests directly.
- Remaining debt: ssh-mcp (apps/ssh-mcp/src/jobs.ts) still carries a local parallel implementation; consumed in TDD-102.
