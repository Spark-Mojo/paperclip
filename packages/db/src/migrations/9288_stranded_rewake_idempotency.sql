UPDATE "agent_wakeup_requests"
SET "idempotency_key" = NULL,
    "updated_at" = now()
WHERE "idempotency_key" IS NOT NULL
  AND (
    "idempotency_key" LIKE 'exhausted_retry_rewake:%'
    OR "idempotency_key" LIKE 'orphaned_retry_rewake:%'
  )
  AND "id" IN (
    SELECT "id"
    FROM (
      SELECT
        "id",
        row_number() OVER (
          PARTITION BY "company_id", "idempotency_key"
          ORDER BY "requested_at", "id"
        ) AS "occurrence"
      FROM "agent_wakeup_requests"
      WHERE "idempotency_key" IS NOT NULL
        AND (
          "idempotency_key" LIKE 'exhausted_retry_rewake:%'
          OR "idempotency_key" LIKE 'orphaned_retry_rewake:%'
        )
    ) AS "ranked"
    WHERE "ranked"."occurrence" > 1
  );
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this partial index is the atomic at-most-once dispatch budget for a stranded-recovery failure episode. Redundant historical keys are NULLed above rather than deleted, so the receipts are retained and the partial predicate skips them.
CREATE UNIQUE INDEX "agent_wakeup_requests_exhausted_retry_rewake_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'exhausted_retry_rewake:%';
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this partial index is the atomic at-most-once re-dispatch budget for a restart-orphaned retry episode.
CREATE UNIQUE INDEX "agent_wakeup_requests_orphaned_retry_rewake_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'orphaned_retry_rewake:%';
