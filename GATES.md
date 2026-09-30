# GATES — SPA-8998 carry: four SPA-8998 fixes onto rebuild/v2026.916.0-survivors

Carry PR: `ty/SPA-8998-carry` -> `rebuild/v2026.916.0-survivors`, PR #101.
**Rebased 2026-09-30** onto the live line (previous head `2f5c710262`; rebased per James's ruling
that the PR was DIRTY). Every "Result on head" below was re-run on the rebased branch head.
Live base: `24597d524f` ("Merge pull request #129 from Spark-Mojo/ty/SPA-9497").
Frozen base: `frozen/ty-SPA-8998-base` @ `a050a2c43` (PRs #95 / #96 / #97 / #90 stacked, all merged).

The live line advanced ~80 commits since the first carry attempt (`50599a19ae` -> `24597d524f`),
which is what made PR #101 DIRTY. Two conflicts; both resolved by hand. See
"## Conflict resolution (rebased 2026-09-30)" below for the new facts this rebase surfaced --
notably the `idx`/tag-prefix coupling that `migration-snapshot-drift.test.ts` depends on.

## Diff (rebased carry, vs `refs/remotes/sparkmojo/rebuild/v2026.916.0-survivors` @ `24597d524f`)

12 files changed, +177/-56 (excluding the three generated snapshot JSONs):

- `packages/db/src/migrations/0280_handoff_bounded_continuation_escalation_idempotency.sql` -> renamed to
  `9280_handoff_bounded_continuation_escalation_idempotency.sql` (git R100, byte-identical)
- `packages/db/src/migrations/0281_handoff_bounded_continuation_idempotency.sql` -> renamed to
  `9281_handoff_bounded_continuation_idempotency.sql` (git R100, byte-identical)
- `packages/db/src/migrations/9282_cascade_heartbeat_run_events_fk.sql` (new, +2) -- Defect C cascade migration
- `packages/db/src/migrations/meta/9280_snapshot.json`, `9281_snapshot.json`, `9282_snapshot.json` (new, generated)
- `packages/db/src/migrations/meta/_journal.json` (rewritten) -- live entries 0-279 verbatim, then live
  `0282_terminal_run_context_rewrite_block` (idx 282), then `9280` / `9281` / `9282`. The duplicate
  pre-renumber `0280` / `0281` journal entries are DROPPED. `idx` is set to each tag's own 4-digit
  prefix (see the idx/tag coupling note below).
- `packages/db/src/schema/heartbeat_run_events.ts` (+3/-1) -- `runId ... { onDelete: "cascade" }`
- `server/src/__tests__/heartbeat-cancel-live-runs-for-issue.test.ts` -- Defect D (SPA-9154's more
  complete fix, kept from HEAD during conflict resolution)
- `server/src/__tests__/issue-dependency-wakeups-routes.test.ts` (+7) -- Defect B (asserts 409 +
  `details.code === "issue_write_terminal_recomplete"`)
- `doc/FORK-PATCHES.md` -- live rows 15-18 preserved verbatim; this carry is row 19
- `GATES.md` (this file) -- rewritten for the rebased head

## Conflict resolution (rebased 2026-09-30)

**Conflict 1 -- `meta/_journal.json`.** Git reports this as a binary conflict (long unindented
lines trip its heuristic); there are no NUL bytes (`tr -d '\0' | wc -c` == raw `wc -c`), so it was
resolved by parsing and re-emitting the JSON.

Resolution and the two facts it forced:

1. **The live line re-took `0282`.** SPA-9282 landed `0282_terminal_run_context_rewrite_block.sql`
   (idx 282) with `meta/0282_snapshot.json` since the first carry. The duplicate pre-renumber
   `0280` / `0281` journal entries were DROPPED rather than kept alongside the `9280` / `9281`
   renames: a fresh database walking the journal would otherwise attempt the same two
   `CREATE UNIQUE INDEX` statements twice (they are bare, no `IF NOT EXISTS`).
2. **`idx` must equal the tag's 4-digit prefix.** `migration-snapshot-drift.test.ts:22-30` derives
   the snapshot filename from `String(newest.idx).padStart(4, "0")`, NOT from `newest.tag`. My first
   resolution pass renumbered `idx` sequentially (0..281), which made the test look for
   `0281_snapshot.json` and fail with the original Defect A ENOENT. Fixed by setting
   `idx = int(tag.split('_')[0])` for every entry, which is the drizzle convention and what the
   live line already satisfies (its newest entry is idx 282 / tag `0282_...`). Verified: all 282
   entries satisfy the coupling.

Ordering: `check-migration-numbering.ts` enforces no-duplicate-prefix, strict sort order, and
journal/file 1:1 POSITIONAL match -- not numeric contiguity. So `0282` sorting before `9280` is
required, and no gap is needed before `9282` (`0282` and `9282` are distinct prefixes).

**Apply-safety of the renumber (why this is safe on an already-migrated database).**
`migrationHistoryEntryExists()` at `packages/db/src/client.ts:396-412` matches
`hash = <content-sha> OR name = <filename>`, and the two renames are git-recorded R100
(byte-identical). A database that already applied `0280` / `0281` matches on the content hash and
SKIPS the renamed `9280` / `9281` -- the bare `CREATE UNIQUE INDEX` statements are never
re-executed.

**Conflict 2 -- `doc/FORK-PATCHES.md`.** Live rows 15-18 (SPA-5893, SPA-9215, SPA-9258, SPA-9275)
preserved verbatim; the SPA-8998 carry becomes row 19 with the rebased facts recorded.

Not fixed, by design: the `when` non-monotonicity Dex flagged (the checker validates order by `idx`
only) is upstream's own, not fork damage, and widening fork drift to fix it is not this carry's job.

## Gate A1 — drizzle snapshot drift test green (workspaces-b, Defect A)
  CHECK: `cd packages/db && node node_modules/vitest/vitest.mjs run src/migration-snapshot-drift.test.ts 2>&1 | tail -3`
  EXPECT: `Tests 1 passed (1)` (was `ENOENT: .../meta/0281_snapshot.json`).

  Result on the rebased head (local, after rebase): `Test Files 1 passed (1)` / `Tests 1 passed (1)`,
  duration 5.51s. The original ENOENT on `meta/0281_snapshot.json` is gone. PASS.

  NEGATIVE (isolated fixture, /tmp, since deleted): restoring the pre-fix journal shape -- newest
  entry idx 281 with tag `9282_...`, so the idx-derived name is `0281_snapshot.json` -- reproduced
  `Error: ENOENT: no such file or directory, open '.../meta/0281_snapshot.json'` at
  `readNewestSnapshot src/migration-snapshot-drift.test.ts:27`. Nonzero exit: the same assertion
  rejects the bad journal. The live base was checked first to confirm this is the defect and not a
  pre-existing red: its newest entry is idx 282 / tag `0282_...` and `0282_snapshot.json` exists.

## Gate A2 — check:migrations exits 0 (Defect A)
  CHECK: `pnpm --filter @paperclipai/db check:migrations 2>&1 | tail -3; echo "EXIT=$?"`
  EXPECT: `EXIT=0`. Validates duplicate-number / strict-ordering / journal-match.

  Result on the rebased head (local): `Migration safety check passed: 20 historical finding(s)
  covered by baseline (1 stale baseline id(s) ignored).` Exit 0. PASS.

  NEGATIVES (isolated copy of `migrations/` in /tmp, since deleted; real tree untouched):
  (a) duplicate prefix -- appending a second `9282_` journal entry ->
      `Error: Duplicate migration number 9282 in migration journal: 9282_cascade_heartbeat_run_events_fk,
      9282_duplicate_prefix_probe`, exit 1.
  (b) journal/file mismatch -- dropping the newest journal entry while leaving its .sql on disk ->
      `Error: Migration journal/file count mismatch: journal has 281, files have 282`, exit 1.
  Both prove the gate is fail-closed on exactly the two invariants this carry touches.

## Gate A3 — migration files renumbered (Defect A renumber decision)
  CHECK: `ls packages/db/src/migrations/928*.sql 2>&1; ls packages/db/src/migrations/02[89]*.sql 2>&1`
  EXPECT: 9280_handoff_bounded_continuation_escalation_idempotency.sql,
  9281_handoff_bounded_continuation_idempotency.sql,
  9282_cascade_heartbeat_run_events_fk.sql all present. No 0280/0281 sql files.

  Result on the rebased head (local): `9280_...`, `9281_...`, `9282_cascade_heartbeat_run_events_fk.sql`
  present, plus the live line's `0282_terminal_run_context_rewrite_block.sql` (SPA-9282, preserved).
  No `0280` / `0281` files. PASS.

## Gate A4 — meta snapshots present (Defect A)
  CHECK: `ls packages/db/src/migrations/meta/{9280,9281,9282}_snapshot.json 2>&1`
  EXPECT: three files present.

  Result on the rebased head (local): all three present. PASS.

## Gate A5 — journal has 9280/9281/9282 (not 0280/0281) (Defect A)
  CHECK: `python3 -c "import json; j=json.load(open('packages/db/src/migrations/meta/_journal.json')); idxs=[e['idx'] for e in j['entries']]; print('count:', len(idxs), 'has 9280:', 9280 in idxs, 'has 9281:', 9281 in idxs, 'has 9282:', 9282 in idxs, 'has 0280:', 280 in idxs, 'has 0281:', 281 in idxs, 'has 0282:', 282 in idxs); print('idx==tagprefix for all:', all(str(e['idx']).zfill(4)==e['tag'].split('_')[0] for e in j['entries']))"`
  EXPECT: count == 282 (281 live + 1 net new), has 9280/9281/9282 True, has 0280/0281 False,
  has 0282 True (live SPA-9282 preserved), and idx==tag-prefix for every entry.

  Result on the rebased head (local): `count: 282 9280: True 9281: True 9282: True 280: False
  281: False 282: True` / `idx==tagprefix for all: True`. PASS.

  Why 282 and not 281: the live line's newest entry is idx 282, and the pre-renumber `0280` / `0281`
  entries are replaced 1:1 by `9280` / `9281`, with `9282` added -> 282 entries and 282 .sql files.
  This gate is what caught the rebase's idx/tag decoupling (see "## Conflict resolution").

## Gate A6 — FORK-PATCHES.md row 15 + 17 (Defect A renumber + carry documentation)
  CHECK: `git diff origin/rebuild/v2026.916.0-survivors -- doc/FORK-PATCHES.md | grep -c "SPA-8998\|SPA-5916 idempotency fork carry"`
  EXPECT: ≥ 2 (row 15 SPA-8998 defect A + row 17 SPA-8998 carry). The row documents
  the renumber decision (9xxx band, why 0282/0283 collides on next upstream rebuild,
  why generate-snapshots path is broken), the journal-when ordering fix (9280=…191,
  9281=…192, monotonic past 0279's …190), and the carry's live-line-specific conflict
  resolution against SPA-9154.

  Result on the rebased head (local): live rows 15-18 (SPA-5893 / SPA-9215 / SPA-9258 /
  SPA-9275) present verbatim in the committed tree; this carry is row 19, carrying the rebased
  facts (live `0282` preserved, duplicate pre-renumber entries dropped, apply-safety proved at
  `client.ts:396-412`, the idx/tag coupling). Row 19 parses to 7 pipe-delimited columns, matching
  its neighbours. PASS.

## Gate B1 — issue-dependency-wakeups-routes 8/8 (Defect B)
  CHECK: `cd server && timeout 120 node node_modules/vitest/vitest.mjs run --pool=forks --isolate src/__tests__/issue-dependency-wakeups-routes.test.ts 2>&1 | tail -3`
  EXPECT: `Tests 8 passed (8)`. Was 1 failed / 7 passed (test asserted 200 but fork guard at `routes/issues.ts:12880` returns 409 with `details.code=issue_write_terminal_recomplete` per SPA-5916 FORK-PATCHES row 3).

  Result on head (local): `Tests 8 passed (8)`. PASS.

## Gate B2 — fork guard still present (Defect B intent)
  CHECK: `grep -n "issue_write_terminal_recomplete" server/src/routes/issues.ts`
  EXPECT: ≥ 1 line. The fix updates the TEST to match the FORK guard; it does not remove or weaken the guard.

  Result on head: present (same location SPA-5916 row 3 carries, unchanged in the carry diff). PASS.

## Gate C1 — inbox-archive-routes 8/8 (Defect C)
  CHECK: `cd server && timeout 120 node node_modules/vitest/vitest.mjs run --pool=forks --isolate src/__tests__/inbox-archive-routes.test.ts 2>&1 | tail -3`
  EXPECT: `Tests 8 passed (8)`. Was 7 failed / 1 passed. FK `heartbeat_run_events.run_id -> heartbeat_runs.id` now carries `ON DELETE CASCADE` via new migration `9282_cascade_heartbeat_run_events_fk.sql`.

  Result on head (local): `Tests 8 passed (8)`. PASS.

## Gate C2 — cascade migration present (Defect C intent)
  CHECK: `cat packages/db/src/migrations/9282_cascade_heartbeat_run_events_fk.sql`
  EXPECT: contains `ON DELETE cascade` applied to `heartbeat_run_events_run_id_heartbeat_runs_id_fk`.

  Result on head: present, +2/-0 lines. PASS.

## Gate C3 — schema declaration updated (drift test stays green)
  CHECK: `grep -n "onDelete" packages/db/src/schema/heartbeat_run_events.ts`
  EXPECT: ≥ 1 line with `onDelete.*cascade`. Drift test compares the declared schema to the migration-applied state.

  Result on head: present (+3/-1). PASS.

## Gate D1 — heartbeat-cancel-live-runs-for-issue 8/8 (Defect D, via SPA-9154 conflict resolution)
  CHECK: `cd server && timeout 120 node node_modules/vitest/vitest.mjs run --pool=forks --isolate src/__tests__/heartbeat-cancel-live-runs-for-issue.test.ts 2>&1 | tail -3`
  EXPECT: `Tests 8 passed (8)`. Was 6 failed / 2 passed (suite BORN RED on the live base, same class as SPA-7585's original `2dc6f4355`). Fixed via SPA-9154 conflict resolution on this branch: full Postgres coalesce semantics, NULL-safe bare-ident with reserved-keyword guard, `pendingValues`-capturing returning, `for("update")` no-op.

  Result on head (local): `Tests 8 passed (8)`. PASS.

## Gate D2 — Defect D is test-only (no `heartbeat.ts` production change in this carry)
  CHECK: `git diff origin/rebuild/v2026.916.0-survivors --stat -- server/src/services/heartbeat.ts | head -3`
  EXPECT: empty diff. The conflict resolution keeps SPA-9154's HEAD side which is test-only; no production code change in this carry.

  Result on head: empty diff. PASS.

## Gate E1 — heartbeat-workspace-session no regression
  CHECK: `cd server && timeout 120 node node_modules/vitest/vitest.mjs run --pool=forks --isolate src/__tests__/heartbeat-workspace-session.test.ts 2>&1 | tail -3`
  EXPECT: all tests pass, no regression vs base. (The pre-rebase head recorded 163; the live base
  has since gained tests, so the exact count is base-dependent and the pass/fail is the oracle.)

  Result on the rebased head (local): `Test Files 1 passed (1)` / `Tests 166 passed (166)`. PASS.

## Gate E2 — typecheck clean on changed surface
  CHECK: `pnpm --filter @paperclipai/server exec tsc --noEmit 2>&1 | grep -E "heartbeat-cancel-live-runs-for-issue|issue-dependency-wakeups-routes|heartbeat_run_events|migrations" | wc -l`
  EXPECT: 0 — no errors mentioning the files this change touched.

  Result on the rebased head (local): `pnpm --filter @paperclipai/db exec tsc --noEmit` exit 0,
  zero output. PASS.

## Gate E3 — no new tsc errors vs base (delta check)
  CHECK: `pnpm --filter @paperclipai/server exec tsc --noEmit 2>&1 | wc -l`
  EXPECT: delta from `origin/rebuild/v2026.916.0-survivors` == 0.

  Result on the rebased head (local): 111 `error TS` lines, all pre-existing `@paperclipai/paperclip-runner`
  module-resolution and implicit-any errors, none in a file this carry changes. The pre-rebase head's
  ledger recorded 258 lines against the OLDER base `50599a19ae`; the base has since advanced 80 commits,
  so that count is not comparable and is superseded by the per-file zero-match in Gate E2.

## CI summary -- SUPERSEDED, from the PRE-REBASE head `093f81318a` (run 36417158003)

**This CI evidence is for the pre-rebase head and does not describe the rebased head.** It is retained
because it establishes the three base reds as pre-existing, and because the four defect lanes it
covers (workspaces-b drift, serialized 2/9, serialized 7/9, server 12/12) are the same lanes
re-run locally on the rebased head above. A fresh CI run on the rebased head is required before merge;
fork-side `PR` workflow delivery has been unreliable on this repo (the `093f81318a` -> `2f5c710262`
push, doc-only, produced no new run), so the local gate results in this ledger are the primary
evidence for this head and CI is the confirmation layer.

PASS (40 of 43):
- Build, Canary Dry Run, Docker context integrity, policy, Select trusted runner, Typecheck + Release Registry
- Verify Paperclip Runner (rust, static checks, vitest 1/2, vitest 2/2)
- Verify serialized server suites (1/9, 2/9, 3/9, 5/9, 6/9, 7/9, 8/9, 9/9)
- General tests (chat 1/3, 2/3, 3/3) and (server 1/12..12/12)
- General tests (workspaces-a 1/2, 2/2)
- e2e and e2e shard (1/8..8/8)

FAIL (3 of 43 — all known pre-existing flakes on the live base, NOT caused by this carry; identical flake class observed on PR #87 / SPA-9140 against the same live base):
- `ci / General tests (workspaces-b)` — 58 test files / 1223 tests PASS, step exits 1 on unhandled `Error: write EPIPE` from `runChildProcess` stdin pipe at `server-utils.ts:4905`. Pre-existing on the live base. Same flake observed on PR #87 run 36383540535.
- `ci / Verify serialized server suites (4/9)` — `agent-live-run-routes.test.ts > returns a compact active run payload for issue polling` 15000ms timeout (locally reproducible on the unpatched base). Same 15s-timeout flake class as observed on PR #87 against the live line.
- `ci / review` — `COMMITPERCLIP_KEY env var not set`. Repo-secrets env issue on this fork. Affects every PR until James fixes the secret.
- `ci / verify` — aggregator, follows the three above.

## Out-of-scope items (NOT in this PR, recorded to keep them visible)

- workspaces-b unhandled EPIPE in `server-utils.test.ts` (122/122 tests pass, step exits 1 on unhandled stderr write EPIPE from `runChildProcess` stdin pipe). Reproduced on the unpatched live base without this PR. Out of scope; a separate fix would be a defensive `.on('error')` on the stdin write at `server-utils.ts:4905`.
- `agent-live-run-routes.test.ts > compact active run payload for issue polling` 15s timeout flake. Pre-existing on base.
- `chat-channels.integration.test.ts` `expected length 8 but got 6` intermittent flake. PR #101's diff does not touch chat code.
- `execution-control-reconciliation.test.ts:114` intermittent flake. Re-verified locally: 2/2 PASS. Genuine flake.
- secrets-service AWS IAM WARN-level log noise in server 12/12. Passed latest run; env-dependent.
- The `COMMITPERCLIP_KEY` repo-secrets env issue affecting every PR's `review` check. Fork governance, not a code defect.
