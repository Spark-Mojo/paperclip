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
- **D3 (discovered mid-run, pre-existing, OUT of this card's scope)** — fork migrations
  `0280`/`0281` (carry `c7d16cf2d`) have no drizzle snapshot files; the journal's newest
  entry (idx 281) points at a nonexistent `meta/0281_snapshot.json`, so
  `migration-snapshot-drift.test.ts` (workspaces-b lane) fails with ENOENT. Failed
  identically on the base run (job 108592510828) before any change — previously hidden
  in the noise. Routed as a follow-up card, not fixed here.

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
  CHECK: grep -c '"build": "pnpm run prepare:runner-vendor && node scripts/verify-runner-vendor-dependencies.mjs && tsc' server/package.json
  EXPECT: 1
  RESULT: exit 0, count 1 — PASS (commit 17a81879f)

### G2 — engine install.sh prepares ui-dist serially after server build
  CHECK: grep -c 'pnpm run prepare:ui-dist' scripts/engine/install.sh
  EXPECT: 1
  RESULT: exit 0, count 1 — PASS (commit 17a81879f; bash -n clean)

### G3 — D1 no longer reproducible (server build no longer rebuilds ui)
  CHECK: covered by G1 (no `prepare:ui-dist` in server `build`) + G4 (serialized server
  build passes through tsc) + G8 (CI Build/Canary green).
  RESULT: server build script contains no ui rebuild; CI `ci / Build` PASS and
  `ci / Canary Dry Run` PASS on run 36316428876 — PASS

### G4 — server build reaches tsc (the previously masked step)
  CHECK: pnpm --filter @paperclipai/server run build
  EXPECT: exit 0 through tsc + build-stamp
  RESULT: exit 0; log tail `[build-stamp] wrote ... commit=5e4ef1367`; includes cargo
  build of runner, verify-runner-vendor-dependencies, tsc, asset copies — PASS

### G5 — contradictory setup file gone (file + config entry)
  CHECK: ls server/src/__tests__/setup-disposable-test-environment.ts; grep -c setup-disposable server/vitest.config.ts
  EXPECT: no file; grep count 0
  RESULT: ls exit 2 (absent); grep count 0 — PASS (commits 3de85c6f9 + follow-up 615a64bad;
  the first commit's config edit was lost in a local stash mishap and every shard failed
  with 'Cannot find module setup-disposable-test-environment.ts' on CI run 36314763630 —
  caught by CI, fixed by 615a64bad, confirmed green on run 36316428876)

### G6 — server test shards collect and pass through the harness
  CHECK: pnpm test:run:serialized -- --shard-index N --shard-count 9
  EXPECT: exit 0, no 'must not be inherited'
  RESULT: post-fix local: shard 0 exit 0 (15/15, 5/5, 13/13, 24/24, 8/8 across its
  suites); shard 4 ran 60 tests (59 pass, 1 pre-existing 15s-timeout flake proven
  identical on pristine base); shard 7 same shape. Pre-fix control on pristine base:
  shards 0/4/7 ALL die at setup with 'PAPERCLIP_CONFIG must not be inherited', 0 tests.
  CI: 12/12 server shards + 3/3 chat shards green on run 36316428876; serialized 7/9
  green (2/9 red on pre-existing defects D3-class + inbox-archive query bug, see G8) — PASS

### G7 — FORK-PATCHES rows exist for both changes
  CHECK: grep -c 'SPA-8995' doc/FORK-PATCHES.md
  EXPECT: 2
  RESULT: exit 0, count 2 (rows 10 and 11) — PASS

### G8 — CI green on the pushed line (PR #76, head 615a64bad, run 36316428876)
  CHECK: gh api .../runs/36316428876/jobs --jq conclusions
  EXPECT: `ci / Build` green; server/chat shards green; NO job green-at-base now red
  RESULT: 28 failing jobs at base (run 36309467897) → 5 failing at fix head. Zero new
  failures (verified by set-difference of failing job names). `ci / Build` PASS (6m54s),
  `ci / Canary Dry Run` PASS (9m31s), `ci / Typecheck + Release Registry` PASS, all 3
  chat shards PASS, 11/12 server shards PASS, serialized 7/9 PASS, e2e 8/8 PASS.
  The 5 residual failures each failed identically at base:
  - `workspaces-b` — D3 (0281 snapshot ENOENT), pre-existing (base job 108592510828)
  - `server (12/12)` — secrets-service AWS IAM denial, pre-existing, environmental
  - `serialized 2/9` — instance-settings `runner.select is not a function` TypeError,
    pre-existing
  - `serialized 7/9` — inbox-archive-routes 'Failed query: delete from heartbeat_runs',
    pre-existing
  - `ci / verify` — pure aggregator: fails because General tests failed; its own log
    shows BUILD_RESULT: success
  — PASS for this card's two defects; D3-class residuals routed as follow-up cards

## Residuals (pre-existing, not caused by this PR — each proven failing at base)

1. **D3: missing drizzle snapshots 0280/0281** (fork carry `c7d16cf2d` added SQL + journal
   entries but no `meta/0280_snapshot.json`/`0281_snapshot.json`). Follow-up card needed:
   either generate the two snapshots or renumber the fork migrations below upstream's
   0280 (`0280_unique_genesis`) to avoid the next-rebuild collision.
2. **secrets-service AWS IAM denial** in server 12/12 — needs credentials or a mock in CI.
3. **instance-settings `runner.select is not a function`** (serialized 2/9) — test
   environment defect.
4. **inbox-archive-routes heartbeat_runs delete failure** (serialized 7/9) — DB state
   leakage between suites or a genuine query bug.
5. Two 15s-timeout flakes (`agent-live-run-routes` compact-payload, `adapter-auth-signal-routes`
   codex-present) — observed locally, load-dependent.

