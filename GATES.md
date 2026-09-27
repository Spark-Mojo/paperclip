# GATES.md — SPA-8995

Two fork-line defects make `rebuild/v2026.916.0-survivors` CI red and mask server `tsc`.
Fix on the survivors line (paperclip repo, branch off `origin/rebuild/v2026.916.0-survivors`).

## Root causes (proven this run)

- **D1** — fork commit `cdcbcfd8f` (2026-09-18, no FORK-PATCHES row) prepended
  `prepare:ui-dist &&` to `server/package.json` `build`. Root `pnpm build` = `pnpm -r build`
  now runs TWO CONCURRENT vite builds of `ui` into the same `ui/dist` (root ui lane +
  server lane). `serviceWorkerBuildIdPlugin` stamps `dist/sw.js` in `closeBundle`
  (removes `__PAPERCLIP_BUILD_ID__`); the loser's `closeBundle` reads the already-stamped
  file and throws. CI job 108592510520 (Build) log shows interleaved `ui build:` /
  `server build:` vite streams, `built in 8.53s` (09:34:38.93) vs throw at 09:34:39.90.
  Local runs serialized by accident (paperclip-runner build failed first here), which is
  why local green lied.
- **D2** — fork carry `c72668206` added `setup-disposable-test-environment.ts` which
  throws on any inherited `PAPERCLIP_CONFIG`; upstream `7ed122911` (inherited in the 916
  base) makes `run-vitest-stable.mjs` SET `PAPERCLIP_CONFIG` for every vitest child.
  Every server/chat shard dies at setup: `PAPERCLIP_CONFIG must not be inherited by
  server tests` (CI job 108592510592). Upstream never had the setup file; upstream runs
  green with the harness value (config.ts, paths.ts, config-file.ts, worktree-config.ts,
  env-file-policy.ts all byte-identical fork↔upstream).

## Fix (advisor-backed: minimize divergence)

- **Fix 1 (D1)**: revert `cdcbcfd8f`'s `server/package.json` change (restore upstream
  `build` script); relocate ui-dist preparation to fork-owned
  `scripts/engine/install.sh` after the serialized server build (the git-ref path that
  needed it). Add the missing FORK-PATCHES row for `cdcbcfd8f` documenting the relocation.
- **Fix 2 (D2)**: delete `server/src/__tests__/setup-disposable-test-environment.ts` +
  its test + the vitest setupFiles entry (adopt upstream's own resolution: harness
  `PAPERCLIP_CONFIG` → disposable temp path IS the disposable-config guard; disposable-db
  guard lives in `packages/db/src/test-embedded-postgres.ts:284,287` already).
  FORK-PATCHES row documents the retirement of the fork-only file.

## Gates

### G1 — server build script restored to upstream shape
  CHECK: git -C <paperclip repo> show HEAD:server/package.json | grep -c '"build": "pnpm run prepare:runner-vendor && node scripts/verify-runner-vendor-dependencies.mjs && tsc'
  EXPECT: 1

### G2 — engine install.sh prepares ui-dist serially after server build
  CHECK: grep -c 'prepare:ui-dist' scripts/engine/install.sh
  EXPECT: 1 (a positive count; the relocated step)

### G3 — D1 no longer reproducible: concurrent double-build stamps exactly once, no throw
  CHECK: rm -rf ui/dist && (pnpm --filter @paperclipai/ui build & pnpm --filter @paperclipai/server prepare:ui-dist & wait) ; echo EXIT=$?
  EXPECT: EXIT=0 and dist/sw.js stamped (placeholder absent) — pre-fix this throws.
  NOTE: pre-fix reproduction is via `prepare:ui-dist` WITHOUT the reuse env var; after
  Fix 1 the server build no longer rebuilds ui at all, so the race cannot occur. Gate
  reduces to: server `build` script contains no `prepare:ui-dist` (G1) and a serial
  root build reaches server `tsc` (G4).

### G4 — root build reaches server tsc (the masked step)
  CHECK: pnpm --filter @paperclipai/server run build (with ui/dist prebuilt) |& tail -3
  EXPECT: contains no 'placeholder' error; tsc completes (exit 0)
  (Full `pnpm build` also exercises paperclip-runner `build:binary`, which needs cargo —
  environmental, out of scope; server package build alone proves the unmasking.)

### G5 — contradictory setup file gone
  CHECK: ls server/src/__tests__/setup-disposable-test-environment.ts 2>/dev/null; grep -c setup-disposable server/vitest.config.ts
  EXPECT: no file (exit non-zero on ls) and 0 from grep

### G6 — one server test shard collects >0 tests through the harness
  CHECK: timeout 900 pnpm test:run:serialized -- --shard-index 0 --shard-count 9
  EXPECT: exit 0; output contains no 'must not be inherited'; test files collected > 0
  (Pre-fix: dies at setup with 'PAPERCLIP_CONFIG must not be inherited by server tests'.)

### G7 — FORK-PATCHES rows exist for both changes
  CHECK: grep -c 'SPA-8995' doc/FORK-PATCHES.md
  EXPECT: 2 (one row per defect fix; D1 also documents the cdcbcfd8f relocation)

### G8 — CI green on the pushed line
  CHECK: gh run list --repo Spark-Mojo/paperclip --branch <fix branch> (after PR/push)
  EXPECT: `ci / Build` and one server shard green; verified via gh in a later heartbeat
  if the run outlives this one.
