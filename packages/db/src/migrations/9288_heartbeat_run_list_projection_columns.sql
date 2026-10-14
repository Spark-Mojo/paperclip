-- SPA-11947 — keep the heartbeat_runs run-list projections off the wide JSONB
-- documents.
--
-- Two projections are read on every board poll and both used to dereference
-- `context_snapshot` / `result_json` per row:
--
--   * server/src/services/activity.ts `runsForIssue` (the issue run ledger) —
--     projected `context_snapshot->>'issueId'` (projection AND the issue
--     predicate), `->> 'commentId'`, `->> 'wakeCommentId'`, `-> 'wakeCommentIds'`
--     and built a narrowed result object out of eleven `result_json` keys.
--   * server/src/services/heartbeat.ts `list` — projected eight
--     `context_snapshot->>'key'` scalars plus seven `result_json->>'key'`
--     scalars in the non-summary shape.
--
-- Both now read narrow STORED generated columns, the same shape migration 9284
-- (SPA-11865) introduced for `context_issue_id` / `context_task_id`. 9284
-- already landed those two; this migration adds ONLY the remaining context keys
-- the two projections return and the result scalars they need.
--
-- `result_ledger_summary` stores the activity ledger's narrowed result object
-- verbatim. The expression is byte-for-byte the one the projection used to
-- evaluate per row — moving it to a stored column means the poll reads one
-- narrow JSONB value instead of de-TOASTing `result_json` for every run in the
-- window, and the returned object is unchanged because the same expression
-- over the same row yields the same value.
--
-- WHY THE EXPRESSION IS ASSEMBLED BY HAND (the 42P17 repair).
-- The first cut of this migration wrote that narrowed object as
-- jsonb_strip_nulls(jsonb_build_object(...)). PostgreSQL rejected it when the
-- migration was applied inside the embedded-Postgres test cluster (the failure
-- was in the test apply, never in production): SQLSTATE 42P17, "generation
-- expression is not immutable". jsonb_build_object and jsonb_strip_nulls are
-- both STABLE, not IMMUTABLE, so they may not appear in a STORED generated
-- column.
--
-- We do NOT work around 42P17 by wrapping the expression in a function marked
-- IMMUTABLE. jsonb_build_object is STABLE precisely because it accepts variadic
-- "any" arguments that may themselves be non-immutable; declaring a wrapper
-- IMMUTABLE asserts a false fact that the planner is entitled to fold into a
-- stored value.
--
-- Instead the same object is assembled from pieces PostgreSQL DOES classify as
-- IMMUTABLE — the jsonb operators (-> and ->>), jsonb_set, jsonb concatenation
-- (||) and an equality test against the JSON null literal:
--
--   * jsonb_set(target, path, new_value, true) returns `target` unchanged when
--     `new_value` is SQL NULL, so each fragment is emitted as either a
--     single-key object or an empty object, and the fragments are concatenated
--     with `||`.
--   * A value that is SQL NULL (key absent) or the JSON literal null (key
--     present with a null value) contributes `'{}'::jsonb`, i.e. the key is
--     omitted. That is exactly what jsonb_strip_nulls removed from the
--     jsonb_build_object output, and the `= 'null'::jsonb` test reproduces it
--     without calling jsonb_strip_nulls.
--   * Every surviving value is written verbatim by jsonb_set, so scalars,
--     arrays and nested objects are preserved unchanged.
--
-- The one behaviour worth stating explicitly, because it is surprising and is
-- inherited from the old per-row expression rather than introduced here:
-- `result_json -> 'key'` on a key that is PRESENT with a JSON null value yields
-- the jsonb value `null`, not SQL NULL. coalesce() therefore does not fall
-- through to the next alias in that alias's own precedence order, and the
-- resulting null is then omitted. So `{"costUsd": null, "cost_usd": 2}`
-- omits only `costUsd`; the independently ordered `cost_usd` and
-- `total_cost_usd` aliases still resolve to 2. With no explicit JSON null,
-- `{"cost_usd": 2}` contributes all three cost aliases. The migration
-- preserves that behaviour exactly.
--
-- `result_list_*` store the UNTRUNCATED text. The `left(..., 500)` bound stays
-- in server/src/services/heartbeat-run-summary.ts
-- (HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) and the projection keeps applying it
-- at read time — this package must not import from server.
--
-- One ALTER TABLE, fifteen ADD COLUMN actions, so PostgreSQL performs ONE
-- table rewrite (PG 11+ rewrites once per ALTER TABLE command when several
-- columns are added together; fifteen separate statements would mean fifteen
-- full rewrites of the 2.7 GB relation). The rewrite is the cost of the fix —
-- it happens once, in a quiet window.
--
-- No covering index is added here. The two run-list shapes are already served
-- by heartbeat_runs_company_agent_started_idx (company_id, agent_id, started_at)
-- and heartbeat_runs_company_created_at_desc_idx, and 9284's covering btree
-- already INCLUDEs context_issue_id / context_task_id. Widening either is a
-- separate, data-driven change and would put a non-CONCURRENTLY CREATE INDEX on
-- a known-large table into this migration.
--
-- paperclip:migration-safety-ignore full-table-mutation-large-table: ADD
-- COLUMN ... GENERATED ALWAYS AS (...) STORED has no WHERE clause — it's the
-- Postgres-native definition of "rewrite the entire relation to add the stored
-- expression". PG cannot add a STORED generated column without rewriting the
-- heap, and there is exactly ONE such rewrite here: the ledger column is a
-- generated column too, so no second table-wide UPDATE is required after it.
-- We accept the one-time 2.7 GB rewrite during a quiet window. SPA-9282's
-- audit/block trigger pair is still active and has held terminal-row rewrites
-- byte-stable since 2026-09-30.
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "context_task_key" text GENERATED ALWAYS AS (context_snapshot ->> 'taskKey') STORED,
  ADD COLUMN IF NOT EXISTS "context_comment_id" text GENERATED ALWAYS AS (context_snapshot ->> 'commentId') STORED,
  ADD COLUMN IF NOT EXISTS "context_wake_comment_id" text GENERATED ALWAYS AS (context_snapshot ->> 'wakeCommentId') STORED,
  ADD COLUMN IF NOT EXISTS "context_wake_comment_ids" jsonb GENERATED ALWAYS AS (context_snapshot -> 'wakeCommentIds') STORED,
  ADD COLUMN IF NOT EXISTS "context_wake_reason" text GENERATED ALWAYS AS (context_snapshot ->> 'wakeReason') STORED,
  ADD COLUMN IF NOT EXISTS "context_wake_source" text GENERATED ALWAYS AS (context_snapshot ->> 'wakeSource') STORED,
  ADD COLUMN IF NOT EXISTS "context_wake_trigger_detail" text GENERATED ALWAYS AS (context_snapshot ->> 'wakeTriggerDetail') STORED,
  ADD COLUMN IF NOT EXISTS "result_list_summary" text GENERATED ALWAYS AS (result_json ->> 'summary') STORED,
  ADD COLUMN IF NOT EXISTS "result_list_result" text GENERATED ALWAYS AS (result_json ->> 'result') STORED,
  ADD COLUMN IF NOT EXISTS "result_list_message" text GENERATED ALWAYS AS (result_json ->> 'message') STORED,
  ADD COLUMN IF NOT EXISTS "result_list_error" text GENERATED ALWAYS AS (result_json ->> 'error') STORED,
  ADD COLUMN IF NOT EXISTS "result_list_total_cost_usd" text GENERATED ALWAYS AS (result_json ->> 'total_cost_usd') STORED,
  ADD COLUMN IF NOT EXISTS "result_list_cost_usd" text GENERATED ALWAYS AS (result_json ->> 'cost_usd') STORED,
  ADD COLUMN IF NOT EXISTS "result_list_cost_usd_camel" text GENERATED ALWAYS AS (result_json ->> 'costUsd') STORED,
  ADD COLUMN IF NOT EXISTS "result_ledger_summary" jsonb GENERATED ALWAYS AS (
    case
      when result_json is null then null
      else
        case
          when (result_json -> 'conversationReset') is null
            or (result_json -> 'conversationReset') = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{conversationReset}', result_json -> 'conversationReset', true)
        end
        || case
          when (coalesce(result_json -> 'billingType', result_json -> 'billing_type')) is null
            or (coalesce(result_json -> 'billingType', result_json -> 'billing_type')) = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{billingType}', coalesce(result_json -> 'billingType', result_json -> 'billing_type'), true)
        end
        || case
          when (coalesce(result_json -> 'billing_type', result_json -> 'billingType')) is null
            or (coalesce(result_json -> 'billing_type', result_json -> 'billingType')) = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{billing_type}', coalesce(result_json -> 'billing_type', result_json -> 'billingType'), true)
        end
        || case
          when (coalesce(result_json -> 'costUsd', result_json -> 'cost_usd', result_json -> 'total_cost_usd')) is null
            or (coalesce(result_json -> 'costUsd', result_json -> 'cost_usd', result_json -> 'total_cost_usd')) = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{costUsd}', coalesce(result_json -> 'costUsd', result_json -> 'cost_usd', result_json -> 'total_cost_usd'), true)
        end
        || case
          when (coalesce(result_json -> 'cost_usd', result_json -> 'costUsd', result_json -> 'total_cost_usd')) is null
            or (coalesce(result_json -> 'cost_usd', result_json -> 'costUsd', result_json -> 'total_cost_usd')) = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{cost_usd}', coalesce(result_json -> 'cost_usd', result_json -> 'costUsd', result_json -> 'total_cost_usd'), true)
        end
        || case
          when (coalesce(result_json -> 'total_cost_usd', result_json -> 'cost_usd', result_json -> 'costUsd')) is null
            or (coalesce(result_json -> 'total_cost_usd', result_json -> 'cost_usd', result_json -> 'costUsd')) = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{total_cost_usd}', coalesce(result_json -> 'total_cost_usd', result_json -> 'cost_usd', result_json -> 'costUsd'), true)
        end
        || case
          when (result_json -> 'stopReason') is null
            or (result_json -> 'stopReason') = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{stopReason}', result_json -> 'stopReason', true)
        end
        || case
          when (result_json -> 'effectiveTimeoutSec') is null
            or (result_json -> 'effectiveTimeoutSec') = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{effectiveTimeoutSec}', result_json -> 'effectiveTimeoutSec', true)
        end
        || case
          when (result_json -> 'effectiveTimeoutMs') is null
            or (result_json -> 'effectiveTimeoutMs') = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{effectiveTimeoutMs}', result_json -> 'effectiveTimeoutMs', true)
        end
        || case
          when (result_json -> 'timeoutConfigured') is null
            or (result_json -> 'timeoutConfigured') = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{timeoutConfigured}', result_json -> 'timeoutConfigured', true)
        end
        || case
          when (result_json -> 'timeoutSource') is null
            or (result_json -> 'timeoutSource') = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{timeoutSource}', result_json -> 'timeoutSource', true)
        end
        || case
          when (result_json -> 'timeoutFired') is null
            or (result_json -> 'timeoutFired') = 'null'::jsonb
            then '{}'::jsonb
          else jsonb_set('{}'::jsonb, '{timeoutFired}', result_json -> 'timeoutFired', true)
        end
    end
  ) STORED;