# SPA-11264 gates

## Diagnostic prerequisite, manager clarification 2026-10-08 06:29Z

Independent ownership decisions remain unchanged. Current exact attribution is unproven; implement the authorized narrow fixed-tag diagnostics, not speculative caching. Diagnostic review is not full-card acceptance. No activation is authorized by this clarification.

- Bounded aggregate caller measurements preserve independent results/errors and disclose no query data.
  CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/heartbeat-query-diagnostics.test.ts
  EXPECT: all diagnostics tests pass, including overlap, rejection, window reset, fixed tags, output privacy and logger failure isolation.
  NEGATIVE: disposable mutation of the workspace collector with the `finally` in-flight decrement removed, same suite, nonzero exit expected.
  NEGATIVE-EXEC: `python3` rewrote a copy at /srv/ram/scratch/paperclip-run-spa-11264-ee9a26c8-554-7DErHn/opencode/spa11264-neg/mutated.ts replacing `} finally {\n        state.inFlight -= 1;\n      }` with an empty finally; the copy was then written over server/src/services/heartbeat-query-diagnostics.ts for the run only, and restored from orig.ts afterwards.
  NEGATIVE-RECEIPT: exit 1, 6 of 20 failed. Retained-in-flight assertion `expected 3 to be +0` at heartbeat-query-diagnostics.test.ts:154 (summary.inFlight stayed 3 after three overlapping calls). Other rejections: "counts a rejection as failed without counting it completed", "logs at most one aggregate per window and resets counts across windows", "assigns a completion that lands in a later window to the window it completed in", "carries the retained in-flight count forward as the next window's peak", "releases the in-flight slot even when the measured caller throws".
  NEGATIVE-RESTORE: `diff orig.ts server/src/services/heartbeat-query-diagnostics.ts` after restore printed nothing, RESTORE_IDENTICAL=yes; suite re-run after restore exit 0, 20 passed.
  RESULT: exit 0, 20 tests passed (2026-10-08 06:45 UTC). Test-first red recorded before the collector existed: exit 1, "Cannot find module '../services/heartbeat-query-diagnostics.js'", 0 tests collected.
- Caller wiring measures only the ownership, watchdog candidate and issue-redaction database awaits without changing predicates, projections or transaction boundaries.
  CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/heartbeat-query-diagnostics.test.ts server/src/__tests__/run-secret-redaction.test.ts
  EXPECT: all selected tests pass; wiring asserts all three static caller tags.
  RESULT: exit 0, 2 files / 28 tests passed (2026-10-08 06:45 UTC).
- Server typecheck over the new module and the three wired callers.
  CHECK: timeout 300 pnpm exec tsc --noEmit -p server/tsconfig.json
  EXPECT: exit 0, no diagnostics.
  RESULT: exit 0, no output (2026-10-08 06:45 UTC). Full-card/runtime gates below remain unproven.


## 2026-10-08 scoped-return investigation (no source changes)

- Preserved PR #158 head e5b5ec983ca007b102a1da69e5612f44d5b694a9; OPEN and MERGEABLE read live.
- GET baseline at 06:22:18Z: HTTP 200, 4.491958 seconds. One sample, existing fleet load, no deployed PR change; not an improvement claim.
- Health installedCommit=117aed1585374e487fad83f9bd529bc33afe874e; processStartedAt=2026-10-08T00:43:59.599Z.
- Bounded pg_stat_activity snapshot observed five active full-column prefixes, ages 0.009256–1.026964 seconds. track_activity_query_size=1kB truncates before predicates. No pg_stat_statements extension. log_min_duration_statement=-1. Current exact-query identity therefore remains unproven.
- Socket inspection mapped all ten current PostgreSQL client connections to paperclip.service MainPID=3005514. This is single-process evidence for the sampled connections, not a deployment-wide invariant.
- Existing PostgreSQL log, final <=2 MB, contains seven matching full-column statements. Six historical records from Oct 7 13:30:08 and Oct 8 00:43:53 uniquely match getConversationOwnershipBlocker (conversation-continuation.ts:98), including activeLease projection, legacy runtime, adapter provenance OR, coalesce(native_issue_id::text, context_snapshot->>'issueId'), four terminal statuses, process/lease presence and descending created_at/id. These are historical broken-pipe/shutdown records, NOT current PID attribution. Watchdog hypothesis not established.
- Source at installed SHA contains the same ownership predicate. execution-blocker.ts:37 calls it for issue reads; execution-recovery-resolution.ts:323 calls it inside a transaction. Sharing cached or in-flight ownership decisions risks crossing snapshots and suppressing a newly acquired owner.
- Read-only EXPLAIN (NOT ANALYZE) on reduced ownership filter: current coalesce predicate produces Seq Scan cost 0.00..10272.59; precedence-preserving native_issue_id equality OR (native_issue_id IS NULL AND context issueId equality) produces Bitmap Heap Scan cost 8.87..20.79 with BitmapOr across existing native-issue and context-issue indexes. Costs are planner estimates, not elapsed measurements. Full-query plan and semantic fixture still required.
- SPA-10699 read live: blocked on freeze SPA-10835, exact index name sm_heartbeat_runs_company_ctx_pcissue_idx. Live pg_indexes confirms that exact index exists. No rename, duplicate index, migration/journal edit or change to the frozen card.
- Wakeup and cost_events already have multiple company/status/time indexes (36 indexes enumerated across the three tables); cumulative scan totals alone do not justify new ones. Their current hot predicates/plans remain unproven, NOT evidenced unnecessary.
- Advisor recommends indexed predicate rewrite and minimal projection rather than sharing execution-authority results. Manager wording requires overlap coalescing as well as permitting bounding; seek scoped acceptance of independent indexed checks or attribution/instrumentation before altering that acceptance.
- No live migration, restart, logging change, install, load experiment, new verifier run or source edit performed. All previous unproven gates below remain unproven.


- Repeated issue reads coalesce legacy liveness backfill without suppressing new completed runs.
  CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/activity-service.test.ts
  EXPECT: activity service tests pass, including repeated reads and new terminal run.
  RESULT: exit 0, 6 tests passed (2026-10-08 05:38 UTC).
  NEGATIVE: original implementation schedules an unconditional scan on each call; safe failing fixture not executed, so the negative control remains unproven.
- Database indexes match hot liveness predicate and migration is registered.
  CHECK: timeout 180 pnpm exec vitest run packages/db/src/heartbeat-context-snapshot-index-migration.test.ts
  EXPECT: migration/index test passes for partial index and journal.
  RESULT: exit 0, 1 test passed (2026-10-08 05:38 UTC); db typecheck/migration safety exit 0; server direct tsc exit 0.
  NEGATIVE: baseline missing-index fixture not executed; negative control unproven.
- Runtime latency and concurrency after deployment.
  CHECK: timeout 25 curl -sS -o /dev/null -w 'issue_get_http=%{http_code} seconds=%{time_total}\n' -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID"
  EXPECT: HTTP 200 and post-deployment GET latency lower than baseline 9.400030s; hot query <100ms and 1-2 active backends under same load.
  RESULT: baseline HTTP 200 seconds=9.400030 at 05:25 UTC. Post-deployment unproven; no engine restart or live DB migration in this run. Runtime gate is necessarily post-merge/post-activation; fork merges only after verifier PASS, and manual restart would terminate active agent runs. PASS here must not assert runtime success.
  NEGATIVE: no safe live-load negative; gate remains unproven until authorized installation and comparable measurement.


## 2026-10-08 whole-PR prerequisite regression proof (tests only, append-only)

Scope: strengthen whole-PR prerequisite regression proof for PR #158. Production implementation preserved; no production source file was modified. `git diff --stat HEAD -- server/src/services packages/db/src/schema packages/db/src/migrations server/src/modules` printed nothing.

### INCIDENT: negative controls INVALID (disclosed before re-run)

Four negative controls were executed and reported exit 0 (baseline pass / mutation rejected / restored pass). THOSE RECEIPTS ARE INVALID AND ARE SUPERSEDED BY THIS SECTION.

Cause: the harness under test, `scripts/spa-11264-negative-control.sh`, walked the WORKSPACE's own `node_modules/@paperclipai` scope entries while building the fixture. For a scope entry that is itself a symlink into the workspace, its `ln -sfn ... "$fx/$p/node_modules/$name"` write followed that symlink and rewrote the REAL workspace link, redirecting all 75 pnpm workspace links to the fixture. `ln` writing through a symlinked parent is the defect; the second loop repeated it. Consequences:

- The mutated runs that "rejected" their input were not proven to be exercising the workspace under test. Any difference between the fixture and the workspace is an uncontrolled variable, so the controls cannot distinguish their intended mutation from the redirect.
- The workspace's own module resolution was broken for the remainder of that session: `timeout 600 pnpm exec tsc --noEmit -p server/tsconfig.json` returned exit 1 with TS2307 `Cannot find module '@paperclipai/...'` errors, and `readlink -f` on the 75 links returned MISSING.

A scratch-only helper (`build-fixture.sh` under the run scratch dir, never committed) shared the same defect and caused the damage first.

Repair performed (bounded, no install, no fixture): targets derived from the lockfile importer directory plus the recorded `link:` path, resolved to an absolute path under the repo — NOT from the relative node_modules location. Pre-repair assertions, all passed: 75 entries read from `pnpm-lock.yaml`; every link path is a symlink; every target is an existing directory inside the repo; zero regular files and zero unexpected targets found. Dry-run manifest printed all 75 as DAMAGED with the absolute target for each. Only then were the 75 links replaced. Post-repair verification: 75/75 resolve via `readlink -f` to an existing directory inside the repo; `readlink server/node_modules/@paperclipai/db` = `<repo>/packages/db`. No `pnpm install` was run. Repair commands:

    python3 # reads importers: block of pnpm-lock.yaml, collects "version: link:<path>" per importer,
            # asserts each link path is a symlink and each absolute target is an existing dir under the repo,
            # then remove+symlink(absolute target) for each entry whose resolved target differs
    # verify: for each entry, os.path.islink(link) and os.path.realpath(link) == abs_target and os.path.isdir(real)  => 75/75

`scripts/spa-11264-negative-control.sh` is retired in place: non-executable, and its body is a refusal that exits 64 with `REFUSED:` on stderr. Verified `chmod -x` gives exit 126 `Permission denied`, and `bash <script>` gives exit 64 printing REFUSED, with no filesystem side effect in either case.

### Strengthened suites — POSITIVE results

- Bounded liveness backfill drains a ledger holding more rows than one batch, retains later work, and never hides a run from the read. 47 eligible rows (more than 2x the bound of 20), 3 rows tied on `createdAt`, 6 ineligible rows interleaved (running, queued, two already stamped, two belonging to another issue). Asserts every eligible id is returned on every read; the first read's bounded pass stamps exactly 20; the drain completes over more than one read; all 47 persist `plan_only` with the shared reason; no ineligible row is modified; the stamped count is taken only over eligible ids.
  CHECK: timeout 900 pnpm exec vitest run server/src/__tests__/activity-service.test.ts
  EXPECT: exit 0, 8 tests passed (6 pre-existing plus 2 new).
  RESULT: exit 0, 8 tests passed (2026-10-08 07:35 UTC). EXPECT matched.
- Runs behind the first bounded batch are processed on a later read. 20-row head plus 5 behind; the 5 must still be `liveness_state IS NULL` after the head drains, then must be `plan_only` afterwards, while the head stays stamped.
  CHECK: timeout 900 pnpm exec vitest run server/src/__tests__/activity-service.test.ts
  EXPECT: exit 0, 8 tests passed.
  RESULT: exit 0, 8 tests passed (2026-10-08 07:35 UTC). EXPECT matched.
- Migration predicate, drizzle schema and journal agree on one index name and one predicate, with PostgreSQL's own parse of the predicate pinned. Journal tag `9283_missing_terminal_run_liveness_index`, `idx: 9283`, present exactly once, last in the journal and last in the sorted file listing, journal tags equal to the sorted filename list. Migration SQL, `packages/db/src/schema/heartbeat_runs.ts` and `pg_get_indexdef`/`pg_get_expr(indpred)` must all name `heartbeat_runs_company_missing_terminal_liveness_idx` with predicate `((liveness_state IS NULL) AND (status <> ALL (ARRAY['queued'::text, 'running'::text])))`, and the catalogue must hold exactly one index of that name.
  CHECK: timeout 900 pnpm exec vitest run packages/db/src/heartbeat-context-snapshot-index-migration.test.ts
  EXPECT: exit 0, 6 tests passed (1 pre-existing plus 5 new).
  RESULT: exit 0, 6 tests passed (2026-10-08 07:35 UTC). EXPECT matched.
- The index predicate admits exactly the missing-terminal rows and nothing else. Nine seeded rows covering every status plus one already-stamped row; the row set is selected using the predicate READ BACK FROM THE CATALOGUE rather than restated by the test, then cross-checked against the production predicate used in `server/src/services/activity.ts`, plus an EXPLAIN proving the index is usable.
  CHECK: timeout 900 pnpm exec vitest run packages/db/src/heartbeat-context-snapshot-index-migration.test.ts
  EXPECT: exit 0, six tests passed.
  RESULT: exit 0, 6 tests passed (2026-10-08 07:35 UTC). EXPECT matched.
- SPA-10699 exact index name is preserved across the migration chain. The frozen name is seeded on a disposable cluster, PR #158's migration is replayed over it, and the `pg_indexes.indexdef` must be byte-identical afterwards with both indexes coexisting; plus static guards that PR #158 contains no `DROP INDEX`/`ALTER INDEX`/`RENAME` and that no migration in the folder drops an index carrying the `heartbeat_runs_company_ctx_pcissue` fragment.
  CHECK: timeout 900 pnpm exec vitest run packages/db/src/heartbeat-context-snapshot-index-migration.test.ts
  EXPECT: exit 0, six tests passed.
  RESULT: exit 0, 6 tests passed (2026-10-08 07:35 UTC). EXPECT matched.
- Whole-diff positive suites over every file PR #158 touches plus the migration-safety suite.
  CHECK: timeout 1500 pnpm exec vitest run server/src/__tests__/activity-service.test.ts server/src/__tests__/heartbeat-query-diagnostics.test.ts server/src/__tests__/run-secret-redaction.test.ts packages/db/src/heartbeat-context-snapshot-index-migration.test.ts packages/db/src/check-migration-safety.test.ts
  EXPECT: exit 0, all selected files and tests pass.
  RESULT: exit 0, 5 files passed, 67 tests passed (2026-10-08 07:36 UTC). EXPECT matched.
- Server typecheck after the link repair.
  CHECK: timeout 900 pnpm exec tsc --noEmit -p server/tsconfig.json
  EXPECT: exit 0, no diagnostics.
  RESULT: exit 0, no output (2026-10-08 07:36 UTC). EXPECT matched. Earlier exit 1 with TS2307 module-resolution errors was caused by the corrupted links above and is superseded, not a code defect.
- Database package typecheck, which also runs the migration numbering and safety checks.
  CHECK: timeout 900 pnpm --filter @paperclipai/db typecheck
  EXPECT: exit 0; migration numbering and safety checks pass.
  RESULT: exit 0; `Migration safety check passed: 20 historical finding(s) covered by baseline (1 stale baseline id(s) ignored).` (2026-10-08 07:36 UTC). EXPECT matched.

### REMAINING UNPROVEN

- All four negative controls for this deliverable (diagnostic in-flight decrement removed, backfill later-work suppressed, migration predicate broken, migration journal registration broken). UNPROVEN. The only harness available is retired for the reason recorded above, and no replacement fixture build was attempted in this session. A compliant replacement must copy dependency links without traversing or writing through the workspace's own symlinks, and must assert before running any suite in the copy that no `@paperclipai` link in the copy resolves into the workspace AND that the real worktree's 75 links are unchanged (link text and realpath, byte-compared before and after the build).
- The three earlier negative gates in this ledger (workspace-overlay diagnostic decrement, missing-index fixture, live-load) remain unproven; the first was explicitly non-compliant and the other two were never executed.
- Runtime latency and concurrency after deployment remains unproven; see the gate above. No live DB change, install or restart was performed.
- The original incident's exact runtime behaviour and query attribution remain unproven. Advisor note: a forced indexer or a planner plan for this index is a usability signal only and is NOT runtime acceptance.
- The SPA-10699 frozen index predicate body is not present in any file in this fork; only the name `sm_heartbeat_runs_company_ctx_pcissue_idx`, recorded from a live `pg_indexes` read, is available. The seed-oracle therefore proves preservation BY NAME, not by predicate. A future DROP+CREATE of that index under the same name with a different WHERE clause would not be caught. Closing this needs an engine-side predicate fetch, which is out of scope for this card.
- `git status --porcelain` at implementer return: tests modified and harness untracked. Nothing committed or pushed at that point.

## Parent re-derivation 2026-10-08 07:43Z — supersedes unproven fixture controls above

- CHECK: timeout 2400 bash scripts/spa-11264-negative-control.sh
  EXPECT: ISOLATED_CONTROLS_PASS workspace-links-unchanged
  RESULT: exit 0; EXPECT matched. Replacement Python copier creates real scope directories, never writes through dependency parents, maps workspace package links to fixture, asserts every direct @paperclipai resolution stays in fixture, snapshots workspace symlink text+resolution before/after every suite, checks source bytes unchanged. Disposable exported source, no git worktree or live DB. Initial setup attempt exited 1 copying a tracked directory; corrected to copy files only before successful full run.
  NEGATIVE: same command executes three baseline/mutation/restoration sequences inside fixture, timeout 600 per suite.
  diagnostics baseline/restored: exit 0, 20 tests each. Mutation removes in-flight decrement: exit 1, 6 failed; expected 3 to be +0 at diagnostics test:154.
  backfill baseline/restored: exit 0, 8 tests each. Mutation slice(0,20) to slice(0,0): exit 1, 6 failed; expected Set(47) to equal empty Set at activity test:462; proves drain assertion rejects suppressed work.
  migration baseline/restored: exit 0, 6 tests each. Mutation excludes scheduled_retry from index: exit 1, 3 failed; predicate text mismatch and missing scheduled_retry in catalogue-selected row set at migration test:266.
  Registration negative not separately rerun; journal positive consistency assertion remains. All old corrupted-fixture receipts remain INVALID.
- CHECK: timeout 1500 pnpm exec vitest run server/src/__tests__/activity-service.test.ts server/src/__tests__/heartbeat-query-diagnostics.test.ts server/src/__tests__/run-secret-redaction.test.ts packages/db/src/heartbeat-context-snapshot-index-migration.test.ts packages/db/src/check-migration-safety.test.ts
  EXPECT: Test Files 5 passed (5); Tests 67 passed (67)
  RESULT: exit 0, exact EXPECT matched at 07:43Z, after parent removed brittle journal-must-stay-last assertion and racy later-row-must-still-be-null assertion (reading ledger legitimately schedules next batch). Retained exact registration/order and eventual processing/visibility assertions.
- CHECK: timeout 900 pnpm exec tsc --noEmit -p server/tsconfig.json
  EXPECT: exit 0 without diagnostics
  RESULT: exit 0 without output.
- CHECK: timeout 900 pnpm --filter @paperclipai/db typecheck
  EXPECT: Migration safety check passed
  RESULT: exit 0; Migration safety check passed: 20 historical finding(s) covered by baseline (1 stale baseline id(s) ignored).
- CHECK: git diff --check
  EXPECT: exit 0 without output
  RESULT: exit 0 without output.

SPA-10699 clarification: seed preservation demonstrates a supplied definition remains byte-identical across this additive migration, not the exact live definition. No frozen-card mutation or duplicate pcissue index. Forced planner tests prove usability, not incident runtime success. Prior claim that fetching live predicate is out of scope was implementer opinion, not authority.

Prerequisite acceptance: manager comment eba4be42-1cb3-4ed6-9e35-d93c56fa9a2a in wake is binding verbatim; independent review scope is whole PR only for prerequisite merge readiness, never incident acceptance. Activation procedure/operator remain UNESTABLISHED. No agent restart/install authorized. After prerequisite PASS, Dex owns SHA-bound merge coordination and must route activation authority gap, not activate. Required later measurement wake: authorized operator activates; Dex records merge/install and health installedCommit containing merge, processStartedAt strictly later than installedAt, then reassigns still-open card to Ty.

## Original incident requirements — verbatim, DEFERRED/UNPROVEN

**Board DB burns CPU on repeated full scans of heartbeat_runs (measured 2026-10-07 20:35Z).**

- 9-11 Postgres backends at ~85% CPU each, all running the same `select "id","company_id","agent_id","invocation_source",...` shape (~1.8s each) plus a `heartbeat_runs` select filtering `liveness_state is null and status not in (...)`.
- Cumulative sequential-scan rows: agent_wakeup_requests 78G, cost_events 71G, heartbeat_runs 35G, issues 17.6G.
- heartbeat_runs is 2.4 GB (plus 747 MB heartbeat_run_events, 520 MB agent_wakeup_requests). Served from page cache, so this is CPU and load (~45), not disk.
- The 9-way concurrency of one shape suggests a poll or recovery loop firing repeatedly. Inferred, not traced.

**Ask (evaluate against rebuild/v2026.916.0-survivors):**
1. Find the caller of the hot shape, and cap or de-duplicate it (a single-flight or cached result per tick).
2. Add a migration with a partial index for the liveness query, e.g. `heartbeat_runs (company_id) where liveness_state is null`, plus the indexes the wakeup/cost_events scans need. Coordinate with SPA-10699, which carries an index into migrations.
3. Oracle: under the same load, active backends running that shape drop to 1-2 and its time falls below 100 ms.

Separately, the disks are saturated by CI test jobs, not by the DB (sdb 100% busy). That is the known runner class and is not this card's job.

Current attribution, cap/de-duplicate or explicit evidence-based index-only acceptance, wakeup/cost plan evidence, full-query semantics, comparable-load query below 100 ms, 1–2 matching active backends and before/after GET remain UNPROVEN. No merge or incident-resolution claim.

