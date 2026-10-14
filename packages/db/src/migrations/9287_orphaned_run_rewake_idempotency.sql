-- SPA-12218: make the startup orphan re-wake's "at most one wake per orphaned
-- run, ever" claim a database invariant instead of a hopeful read.
--
-- When the engine is SIGKILLed, systemd restarts it and the startup backstop
-- terminalizes the orphaned runs with errorCode `orphaned_running_run`. The new
-- `reconcileOrphanedRunIssues` sweep then re-wakes the cards whose execution was
-- lost (2026-10-13: 17 runs orphaned, 14 cards needed a human to wake them).
--
-- That sweep's dedupe is a SELECT followed by an INSERT. Two boots racing (a
-- restart while another restart is still recovering, or two instances during a
-- drain) can both observe no receipt and both emit a wake, giving one orphaned
-- run two live runs — the exact double-execution the sweep exists to prevent.
-- This partial unique index closes that window at the only layer that can: the
-- second INSERT raises a unique violation, which the sweep treats as "the other
-- boot's wake counts" rather than as an error.
--
-- Partial, and scoped to this sweep's key namespace:
--   * `status <> 'skipped'` preserves retry semantics. A wake request recorded
--     as `skipped` never became a wake, so a later boot may still legitimately
--     try — exactly as the sweep's own read-then-write check already does.
--   * the LIKE predicate keeps every other recovery prefix free, matching the
--     sibling indexes on this table.
--
-- Safe to build: the `issue_orphaned_run_rewake:%` key namespace is empty in
-- every existing deployment. The sweep ships in the same change as this index,
-- so no deployment can already hold a row under that prefix, and therefore no
-- duplicate (company_id, idempotency_key) group exists to collide.
--
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle
-- migrations run transactionally, so CONCURRENTLY is unavailable. The indexed
-- key namespace is empty at migration time, so this index scans no rows.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_orphaned_run_rewake_idempotency_uq"
  ON "agent_wakeup_requests" ("company_id", "idempotency_key")
  WHERE "idempotency_key" LIKE 'issue_orphaned_run_rewake:%'
    AND "status" <> 'skipped';