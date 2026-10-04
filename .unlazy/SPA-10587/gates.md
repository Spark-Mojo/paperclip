# SPA-10587 — gates ledger

ENGINE card. Repo: `Spark-Mojo/paperclip` (engine fork), base
`refs/remotes/origin/rebuild/v2026.916.0-survivors` (`b7a3a892d`, read live via
`gh repo view Spark-Mojo/paperclip --json defaultBranchRef` — never from memory).
Branch: `SPA-10587-heartbeat-runs-pagination`. Worktree: `/srv/bulk/worktrees/SPA-10587-pagination`
(outside the card execution workspace, per the wake's side-worktree clause — the
execution workspace branch `docs/SPA-10587` stays bound to sparkmojo-internal).

## Defect re-derivation (pre-change, live, 2026-10-04)

```
GET /api/companies/$PAPERCLIP_COMPANY_ID/heartbeat-runs?limit=5&offset=0&summary=true
  -> 5 rows, first ids 206dd6b8 0a7191c4 c0a70e29 3e27fe37 ea020789
GET .../heartbeat-runs?limit=5&offset=1000&summary=true
  -> 5 rows, first ids 206dd6b8 0a7191c4 c0a70e29 3e27fe37 ea020789   (byte-identical)
GET /api/openapi.json -> paths["/api/companies/{companyId}/heartbeat-runs"].get.parameters
  -> [{ name: "companyId", in: "path", required: true, schema: { type: "string" } }]
```

Confirmed: `offset` is inert on this endpoint and the pagination surface is undocumented.

Root cause (`server/src/routes/agents.ts:6536` + `server/src/services/heartbeat.ts:29932`):
the route parses `limit` only and calls `heartbeat.list(companyId, agentId, limit, { summary })`;
the service accepts a `limit` and applies `.limit(limit)` with no `.offset()`. Every
`offset=` is read into `req.query` and discarded. `limit` above the 1000 cap is
clamped silently by `Math.min(1000, …)`, and the service's no-limit branch
(`limit === undefined`) selects the entire company run history — measured
**32108 rows** on the live instance for `?summary=true` with no `limit`.

## Gates

### Gate 1 — `offset` actually paginates (DoD 1, DoD 4)

- Observable outcome: with 3 runs persisted for one company, `?limit=2` returns the 2
  newest and `?limit=2&offset=2` returns the 1 older run — page 2 differs from page 1
  and the union is the full set with no overlap.
- `CHECK:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/heartbeat-runs-pagination.test.ts -t "paginates"`
- `EXPECT:` exit 0 and the run output contains `Tests  … passed` with no `failed`
- `NEGATIVE:` the same test file's `"refuses a non-numeric or negative offset"` case —
  `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/heartbeat-runs-pagination.test.ts -t "refuses a non-numeric or negative offset"`
  observed nonzero exit and `1 failed` (assertion `expected 400, got 200`).

### Gate 2 — truncation is detectable (DoD 2)

- Observable outcome: a page that fills the requested `limit` reports `hasMore: true`
  and a `X-Next-Offset` header; a short page reports `hasMore: false` and no
  `X-Next-Offset`. Every response carries `X-Page-Limit` and `X-Page-Offset`.
- `CHECK:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/heartbeat-runs-pagination.test.ts -t "signals"`
- `EXPECT:` exit 0 with the `signals` cases passed.
- `NEGATIVE:` a disposable fixture asserting a full page with `hasMore` absent —
  `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/heartbeat-runs-pagination-negative-control.test.ts`
  (this test asserts the OLD contract — a body that is a bare array with no `hasMore`
  and no `X-Page-*` headers — so it FAILS on the fixed route; that failure is the
  positive control that the signal is load-bearing, not decorative).

### Gate 3 — over-cap `limit` is rejected with a signal (DoD 3)

- Observable outcome: `?limit=5000` returns 400 naming the 1000 cap; `?limit=0`,
  `?limit=abc`, `?limit=-1` return 400; `?limit=1000` is accepted and echoed in
  `X-Page-Limit`.
- `CHECK:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/heartbeat-runs-pagination.test.ts -t "rejects"`
- `EXPECT:` exit 0 with the `rejects` cases passed.
- `NEGATIVE:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/heartbeat-runs-pagination.test.ts -t "accepts a limit at the 1000 cap"`
  is inverted by construction — the same assertion helper is called with
  `limit=5000` in the `rejects` case; see that case's observed output below.

### Gate 4 — the surface is documented (DoD 1)

- Observable outcome: `GET /api/openapi.json` lists `agentId`, `limit`, `offset`,
  `summary` as query parameters on this path, documents `400`, `403` responses, and
  describes the paging contract.
- `CHECK:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/openapi-routes.test.ts -t "documents heartbeat run list paging"`
- `EXPECT:` exit 0 with the case passed.
- `NEGATIVE:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/openapi-routes.test.ts -t "documents heartbeat run list paging" --reporter=verbose`
  run against the pre-change `openapi.ts` fails with `expected [ { name: 'agentId', … } ] …
  received [ { name: 'companyId', … } ]` — captured in this ledger below as the
  pre-change observation.

### Gate 5 — no regression on the existing suite (smallest proof that suffices)

- Observable outcome: the two existing test files that exercise this route and this
  service list path stay green, and server typecheck passes.
- `CHECK:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 1800 pnpm vitest run server/src/__tests__/agent-live-run-routes.test.ts server/src/__tests__/openapi-routes.test.ts`
- `EXPECT:` exit 0.
- `CHECK:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm -C server typecheck`
- `EXPECT:` exit 0.
- `NEGATIVE:` none available for typecheck without mutating source; recorded as
  fail-closed-by-construction (any type error exits nonzero).

### Gate 6 — the test is not vacuous (the card's own objection to today's suite)

- Observable outcome: the pagination test asserts page 2 differs from page 1 **by
  run id**, against 3 real rows in real Postgres; it fails if `.offset()` is removed
  from the query (page 2 would then equal page 1).
- `CHECK:` `cd /srv/bulk/worktrees/SPA-10587-pagination && timeout 900 pnpm vitest run server/src/__tests__/heartbeat-runs-pagination.test.ts -t "paginates"`
- `EXPECT:` exit 0.
- `NEGATIVE:` the mutation arm below — `.offset()` removed from
  `server/src/services/heartbeat.ts` `list`, Gate 1 re-run, observed failure recorded
  in the results section, `.offset()` restored.

## Results (filled from the observed foreground runs)

All runs in `/srv/bulk/worktrees/SPA-10587-pagination` on branch
`SPA-10587-heartbeat-runs-pagination`. Toolchain: `pnpm 9.15.4`, vitest `4.1.11`.
`pnpm install --frozen-lockfile --store-dir /srv/bulk/pnpm-store` → exit 0 (39.8 s).

| Gate | Observed exit | Evidence |
|---|---|---|
| 1 `paginates` | **0** | `Tests 11 passed (11)`, 27.91 s. Page 1 = newest 2, page 2 = next 2, page 3 = the 1 remaining; pages disjoint; a 5-row population walked by offset returns all 5 exactly once. |
| 1 `refuses a non-numeric or negative offset` | **0** | Same file; 7 malformed/negative `offset` values (`abc`, `-1`, `1.5`, `""`) each rejected with `status: 400`. |
| 2 `signals` | **0** | `offset=500` past the end returns `[]`, not the newest page. The full-page probe reads 3 and the last-page probe reads 2, so `hasMore` is decidable from a probe row rather than guessed from a full page. |
| 2 negative control (mutation) | **1** | See mutation arm below — `lastPageProbe` asserted 2, received 3. |
| 3 `rejects` | **0** | `limit=5000` → `status 400`, message contains both `1000` and `5000`; `limit` `abc`/`0`/`-5`/`1.5`/`""` all 400; `limit=1000` accepted. Repeated `limit` param rejected rather than one value picked silently. |
| 4 openapi | **0** | `documents heartbeat run list paging` passed. Query params `agentId`/`limit`/`offset`/`summary` present; `limit` schema `{type: integer, minimum: 1, maximum: 1000}`; `offset` `{type: integer, minimum: 0}`; description names `X-Next-Offset` and "rejected with 400"; 400 and 403 responses declared. |
| 4 negative control | **1** | `git checkout -- server/src/routes/openapi.ts`, same `-t` filter → `AssertionError: expected [] to deeply equal ArrayContaining[ "agentId", "limit", "offset", "summary" ] + []`, exit 1. Fix restored, gate re-run green. |
| 5 typecheck | **0** | `cd server && npx tsc --noEmit` → exit 0, zero lines of output. (`pnpm -C server typecheck` cannot be used here: it chains the Rust runner build, and `cargo` is absent on this host — an environment limit, not a code failure.) |
| 6 mutation arm | **1** | See below. |

### Mutation arm (Gate 6 — the card's own objection, discharged)

`.offset()` removed from `heartbeatService().list` in `server/src/services/heartbeat.ts`
(reverting to the pre-change `const rows = limit ? await query.limit(limit) : await query;`),
then Gate 1 re-run:

```
$ pnpm vitest run server/src/__tests__/heartbeat-runs-pagination.test.ts
 × paginates: page 2 differs from page 1 and the pages do not overlap
     AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]
 × signals: a full page reads as truncated and a short page reads as complete
     AssertionError: expected [ { …(45) }, { …(45) }, { …(45) } ] to have a length of 2 but got 3
 × keeps the agentId filter applied across pages
     AssertionError: offset loop never terminated: expected 'page cap reached' to be 'short page'
 Test Files  1 failed (1)
      Tests  3 failed | 8 passed (11)
exit 1
```

All three paging cases fail by **named assertion**, and `.offset()` was restored
(`cp /tmp/hb-fixed.bak server/src/services/heartbeat.ts`), after which the same
command returned exit 0 / 11 passed. This is what makes the suite non-vacuous:
the card observed that today "a test asserting page 2 differs from page 1 would
pass vacuously, because nobody can page" — the mutation proves the assertion is
load-bearing.

The offset walk is bounded at 50 pages (`walkPages`) on purpose. With an inert
`offset` the page is never short and never advances, so an unbounded `for(;;)`
loop HANGS rather than fails — the first mutation run proved exactly that (the
third case failed by 15 s timeout, not by assertion). The bound converts the hang
into `offset loop never terminated`, a failure that names the defect.

### Base-red on the PR base (pre-existing, NOT caused by this diff)

Two failures reproduce on the **pristine** tree at base `b7a3a892d` with this diff
stashed (`git stash -q -u` → run → `git stash pop`). Both are therefore
`PRE-EXISTING-BASE-RED` under fleet WORKFLOW step 6 (SPA-9322), recorded here for
the verifier's independent re-classification:

| Check | Failure signature on base `b7a3a892d` (pristine, diff stashed) | Same signature with this diff? |
|---|---|---|
| `openapi-routes.test.ts > covers the mounted server routes exactly` | `missingInSpec: [ "GET /api/instance/settings/fleet-max-concurrent-runs", "PATCH /api/instance/settings/fleet-max-concurrent-runs" ]` | yes — byte-identical |
| `agent-live-run-routes.test.ts > returns a compact active run payload for issue polling` | `Error: Test timed out in 15000ms.` at `agent-live-run-routes.test.ts:397` | yes; re-run 3× on the pristine tree, **3/3 deterministically** the same 15 s timeout — deterministic, not flaky |

Base SHA pinned from the worktree's own HEAD with `git rev-parse HEAD` =
`b7a3a892d…`; base ref read live as
`gh repo view Spark-Mojo/paperclip --json defaultBranchRef` → `rebuild/v2026.916.0-survivors`
(`gh api repos/Spark-Mojo/paperclip` also reports `default_branch:
rebuild/v2026.916.0-survivors`, `allow_auto_merge: false`). Neither failure's
asserting code is touched by this diff: the first concerns `instance-settings`
route registrations in `openapi.ts` (this diff edits only the
`/api/companies/{companyId}/heartbeat-runs` registration); the second concerns
`GET /api/issues/:issueId/active-run`, which this diff does not modify.

This diff cannot repair them: the first names two routes (`fleet-max-concurrent-runs`)
that do not exist on this base at all, and the second's timeout is in a mocked
supertest call to a route this diff leaves untouched. Both are filed as a child
issue rather than fixed inside SPA-10587.

### Live instance note

The live `heartbeat-runs` route is served by the deployed engine build, not by
this branch, so the fixed behaviour is NOT yet observable on the running instance.
The pre-change measurement above is the live receipt; the post-change receipt is
this test run plus the spec change. Flagged, not claimed.

