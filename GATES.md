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
