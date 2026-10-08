CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_missing_terminal_liveness_idx"
  ON "heartbeat_runs" USING btree ("company_id")
  WHERE "liveness_state" IS NULL AND "status" NOT IN ('queued', 'running');
