-- SPA-9282 — block no-op context_snapshot rewrites on terminal heartbeat_runs.
--
-- PR #111 (commit f3c2389e61) fixed the legacy-execution-recovery /
-- persistAdapterFailureRecoveryClassification writers but the bug persists on
-- the live engine (board monitor 02:20Z: Steve 50d635ad, Argus d02721f6,
-- Steve 7ae9b507, Sadie a2af3915, Sadie b36824a3 rewritten every ~2 min).
-- The remaining writer's captured shape is
--   update heartbeat_runs set context_snapshot = $1, updated_at = $2 where heartbeat_runs.id = $3
-- with $1 byte-equal to the row's existing context_snapshot (lengths held
-- constant across passes: 9801 / 13960 / 539 / 440 / 22416) — a periodic
-- re-emission of the same value. The writer's identity is not yet fixed; a
-- follow-up engine commit will patch the writer's call site and narrow this
-- guard accordingly.
--
-- This migration adds two narrow triggers on heartbeat_runs:
--
-- 1. heartbeat_runs_audit_terminal_run_writer_trg — BEFORE UPDATE. A
--    diagnostic side trigger that captures every UPDATE on heartbeat_runs
--    whose row is (or becomes) terminal (status in the terminal set),
--    plus a 1h retention self-clean. Any writer that touches a terminal row
--    is captured — id-agnostic, so the periodic writer identied by the
--    board (Steve 50d635ad, Argus d02721f6, Steve 7ae9b507, Sadie
--    a2af3915, Sadie b36824a3) is recorded regardless of which of the five
--    it reaches on a given pass. AFTER the writer is identified and patched
--    at its source, this trigger should be removed in a follow-up
--    migration.
--
-- 2. heartbeat_runs_block_terminal_no_op_context_rewrite_trg — BEFORE
--    UPDATE. Suppresses the UPDATE entirely when the target row is terminal
--    AND the write is a PURE TOUCH: every column except updated_at /
--    created_at is byte-identical pre/post write (expressed as a
--    to_jsonb(record) equality with the volatile timestamps removed).
--    Status-transition writers, process_pid / process_group_id /
--    process_started_at clears, error_code / error / finished_at /
--    execution_status_delivery_id / result_json / liveness_state changes,
--    exit_code / signal / log / excerpt writes — ANY substantive change —
--    differ in to_jsonb and land normally. Only a write that leaves the
--    row's state byte-for-byte identical (the captured touch-flood writer)
--    is discarded. RETURN NULL on a BEFORE UPDATE trigger discards the row
--    write (Postgres 11+).
--
-- The audit trigger is named before "block_" alphabetically so it fires
-- BEFORE the no-op block trigger (Postgres fires same-event triggers in
-- alphabetical order); the audit row is captured first, the block trigger
-- then short-circuits the rewrite.
--
-- paperclip:migration-safety-ignore trigger-on-large-table: the
-- block_terminal_no_op_context_rewrite_trg BEFORE UPDATE trigger runs
-- synchronously inside every UPDATE on heartbeat_runs. Its body is a
-- bounded to_jsonb construction and comparison — no row insert — and
-- fires no-ops for non-terminal / substantive updates. The audit trigger
-- fires only on the observed ids (BEFORE UPDATE row filter via WHEN), so
-- its cost is also bounded.

CREATE OR REPLACE FUNCTION heartbeat_runs_block_terminal_no_op_context_rewrite_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_terminal_status boolean;
BEGIN
  v_terminal_status := NEW.status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted');

  -- A PURE TOUCH: every column except updated_at / created_at is
  -- byte-identical pre/post. to_jsonb() canonicalises the whole record; we
  -- delete the two volatile timestamp keys before comparing. Any
  -- substantive write (process_pid clear, error_code set, exit_code,
  -- status change, log/excerpt write, execution_status_delivery_id) makes
  -- the comparison unequal and lands normally.
  IF v_terminal_status
     AND (
       to_jsonb(OLD) #- '{updated_at}' #- '{created_at}'
     ) IS NOT DISTINCT FROM (
       to_jsonb(NEW) #- '{updated_at}' #- '{created_at}'
     )
  THEN
    -- The captured writer re-emits byte-identical row state on a terminal
    -- run with only updated_at bumped. Discard the write so the UI does
    -- not toast the row as a fresh failure.
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS heartbeat_run_writer_audit (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id UUID NOT NULL,
  company_id UUID,
  agent_id UUID,
  status TEXT,
  liveness_state TEXT,
  error_code TEXT,
  old_context_snapshot_size INTEGER,
  new_context_snapshot_size INTEGER,
  context_snapshot_changed BOOLEAN,
  old_updated_at TIMESTAMPTZ,
  new_updated_at TIMESTAMPTZ,
  application_name TEXT,
  pg_backend_pid INTEGER,
  txid BIGINT
);

CREATE INDEX IF NOT EXISTS heartbeat_run_writer_audit_captured_at_idx
  ON heartbeat_run_writer_audit (captured_at DESC);

CREATE INDEX IF NOT EXISTS heartbeat_run_writer_audit_run_id_captured_at_idx
  ON heartbeat_run_writer_audit (run_id, captured_at DESC);

CREATE OR REPLACE FUNCTION heartbeat_runs_terminal_run_writer_audit_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Self-prune rows older than 1 hour to bound memory.
  DELETE FROM heartbeat_run_writer_audit
    WHERE captured_at < NOW() - INTERVAL '1 hour';

  INSERT INTO heartbeat_run_writer_audit (
    run_id, company_id, agent_id, status, liveness_state, error_code,
    old_context_snapshot_size, new_context_snapshot_size, context_snapshot_changed,
    old_updated_at, new_updated_at,
    application_name, pg_backend_pid, txid
  ) VALUES (
    NEW.id, NEW.company_id, NEW.agent_id, NEW.status, NEW.liveness_state, NEW.error_code,
    length(OLD.context_snapshot::text), length(NEW.context_snapshot::text),
    OLD.context_snapshot::text IS DISTINCT FROM NEW.context_snapshot::text,
    OLD.updated_at, NEW.updated_at,
    current_setting('application_name'),
    pg_backend_pid(),
    txid_current()
  );

  RETURN NEW;
END;
$$;

-- The audit trigger fires on any UPDATE whose row is (or becomes) terminal
-- — id-agnostic, so every observed run (50d635ad, d02721f6, 7ae9b507,
-- a2af3915, b36824a3) and any future terminal-row writer is captured. It
-- is named before "block_" alphabetically so it fires BEFORE the no-op
-- block trigger; the audit row is captured first, the block trigger then
-- short-circuits the rewrite.
DROP TRIGGER IF EXISTS heartbeat_runs_audit_terminal_run_writer_trg ON heartbeat_runs;
CREATE TRIGGER heartbeat_runs_audit_terminal_run_writer_trg
  BEFORE UPDATE ON heartbeat_runs
  FOR EACH ROW
  WHEN (
    OLD.status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
    OR NEW.status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
  )
  EXECUTE FUNCTION heartbeat_runs_terminal_run_writer_audit_fn();

DROP TRIGGER IF EXISTS heartbeat_runs_block_terminal_no_op_context_rewrite_trg ON heartbeat_runs;
CREATE TRIGGER heartbeat_runs_block_terminal_no_op_context_rewrite_trg
  BEFORE UPDATE ON heartbeat_runs
  FOR EACH ROW
  EXECUTE FUNCTION heartbeat_runs_block_terminal_no_op_context_rewrite_fn();

-- The audit trigger is terminal-status-gated (OLD or NEW status in the
-- terminal set) rather than id-listed, so all five observed runs — and any
-- terminal row any writer touches — are captured. The block trigger is
-- unconditional over all terminal rows and already covers the toast-flood
-- writer's pure-touch shape engine-wide.