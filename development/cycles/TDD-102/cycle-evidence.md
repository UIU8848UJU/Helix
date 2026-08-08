# Cycle Evidence — TDD-102 (ssh-mcp consumes @helix/jobs)

## RED

- execution_binding_id: UNIT-LOCAL
- execution_role: unit_test
- environment_id: DEV-WINDOWS
- execution_context_id: host-shell
- working_directory: F:/AI_infra/Helix
- command: `npm run test --workspace @helix/ssh-mcp`
- pre_implementation_revision: 4be1d14 + working-tree (TDD-101 implementation; ssh-mcp still on local Semaphore/shellQuote copies)
- exit_code: 1
- failure_classification: TARGET_BEHAVIOR_MISSING
- raw_log (excerpt):
  ```
  Test Files  1 failed | 8 passed (9)
  Tests       2 failed | 44 passed | 1 skipped (47)
  AssertionError: expected [Function Semaphore] to be [Function Semaphore] // Object.is equality
  AssertionError: expected [Function shellQuote] to be [Function shellQuote] // Object.is equality
  ```
- control_experiment: @helix/jobs is resolvable (dependency linked) and exports Semaphore/shellQuote; ./process.js and ./policy.js still export distinct local objects, so both `toBe` identity assertions fail. The two failures are exactly the assertions that prove the shared-piece swap has not happened yet.

## GREEN

- execution_binding_id: UNIT-LOCAL
- execution_role: unit_test
- environment_id: DEV-WINDOWS
- execution_context_id: host-shell
- working_directory: F:/AI_infra/Helix
- command: `npm run test --workspace @helix/ssh-mcp`
- implementation_revision: 4be1d14 + working-tree (uncommitted at evidence time)
- exit_code: 0
- target_log (excerpt):
  ```
  Test Files  9 passed (9)
  Tests       46 passed | 1 skipped (47)
  ✓ test/identity.test.ts (2 tests)
  ```
- minimal_green_boundary check:
  - ssh-mcp check passes (tsc --noEmit clean)
  - identity.test.ts passes — Semaphore (via ./process.js) and shellQuote (via ./policy.js) ARE the @helix/jobs objects
  - full ssh-mcp suite 46 pass / 1 skip (44 prior + 2 new identity assertions)
  - packages/jobs suite 23/23 pass
  - root npm run build && npm run test pass
  - generic TaskStatus uses taskId; ssh-mcp JobStatus keeps jobId + privileged (byte-identical output)
- regression_commands (all PASS, exit_code 0):
  - `npm run check --workspace @helix/ssh-mcp` → clean
  - `npm run test --workspace @helix/ssh-mcp` → 46 pass | 1 skip
  - `npm run build` → @helix/jobs + @helix/ssh-mcp PASS
  - `npm run test` → 23 + 46/1 PASS
- assertions_weakened: false
- skips_added: false
- tolerances_expanded: false
- core_boundary_mocked: false

## REFACTOR

- The refactor IS this cycle's GREEN: ssh-mcp now consumes @helix/jobs for the shared
  pieces instead of defining local copies.
- process.ts: local Semaphore class removed → `export { Semaphore } from "@helix/jobs"`.
- policy.ts: local shellQuote removed → import + `export { shellQuote }` from @helix/jobs.
- jobs.ts: parseProtocol/nullableNumber/decodeOptionalBase64/knownTaskType/knownTaskState/
  assertTaskId/Semaphore/shellQuote/TASK_TYPES now come from @helix/jobs. JOB_TYPES/JobType/
  JobState alias the generic TASK_TYPES/TaskType/TaskState. assertJobId delegates to the
  package's assertTaskId but preserves the SSH "Invalid Helix job id" message so job_*
  clients see byte-identical errors. SSH sh-script builders + broker/runSsh execution
  form `SshJobExecutor implements TaskExecutor` (conformance only — grep confirms no
  TaskPool/submit usage anywhere in apps/ssh-mcp/src; the single TaskPool mention is a
  comment documenting why tools stay on inline execute() + Semaphore).
- remaining_debt: none for REPO-003 scope. Later cycles may decide whether job_* tools
  should route through TaskPool (deliberately deferred; TaskSpec is too generic to carry
  SSH host/cwd/env/sourceScripts/privileged).
