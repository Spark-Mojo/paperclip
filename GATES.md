# GATES — SPA-9038: done-guard also checks PR links in card comments/description

Base: `rebuild/v2026.916.0-survivors` @ `08b514a59` (post-PR #81). James ruled option 1
(2026-09-27): besides `pull_request` work products, parse the card's description and
comments for GitHub PR URLs in Spark-Mojo repos; refuse `done` while any of them is
OPEN. Closed-unmerged counts as deliberately closed and is allowed.

## Gate 0 — pre-change regression red (the SPA-9036 shape)
  CHECK: cd server && npx vitest run src/__tests__/issue-done-pr-merged-gate.test.ts -t "comment-only Spark-Mojo PR link \(open\)" 2>&1 | tail -6
  EXPECT on the BASE (revert the feat commit): the comment-only-open test is missing (0 matched) and the "prose PR mentions are not a binding" test (Spark-Mojo URL) PASSES — that's the defect. Run after revert: red, run after fix: green.

## Gate 1 — comment-only + description-only states all green
  CHECK: cd server && npx vitest run src/__tests__/issue-done-pr-merged-gate.test.ts 2>&1 | tail -4
  EXPECT: "Tests 17 passed (17)". Embedded Postgres.

## Gate 2 — comment-scoped tests present and green
  CHECK: cd server && npx vitest run src/__tests__/issue-done-pr-merged-gate.test.ts -t "comment" 2>&1 | grep -E "Tests|passed|failed" | head -1
  EXPECT: "Tests N passed" with N ≥ 3 (comment-only open/merged/closed-unmerged).

## Gate 3 — TypeScript clean on changed surface
  CHECK: cd server && npx tsc --noEmit 2>&1 | grep -E "issue-done-gate|issues\.ts\(|github-pull-request-merge\.ts" | wc -l
  EXPECT: 0 — no errors mentioning the files this change touched.

## Gate 4 — pre-existing tsc errors unchanged (no new delta)
  CHECK: cd server && npx tsc --noEmit 2>&1 | grep -c "TS2307"; echo "BASE_COUNT"
  EXPECT: BASELINE_COUNT on the change == BASELINE_COUNT on origin/rebuild/v2026.916.0-survivors. (Measured base = 17 pre-existing paperclip-runner resolution errors from SPA-8881 row 13's fork-only import; unchanged by this fix.)

## Gate 5 — fork-patches row 14 recorded
  CHECK: git diff origin/rebuild/v2026.916.0-survivors -- doc/FORK-PATCHES.md | grep -c "SPA-9038"
  EXPECT: ≥1 — the row documents the extension; rollback = revert the single feat commit (no schema, no migration, no data write).

## Gate 6 — no new migration files
  CHECK: ls packages/db/src/migrations/*.sql | wc -l; echo "BASE_COUNT=281"
  EXPECT: count == 281 (unchanged). SPA-9038 adds no schema change.

## Install gates (SPA-9018 checklist discipline, executed at install time, batched per James's instruction — NOT before push/merge; the same one-restart discipline)

## Gate I1 — live-runs = 0 pre-flip
  CHECK: curl -s http://127.0.0.1:3100/api/companies/5f872702-0dc1-4a58-817c-774b614f1665/live-runs (loopback, unauth)
  EXPECT: 0 runs

## Gate I2 — rollback target recorded
  CHECK: readlink ~/.paperclip/instances/default/cli/current
  EXPECT: payload sha recorded in the closing comment as rollback target

## Gate I3 — post-flip health (dual probe)
  CHECK: curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/api/health; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/api/companies
  EXPECT: 200 / 200

## Gate I4 — no new schema errors (5-min window post-flip)
  CHECK: scan live log window for "does not exist"
  EXPECT: 0 matches in the 5-min window

## Gate I5 — migration parity
  CHECK: count packages/db/src/migrations SQL files
  EXPECT: count == 281 (unchanged by SPA-9038)

---

# GATES — SPA-8998: close four pre-existing CI residuals on the survivors line

Base: `rebuild/v2026.916.0-survivors` @ `6446d1a288` (post-PR #84). Four defects filed
from SPA-8995 run `9e6acbe7` once the ~26 shard-killing failures cleared. All proven
failing identically on base run `36309467897` before any SPA-8995 change. SPA-8998
scope: A (drizzle snapshots 0280/0281) + B (serialized shard 2/9 terminal-recomplete)
+ C (serialized shard 7/9 heartbeat_runs FK) + D (server 12/12 cancelLiveRunsForIssue
mock). Out of scope: secrets-service AWS IAM WARN-level noise (passed latest run,
env-dependent); two 15s-timeout flakes (compact-payload, codex-present, pre-existing).

Head: `ty/SPA-8998` @ `0ed1d16536`. PR: https://github.com/Spark-Mojo/paperclip/pull/90

## Gate A1 — drizzle snapshot drift test green (workspaces-b, Defect A)
  CHECK: pnpm --filter @paperclipai/db exec vitest run src/migration-snapshot-drift.test.ts 2>&1 | tail -3
  EXPECT: "Tests 1 passed" (was "ENOENT: .../meta/0281_snapshot.json").

  Result on head: NOT RUN LOCALLY (db package depends on embedded Postgres + drizzle
  fixture unavailable in this worktree's no-internet sandbox). CI run 36387265410
  job 108815200576 ("ci / General tests (workspaces-b)") reports "Test Files 58
  passed (58)" / "Tests 1223 passed | 5 skipped" / "1 unhandled error: write
  EPIPE" (out of scope; reproducible on `origin/rebuild/v2026.916.0-survivors`
  base without this PR — verified locally against base-check worktree
  6adedbf27b). The drift test passed within that 1223.

## Gate A2 — check:migrations exits 0 (Defect A)
  CHECK: pnpm --filter @paperclipai/db check:migrations 2>&1 | tail -3; echo "EXIT=$?"
  EXPECT: "EXIT=0". Validates duplicate-number / strict-ordering / journal-match.

  Result on head: NOT RUN LOCALLY (db package depends on embedded Postgres +
  drizzle fixtures unavailable in this sandbox). CI build job 108815199897 ("ci
  / Build") passed; build runs `check:migrations` as part of `pnpm build`.

## Gate A3 — db package builds (Defect A surface)
  CHECK: pnpm --filter @paperclipai/db build 2>&1 | tail -3
  EXPECT: clean exit. No `Duplicate migration number` throw from
  `check-migration-numbering.ts`.

  Result on head: NOT RUN LOCALLY. CI run 36387265410 job 108815199897 ("ci /
  Build") SUCCESS.

## Gate A4 — migration files renumbered (Defect A renumber decision)
  CHECK: ls packages/db/src/migrations/928*.sql 2>&1; ls packages/db/src/migrations/02[89]*.sql 2>&1
  EXPECT: 9280_handoff_bounded_continuation_escalation_idempotency.sql,
  9281_handoff_bounded_continuation_idempotency.sql, 9282_cascade_heartbeat_run_events_fk.sql
  all present. No 0280/0281 files. Reason recorded in FORK-PATCHES.md row 15:
  upstream `paperclipai/paperclip` journal is at `0284_petite_genesis` and
  `0280_unique_genesis` / `0281_true_boom_boom` are taken upstream; one-shot
  bump to 0282/0283 would re-collide on next upstream-tagged rebuild. 9xxx band
  reserves headroom for future fork patches.

  Result on head (local):
  - packages/db/src/migrations/9280_handoff_bounded_continuation_escalation_idempotency.sql: present
  - packages/db/src/migrations/9281_handoff_bounded_continuation_idempotency.sql: present
  - packages/db/src/migrations/9282_cascade_heartbeat_run_events_fk.sql: present
  - No 0280/0281 sql files in migrations dir. PASS.

## Gate A5 — meta snapshots present (Defect A)
  CHECK: ls packages/db/src/migrations/meta/{9280,9281,9282}_snapshot.json 2>&1
  EXPECT: three files present.

  Result on head (local): present. PASS.

## Gate A6 — FORK-PATCHES.md row 15 added
  CHECK: git diff origin/rebuild/v2026.916.0-survivors -- doc/FORK-PATCHES.md | grep -c "SPA-8998\|renumber"
  EXPECT: ≥ 1. The row records the renumber decision and the journal-when
  ordering fix (9280=1789390281191, 9281=1789390281192, both monotonic past
  0279's 1789390281190). The journal's when fields feed `folderMillis` in
  `applyPendingMigrations`; a re-order would silently produce inconsistent
  timestamps.

  Result on head (CI files): doc/FORK-PATCHES.md delta +8/-4, includes SPA-8998
  row 15. PASS.

## Gate B1 — serialized shard 2/9 terminal-recomplete green (Defect B)
  CHECK: cd server && timeout 120 node node_modules/vitest/vitest.mjs run --pool=forks --isolate src/__tests__/issue-dependency-wakeups-routes.test.ts 2>&1 | tail -3
  EXPECT: "Tests 8 passed (8)". Was 1 failed / 7 passed (test asserted 200 but
  fork guard at `routes/issues.ts:12880` returns 409 with
  `details.code=issue_write_terminal_recomplete` per SPA-5916 FORK-PATCHES
  row 3). Test now asserts the guard, matching fork behaviour.

  Result on head: NOT RUN LOCALLY (server test depends on fixtures not available
  in this worktree). CI run 36387265410 job 108815200252 ("ci / Verify
  serialized server suites (2/9)") SUCCESS.

## Gate B2 — fork guard still present (Defect B intent)
  CHECK: grep -n "issue_write_terminal_recomplete" server/src/routes/issues.ts
  EXPECT: ≥ 1 line. The fix updates the TEST to match the FORK guard; it does
  not remove or weaken the guard.

  Result on head: present at routes/issues.ts (same location SPA-5916 row 3
  carries). PASS.

## Gate C1 — inbox-archive-routes green (Defect C)
  CHECK: cd server && timeout 120 node node_modules/vitest/vitest.mjs run --pool=forks --isolate src/__tests__/inbox-archive-routes.test.ts 2>&1 | tail -3
  EXPECT: "Tests 8 passed (8)". Was 7 failed / 1 passed. FK
  `heartbeat_run_events.run_id -> heartbeat_runs.id` now carries
  `ON DELETE CASCADE` via new migration `9282_cascade_heartbeat_run_events_fk.sql`.

  Result on head: NOT RUN LOCALLY (server test depends on fixtures not available
  in this worktree). CI run 36387265410 job 108815200279 ("ci / Verify
  serialized server suites (7/9)") SUCCESS.

## Gate C2 — cascade migration present (Defect C intent)
  CHECK: cat packages/db/src/migrations/9282_cascade_heartbeat_run_events_fk.sql
  EXPECT: contains "ON DELETE CASCADE" applied to
  `heartbeat_run_events_run_id_heartbeat_runs_id_fk`.

  Result on head: present, +2/-0 lines. PASS.

## Gate C3 — schema declaration updated (drift test stays green)
  CHECK: grep -n "onDelete" packages/db/src/schema/heartbeat_run_events.ts
  EXPECT: ≥ 1 line with "onDelete.*cascade" or similar. Drift test compares the
  declared schema to the migration-applied state.

  Result on head: present (+3/-1). PASS.

## Gate D1 — heartbeat-cancel-live-runs-for-issue green (Defect D)
  CHECK: cd server && timeout 120 node node_modules/vitest/vitest.mjs run --pool=forks --isolate src/__tests__/heartbeat-cancel-live-runs-for-issue.test.ts 2>&1 | tail -3
  EXPECT: "Tests 8 passed (8)". Was 6 failed / 2 passed. Suite was BORN RED
  (verified identical 6/2 failure at SPA-7585's original commit `2dc6f4355`
  and at `origin/rebuild/v2026.916.0-survivors`).

  Result on head: NOT RUN LOCALLY (server test depends on fixtures not available
  in this worktree). CI run 36387265410 job 108815200511 ("ci / General tests
  (server (12/12))") SUCCESS.

## Gate D2 — D is test-only, no production change
  CHECK: git diff origin/rebuild/v2026.916.0-survivors --stat -- server/src/services/heartbeat.ts server/src/services/heartbeat | head -3
  EXPECT: empty diff. The four mock-gap additions are scoped to the test file
  only.

  Result on head: empty. PASS.

## Gate E1 — typecheck clean on changed surface
  CHECK: pnpm --filter @paperclipai/server exec tsc --noEmit 2>&1 | grep -E "heartbeat-cancel-live-runs-for-issue|issue-dependency-wakeups-routes|heartbeat_run_events|migrations" | wc -l
  EXPECT: 0 — no errors mentioning the files this change touched.

  Result on head: NOT RUN LOCALLY (server tsc depends on server fixtures). CI
  run 36387265410 job 108815199955 ("ci / Typecheck + Release Registry")
  SUCCESS.

## Gate E2 — no new tsc errors vs base (delta check)
  CHECK: pnpm --filter @paperclipai/server exec tsc --noEmit 2>&1 | grep -c "TS[0-9]"
  EXPECT: delta from base == 0. (Base measured: see CI's tsc job.)

  Result on head: CI run 36387265410 job 108815199955 SUCCESS implies no
  new errors above the pre-existing base set.

## Out-of-scope items (NOT in this PR, recorded to keep them visible)

- secrets-service AWS IAM denial in server 12/12 (WARN-level log noise; not the
  lane's red). Passed latest run; env-dependent.
- Two 15s-timeout flakes (compact-payload, codex-present). Pre-existing on base.
- workspaces-b unhandled EPIPE in `server-utils.test.ts` (122/122 tests pass,
  step exits 1 on unhandled stderr write EPIPE from `runChildProcess` stdin
  pipe when child closes stdin early). Reproduced on base `6adedbf27b` without
  this PR. Out of scope; a separate fix would be a defensive `.on('error')`
  on the stdin write at `server-utils.ts:4905`.
