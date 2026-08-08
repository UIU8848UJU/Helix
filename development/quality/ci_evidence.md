# CI Evidence — REPO-003 (Task pool refactor: extract shared Task Runtime)

- schema_version: "2.1"
- work_item_id: REPO-003
- date: "2026-08-08"
- execution_environment: DEV-WINDOWS / host-shell / UNIT-LOCAL + BUILD-LOCAL
- repository_head: 4be1d14 (implementation was uncommitted at evidence time; committed via G16)

## Commands and results

All commands run from `F:/AI_infra/Helix`.

| # | Command | Exit | Result | Evidence |
|---|---------|------|--------|----------|
| 1 | `npm run check --workspace @helix/ssh-mcp` | 0 | PASS — tsc --noEmit | regression.log |
| 2 | `npm run test --workspace @helix/ssh-mcp` | 0 | PASS — 9 files, 46 passed / 1 skipped | green.log, regression.log |
| 3 | `npm run test --workspace @helix/jobs` | 0 | PASS — 4 files, 23 passed | green.log |
| 4 | `npm run build` (root, workspaces) | 0 | PASS — @helix/jobs + @helix/ssh-mcp build | regression.log |
| 5 | `npm run test` (root) | 0 | PASS — 23 (jobs) + 46/1 (ssh-mcp) = 69/1 | regression.log |

## Combined release regression (G15 independent re-run)

- command: `npm run check --workspace @helix/ssh-mcp && npm run test --workspace @helix/ssh-mcp && npm run build && npm run test`
- exit_code: 0
- total: **69 passed / 1 skipped** (skipped = Unix-only remote job e2e on win32)
- reviewer: engineering-workflow-delivery-quality-reviewer (invocation a62eb5b766c6afd5b)

## Fresh-checkout build-order check (G15 MAJOR finding resolution)

- reproduction: `rm -rf packages/jobs/build` then `npm install` then `npm run check --workspace @helix/ssh-mcp`
- fix: `packages/jobs/package.json` `prepare: npm run build` regenerates the gitignored `build/`
  on install, so CI's check-before-build order works.
- result: check exits 0 after clean install.

## Skipped tests

- `apps/ssh-mcp/test/jobs.test.ts` — remote job local e2e, `itWithUnixShell`, skipped on win32
  (justified in test + topology; deferred to LINUX-SSH-TARGET integration).

## Validator

- `validate_tdd_workspace.py development --profile development-ready` → PASS
- `validate_tdd_workspace.py development --profile delivery-ready` → PASS (after G16 artifacts)
