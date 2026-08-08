# Release / Handoff — REPO-003 (Task pool refactor: extract shared Task Runtime)

- schema_version: "2.1"
- work_item_id: REPO-003
- task_name: "Extract generic Task Runtime (packages/jobs) from apps/ssh-mcp, wire SSH Runtime, regression green"
- date: "2026-08-08"
- status: HANDOFF_READY (uncommitted working tree; commit + push is the next explicit step)

## Topology

- topology_ref: `.skillmatrix/engineering/environment-topology.yaml`
- topology_revision: "1" (unchanged — no environment changes were required)
- approved_topology_change: NONE
- release_verification_environment: DEV-WINDOWS (host-shell)
- release_verification_binding: UNIT-LOCAL / BUILD-LOCAL / SOURCE-EDIT-LOCAL
- deferred_environment: LINUX-SSH-TARGET (remote-shell) — real-host job e2e integration is
  deferred to a later phase; the Unix-only e2e stays skipped on win32 (justified in
  `apps/ssh-mcp/test/jobs.test.ts` and topology).

## Final snapshot

- environment_snapshot_ref: `development/baseline/environment_snapshot.yaml`
- test_baseline_ref: `development/baseline/test_baseline.yaml`
- pre-task HEAD: `4be1d14e3f6872bdbf371881988d0666bf769361`
- current: `4be1d14` + working tree (implementation uncommitted at handoff time)
- ssh-mcp suite: **46 passed | 1 skipped (47)** (was 44/1; +2 identity assertions)
- packages/jobs suite: **23 passed (23)**
- root `npm run build`: PASS (@helix/jobs + @helix/ssh-mcp)
- root `npm run test`: PASS (23 + 46/1)
- workspace validator: `validate_tdd_workspace.py development --profile development-ready` → PASS

## Artifact flow

- `packages/jobs` (`@helix/jobs` 0.1.0, private workspace):
  `src/*.ts` (task-types, task-id, protocol, shell, semaphore, task-pool, index) → build/ → consumed by `apps/ssh-mcp`.
  - `prepare: npm run build` regenerates the gitignored `build/` on `npm install`, fixing the
    fresh-checkout / CI build-order gap (CI installs before check/test).
- `apps/ssh-mcp` (`@helix/ssh-mcp` 0.3.0):
  `src/jobs.ts` (SSH sh-script builders + `SshJobExecutor implements TaskExecutor` conformance adapter +
  tools) / `src/process.ts` (re-exports Semaphore) / `src/policy.ts` (re-exports shellQuote) → build/.
  - job_* tools stay on inline `execute()` + Semaphore; **no** TaskPool rewiring (grep-verified).
- npm workspaces order: `["packages/*", "apps/*"]` (dependencies build before dependents).

## Release verification

- command: `npm run check --workspace @helix/ssh-mcp && npm run test --workspace @helix/ssh-mcp && npm run build && npm run test`
- exit_code: 0
- environment: DEV-WINDOWS / host-shell / UNIT-LOCAL+BUILD-LOCAL
- G15 independent reviewer re-ran all four commands and the fresh-checkout simulation (rm -rf
  packages/jobs/build → npm install regenerates → check exit 0). See
  `development/reviews/G15-delivery-quality.yaml`.

## Unclosed drift

- NONE (environment snapshot `drift: []`). The working tree is uncommitted; the diff is fully
  captured by the cycles' `production_diff` and `development/reviews/G15-delivery-quality.yaml`.
- Deferred (by design, not drift): real-host integration on LINUX-SSH-TARGET; whether job_* tools
  later route through `TaskPool` (TaskSpec is too generic to carry SSH host/cwd/env/sourceScripts/
  privileged — documented in `apps/ssh-mcp/src/jobs.ts`).

## G15 delegation evidence

- `development/reviews/G15-delivery-quality.yaml`
  - invocation `a5d73f2be4098a558` → CONDITIONAL_PASS (1 major build-order finding + 2 minor docs)
  - invocation `a62eb5b766c6afd5b` → PASS (all findings resolved, full regression re-verified)

## Handoff checklist

- [x] topology ref/revision handed off (rev 1, unchanged)
- [x] final snapshot updated (test_baseline + environment_snapshot)
- [x] artifact flow documented
- [x] release verification environment/binding documented (DEV-WINDOWS / UNIT-LOCAL+BUILD-LOCAL)
- [x] unclosed drift declared (none; deferred items listed)
- [x] approved topology change declared (none)
- [x] G15 independent reviewer delegation evidence recorded
- [x] delivery-ready artifacts complete (quality/ + release/ + traceability; delivery-ready validator PASS)
- [ ] commit + push (explicit user action, not performed)
