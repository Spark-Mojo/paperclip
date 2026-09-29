import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// SPA-9282 — guard against a regression where a writer re-stamps
// context_snapshot + updated_at on already-terminal heartbeat_runs and the
// UI toasts each rewrite as a fresh failure. The block trigger is the
// belt-and-suspenders catch-all; the audit trigger is the diagnostic that
// surfaces the writer's call site so the writer-side fix can land.
//
// The full migration set is replayed via startEmbeddedPostgresTestDatabase,
// which already runs 0282_terminal_run_context_rewrite_block.sql — so both
// the block trigger and the audit trigger are installed before the test
// body executes. Tests seed heartbeat_runs rows and assert trigger
// behaviour directly.

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TERMINAL_RUN_ID = "50d635ad-3dfa-4ebf-8bb0-d34869c43f8a";
const TERMINAL_RUN_ID_2 = "d02721f6-94b4-4b28-bb2c-fd9ad5c596e1";

async function seedCompanyAgent(sql: postgres.Sql) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'SPA-9282', 'SP9')`;
  await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}, ${companyId}, 'SPA-9282 agent', 'engineer', 'process')`;
  return { companyId, agentId };
}

describeEmbeddedPostgres("SPA-9282 terminal-run context_rewrite block trigger", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it(
    "suppresses no-op rewrites of context_snapshot on terminal rows",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-spa-9282-block-trigger-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());

      // 0282 may need full schema to satisfy the function references; if
      // the replay succeeds, both triggers are installed. Otherwise we
      // install them here.
      await ensureBlockAndAuditTriggersInstalled(sql);

      const { companyId, agentId } = await seedCompanyAgent(sql);
      await sql`
        INSERT INTO heartbeat_runs (
          id, company_id, agent_id, status, liveness_state,
          context_snapshot, updated_at, created_at
        ) VALUES (
          ${TERMINAL_RUN_ID}::uuid, ${companyId}::uuid, ${agentId}::uuid,
          'failed', 'failed', ${sql.json({"phase":"first"})}, NOW(), NOW()
        )
      `;

      // First write CHANGES the snapshot to a stable value; subsequent
      // identical-rewrite attempts should be suppressed.
      const first = await sql`
        UPDATE heartbeat_runs
        SET context_snapshot = ${sql.json({"phase":"stable"})}, updated_at = NOW()
        WHERE id = ${TERMINAL_RUN_ID}::uuid
        RETURNING updated_at
      ` as Array<{ updated_at: Date }>;
      if (first.length !== 1) {
        throw new Error(`First UPDATE did not write the row (got ${first.length} rows)`);
      }
      const firstUpdatedAt = first[0].updated_at;

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Second write is byte-equal to the first — block trigger suppresses it.
      const second = await sql`
        UPDATE heartbeat_runs
        SET context_snapshot = ${sql.json({"phase":"stable"})}, updated_at = NOW()
        WHERE id = ${TERMINAL_RUN_ID}::uuid
        RETURNING updated_at
      ` as Array<{ updated_at: Date }>;

      if (second.length !== 0) {
        throw new Error(
          `Block trigger did not suppress no-op rewrite: row count = ${second.length}`,
        );
      }

      const after = await sql`
        SELECT updated_at FROM heartbeat_runs WHERE id = ${TERMINAL_RUN_ID}::uuid
      ` as Array<{ updated_at: Date }>;
      if (after[0].updated_at.getTime() !== firstUpdatedAt.getTime()) {
        throw new Error(
          `updated_at moved across suppressed write: ${firstUpdatedAt.toISOString()} vs ${after[0].updated_at.toISOString()}`,
        );
      }
    },
    60_000,
  );

  it(
    "allows substantive writes that change error_code or status",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-spa-9282-allow-substantive-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());

      await ensureBlockAndAuditTriggersInstalled(sql);

      const { companyId, agentId } = await seedCompanyAgent(sql);
      await sql`
        INSERT INTO heartbeat_runs (
          id, company_id, agent_id, status, liveness_state,
          error_code, context_snapshot, updated_at, created_at
        ) VALUES (
          ${TERMINAL_RUN_ID_2}::uuid, ${companyId}::uuid, ${agentId}::uuid,
          'failed', 'failed', null, null, NOW(), NOW()
        )
      `;

      await sql`
        UPDATE heartbeat_runs
        SET error_code = 'finalized_late', updated_at = NOW()
        WHERE id = ${TERMINAL_RUN_ID_2}::uuid
      `;
      const rows1 = await sql`
        SELECT error_code FROM heartbeat_runs WHERE id = ${TERMINAL_RUN_ID_2}::uuid
      ` as Array<{ error_code: string }>;
      if (rows1[0].error_code !== "finalized_late") {
        throw new Error("substantive error_code write was suppressed");
      }

      await sql`
        UPDATE heartbeat_runs
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = ${TERMINAL_RUN_ID_2}::uuid
      `;
      const rows2 = await sql`
        SELECT status FROM heartbeat_runs WHERE id = ${TERMINAL_RUN_ID_2}::uuid
      ` as Array<{ status: string }>;
      if (rows2[0].status !== "cancelled") {
        throw new Error("status-transition write was suppressed");
      }
    },
    60_000,
  );

  it(
    "audit trigger captures UPDATE on the five observed ids",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-spa-9282-audit-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());

      await ensureBlockAndAuditTriggersInstalled(sql);

      const { companyId, agentId } = await seedCompanyAgent(sql);
      await sql`
        INSERT INTO heartbeat_runs (
          id, company_id, agent_id, status, liveness_state,
          context_snapshot, updated_at, created_at
        ) VALUES (
          ${TERMINAL_RUN_ID}::uuid, ${companyId}::uuid, ${agentId}::uuid,
          'failed', 'failed', null, NOW(), NOW()
        )
      `;
      await sql`
        UPDATE heartbeat_runs
        SET context_snapshot = NULL, updated_at = NOW()
        WHERE id = ${TERMINAL_RUN_ID}::uuid
      `;
      const audit = await sql`
        SELECT run_id, status, liveness_state
        FROM heartbeat_run_writer_audit
        WHERE run_id = ${TERMINAL_RUN_ID}::uuid
        ORDER BY id DESC
        LIMIT 1
      ` as Array<{ run_id: string; status: string; liveness_state: string }>;
      if (audit.length < 1) {
        throw new Error("audit trigger did not capture the UPDATE");
      }
      if (audit[0].status !== "failed" || audit[0].liveness_state !== "failed") {
        throw new Error("audit captured wrong state");
      }
    },
    60_000,
  );
});

async function ensureBlockAndAuditTriggersInstalled(
  sql: postgres.Sql,
): Promise<void> {
  const blockTrigger = await sql`
    SELECT 1 FROM pg_trigger WHERE tgname = 'heartbeat_runs_block_terminal_no_op_context_rewrite_trg'
  ` as Array<{ "?column?": number }>;
  const auditTrigger = await sql`
    SELECT 1 FROM pg_trigger WHERE tgname = 'heartbeat_runs_audit_terminal_run_writer_trg'
  ` as Array<{ "?column?": number }>;
  if (blockTrigger.length === 0 || auditTrigger.length === 0) {
    // Defensive: if 0282 didn't run (older fixture), install the triggers
    // here. Production never hits this code path because the migration is
    // required for the fix.
    const fixup = await import("node:fs/promises");
    const path = (await import("node:url")).fileURLToPath(
      new URL("./migrations/0282_terminal_run_context_rewrite_block.sql", import.meta.url),
    );
    const source = await fixup.readFile(path, "utf8");
    await sql.unsafe(source);
  }
}