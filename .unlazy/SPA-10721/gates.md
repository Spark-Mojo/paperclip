# SPA-10721 gates

Card: SPA-10721 — GitHub #1288 **ambiguous-write / response-loss** class (engine, `Spark-Mojo/paperclip`).
Base: `refs/remotes/origin/rebuild/v2026.916.0-survivors` @ `818d2fb85f874c9433363b4ee02fb25b6f9acd3c`.
Card branch: `ty/SPA-10721-ambiguous-write`.

## Why this change

A `PATCH /api/issues/{id}` can **commit server-side while its response is lost** — the client sees
HTTP `000`. The caller then cannot tell *"applied, response dropped"* from *"refused"*; the retry
re-asserts the terminal status the card now holds and (today) gets a bare `409
issue_write_terminal_recomplete` that reads like a refusal, so runs burn retries misreading a landed
write as a failed one (3 runs, SPA-10006).

Fix: **make the denial self-describing as a read-back.** The terminal-recomplete `409` now carries
`details.terminalStatusAlreadySet: true` and `details.currentStatus: <status>`, and its copy names the
lost-response retry. A single retry after a dropped response now resolves the ambiguity with no second
round trip. The guard itself (and SPA-5916's no-re-stamp policy) is unchanged: still `409`, still no
side effects. Field name is scoped to the **status** on purpose — a PATCH that also carried a comment
was refused wholesale, so a blanket `alreadyApplied` would be a lie.

**Deliberately NOT done:** flipping the equal-terminal retry to `200`. That would (a) reverse the
locked SPA-5916 fork-carry contract and its two tests, and (b) create a *new* lie — a retry carrying a
comment would read as applied though the comment never landed (see the existing no-replay test). The
advisor's idempotent-200 variant was considered and rejected on that concrete evidence.

**Not this card:** the absent-listener outage class (SPA-10725, PR #160). The `GET /api/issues/{id}`
vs sibling-route asymmetry is written up on the card as a root-cause note, not a second code fix.

## Deliverables

DELIVERABLE: d1-readback-copy | craft: craft-general | paths: packages/shared/src/issue-write-denial.ts
DELIVERABLE: d2-readback-details | craft: craft-general | paths: server/src/routes/issues.ts
DELIVERABLE: d3-readback-oracle | craft: craft-tests | tests-for: d1-readback-copy,d2-readback-details | paths: server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts packages/shared/src/issue-write-denial.test.ts

## Gates

GATE: g1-shared-copy | deliverable: d1-readback-copy,d3-readback-oracle
  CHECK: timeout 300 pnpm exec vitest run packages/shared/src/issue-write-denial.test.ts
  EXPECT: exit 0; "Test Files 1 passed (1)"
  NEGATIVE: mutate `already landed` -> `already recorded` in `packages/shared/src/issue-write-denial.ts` (valid syntax), rerun the same suite, expect nonzero naming the read-back assertion; restore; rerun exit 0.
  RESULT: exit 0 — `Test Files 1 passed (1)`, `Tests 18 passed (18)` (17 pre-existing + 1 new), 2026-10-09 16:46Z.
  NEGATIVE-RESULT: exit 1 — `Tests 1 failed | 17 passed (18)`; `AssertionError: expected 'this task is in a terminal status, an…' to contain 'already landed'` at issue-write-denial.test.ts:143. RESTORE: source sha256 `71dd7407e166631bc84bd7b726aab3191fdbfed25684b3cbea861572f0f02b6b` == BEFORE sha256; rerun 18 passed exit 0.

GATE: g2-route-readback | deliverable: d2-readback-details,d3-readback-oracle
  CHECK: timeout 300 pnpm exec vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts --testTimeout=60000
  EXPECT: exit 0; target suite passes including the terminal-recomplete read-back assertions and the negative control (a legitimate todo->done is not labeled).
  NEGATIVE: replace the read-back extraDetails object with `{}` in `server/src/routes/issues.ts`, rerun the same suite, expect nonzero on `terminalStatusAlreadySet`; restore; rerun exit 0.
  RESULT: exit 0 — `Test Files 1 passed (1)`, `Tests 116 passed (116)`, 2026-10-09 16:52Z. `--testTimeout=60000` is an environmental override: on this box the suite's module transform is ~12s and per-test setup is heavy (load avg ~13); under the default 15s per-test budget two *unrelated* tests (`denies company-wide issue list routes for task bridge keys` at :789, and one run of the it.each) spuriously timed out at 15 000 ms. The it.each passed unchanged at 60s, so the timeout is load, not logic. A rebuild of the shared package (`tsc`) was needed so the server resolves the edited copy.
  NEGATIVE-RESULT: exit 1 — `Tests 2 failed | 114 skipped (116)`; both it.each cases fail `AssertionError: expected undefined to be true ... expect(res.body.details?.terminalStatusAlreadySet).toBe(true)` at issue-agent-mutation-ownership-routes.test.ts:3063. RESTORE: route sha256 `09ed88e16d4c9be57d9a03d35668c3fd5148e5d6b5492b6eafb94ef2b6d46b9c` == BEFORE sha256; rerun 2 passed exit 0.

GATE: g3-typecheck | deliverable: d1-readback-copy,d2-readback-details
  CHECK: timeout 600 pnpm exec tsc --noEmit -p server/tsconfig.json
  EXPECT: exit 0, no diagnostics
  NEGATIVE: n/a — a type-only no-op mutation is not a safe failing input for a compiler gate; the compiler is its own oracle.
  RESULT: exit 0, no output, 2026-10-09 16:57Z. The package script `pnpm --filter @paperclipai/server typecheck` cannot complete in this environment — it runs `prepare:runner-vendor`, whose `build:binary` needs `cargo` (not installed: `sh: 1: cargo: not found`), unrelated to this diff. Resolved the equivalent way: `pnpm --filter @paperclipai/plugin-sdk build` exit 0 and `pnpm --filter @paperclipai/paperclip-runner build:typescript` exit 0 (provides `@paperclipai/plugin-sdk` + `@paperclipai/paperclip-runner` types), then `tsc --noEmit -p server/tsconfig.json` exit 0 with no diagnostics.

## Oracle narrative (positive + negative)

- **Simulated lost-response retry (positive):** the first `PATCH {status:"done"}` on a `todo` card
  commits (200). The dropped response is modeled by the next request re-asserting the now-persisted
  status: `PATCH {status:"done"}` on the `done` row returns `409` whose body carries
  `terminalStatusAlreadySet: true` and `currentStatus: "done"` and copy saying the write already
  landed. The caller resolves applied-vs-refused from that single response.
- **Negative control (no blanket labeling):** a genuine `todo -> done` still returns `200`, updates,
  and carries **no** `terminalStatusAlreadySet`/`currentStatus` — proving the read-back is not applied
  to real transitions.
- **Negative control (scoped, no lie):** a `PATCH {status:"done", comment:"..."}` on a `done` card
  still `409`s with no side effects; it reports `terminalStatusAlreadySet` but **not** a blanket
  `alreadyApplied`, because the comment did not land.
