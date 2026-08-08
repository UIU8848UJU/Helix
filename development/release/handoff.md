# Release Handoff — REPO-003 (Task pool refactor: extract shared Task Runtime)

- schema_version: "2.1"
- work_item_id: REPO-003
- task_name: "Extract generic Task Runtime (packages/jobs) from apps/ssh-mcp, wire SSH Runtime, regression green"
- date: "2026-08-08"
- status: HANDOFF_READY (commit + push is the next explicit step)
- detailed handoff: development/releases/REPO-003-handoff.md

## What is being handed off

- **New workspace** `packages/jobs` (@helix/jobs 0.1.0): generic Task Runtime core —
  TaskState machine, TaskStatus/TaskLogs, TaskType registry, task-id validation,
  parseProtocol/base64/optional-number helpers, Semaphore, shellQuote, TaskPool (submit/status/
  cancel via injected TaskExecutor; bounded queue, worker limit, priority, injectable-clock
  timeout, retention, metrics).
- **Refactored** `apps/ssh-mcp`: jobs.ts/process.ts/policy.ts now consume @helix/jobs.
  `SshJobExecutor implements TaskExecutor` (conformance only). SSH sh-script builders +
  broker/runSsh execution stay in ssh-mcp. job_* tools remain on inline `execute()` + Semaphore
  (no TaskPool rewiring).
- **Behavior unchanged**: job_* output shapes (jobId + privileged), state names, error messages,
  and the Unix-only e2e skip on win32 are byte-identical.

## Verification summary

- ssh-mcp: **46 passed / 1 skipped** (was 44/1; +2 identity assertions).
- packages/jobs: **23 passed**.
- Root `npm run build`: PASS. Root `npm run test`: **69/1** PASS.
- G15 independent review: PASS (invocations a5d73f2 CONDITIONAL_PASS → a62eb5b PASS).
- Validators: development-ready + delivery-ready profiles both PASS.

## Artifact flow

- `packages/jobs` → build/ (gitignored; `prepare: npm run build` regenerates on install).
- `apps/ssh-mcp` → build/.
- npm workspaces order `["packages/*", "apps/*"]` (dependencies build before dependents).

## Deferred (by design, not drift)

- Real-host integration on LINUX-SSH-TARGET (Unix-only e2e stays skipped on win32).
- Whether job_* tools later route through TaskPool (TaskSpec is too generic to carry SSH
  host/cwd/env/sourceScripts/privileged).

## Handoff checklist

- [x] topology ref/revision handed off (rev 1, unchanged; no approved topology change)
- [x] final snapshot updated (test_baseline + environment_snapshot)
- [x] artifact flow documented
- [x] release verification environment/binding documented (DEV-WINDOWS / UNIT-LOCAL+BUILD-LOCAL)
- [x] unclosed drift declared (none; deferred items listed)
- [x] G15 independent reviewer delegation evidence recorded
- [x] delivery-ready artifacts complete (quality/ + release/ + traceability)
- [ ] commit + push (explicit user action, not performed)
