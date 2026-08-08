# Rollback Plan — REPO-003 (Task pool refactor: extract shared Task Runtime)

- schema_version: "2.1"
- work_item_id: REPO-003
- date: "2026-08-08"
- release_ref: development/releases/REPO-003-handoff.md

## Trigger

Roll back if any of the following are observed after release:

- `@helix/jobs` build/ is missing or stale and `npm run check --workspace @helix/ssh-mcp`
  fails with TS2307 (module resolution to packages/jobs fails).
- ssh-mcp job_* tool output shapes drift from pre-REPO-003 (jobId + privileged fields, error
  messages) and a consumer depends on the old byte-level shape.
- Root `npm run build` or `npm run test` fails on the workspace graph.

## Recovery steps (in order)

### 1. Quick fix: regenerate build/

Because `packages/jobs/package.json` has `prepare: npm run build`, the gitignored `build/`
regenerates on `npm install`. A missing/stale build is fixed by:

```
npm install
npm run check --workspace @helix/ssh-mcp
npm run build
npm run test
```

### 2. Fast-forward-ish revert to pre-REPO-003

REPO-003 is additive (new `packages/` workspace + ssh-mcp refactor), so the pre-REPO-003 state is
the parent commit of the G16 commit. To fully revert:

```
git revert <REPO-003-commit>          # or: git checkout <parent> -- apps/ssh-mcp
git checkout <parent> -- package.json package-lock.json
rm -rf packages/jobs                   # remove new workspace
npm install
npm run check --workspace @helix/ssh-mcp && npm run test --workspace @helix/ssh-mcp && npm run build && npm run test
```

The ssh-mcp workspace at the parent commit is self-contained (local Semaphore/shellQuote/parse
helpers), so no external dependency is needed to restore behavior.

### 3. Verify rollback

- ssh-mcp suite returns to the pre-REPO-003 shape (44 passed / 1 skipped, 8 test files).
- Root `npm run build` and `npm run test` exit 0 without the `packages/*` workspace.

## Risk notes

- The job_* tools were NOT rewired through TaskPool (conformance adapter only), so no runtime
  scheduling path changed; rollback is a pure source-state revert with no runtime migration.
- No schema or on-disk state was changed; the broker/privileged/audit/sudo logic is untouched.

## Owner

- Rollback owner: engineering-workflow-tdd-coordinator (with delivery-quality reviewer for
  go/no-go on the trigger).
