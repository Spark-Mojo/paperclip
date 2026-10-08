import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const SPA_11264_INDEX_NAME = "heartbeat_runs_company_missing_terminal_liveness_idx";
const SPA_11264_MIGRATION_FILE = "9283_missing_terminal_run_liveness_index.sql";
const SPA_11264_JOURNAL_TAG = "9283_missing_terminal_run_liveness_index";
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));
const JOURNAL_PATH = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("./schema/heartbeat_runs.ts", import.meta.url));

const SPA_10699_FROZEN_INDEX_NAME = "sm_heartbeat_runs_company_ctx_pcissue_idx";

async function readMigrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((entry) => entry.endsWith(".sql")).sort();
}

async function readMigration(fileName: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./migrations/${fileName}`, import.meta.url)), "utf8");
}

async function readJournal(): Promise<{ entries: Array<{ idx: number; tag: string; when: number }> }> {
  return JSON.parse(await readFile(JOURNAL_PATH, "utf8"));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

type IndexRow = { indexname: string; indexdef: string };

async function readHeartbeatRunIndexes(sql: postgres.Sql): Promise<IndexRow[]> {
  const rows = (await sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'heartbeat_runs'
    ORDER BY indexname
  `) as unknown as IndexRow[];
  return rows;
}

async function readIndexDefinition(sql: postgres.Sql, indexName: string): Promise<string | null> {
  const rows = (await sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'heartbeat_runs' AND indexname = ${indexName}
  `) as unknown as IndexRow[];
  return rows[0]?.indexdef ?? null;
}

type IndexDefinitionRow = {
  indexdef: string | null;
  predicate: string | null;
};

async function readParsedIndexDefinition(
  sql: postgres.Sql,
  indexName: string,
): Promise<IndexDefinitionRow | null> {
  const rows = (await sql.unsafe(
    `SELECT pg_get_indexdef(c.oid) AS indexdef, pg_get_expr(i.indpred, i.indrelid) AS predicate
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_class t ON t.oid = i.indrelid
     WHERE t.relname = 'heartbeat_runs' AND c.relname = $1`,
    [indexName],
  )) as unknown as IndexDefinitionRow[];
  return rows[0] ?? null;
}

d("heartbeat context_snapshot expression index migration", () => {
  it("applies full migration chain and uses the new indexes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap16575-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('heartbeat_runs','agent_wakeup_requests')`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_task_created_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_taskkey_created_idx");
    expect(names).toContain("agent_wakeup_requests_company_payload_issue_idx");
    expect(names).toContain(SPA_11264_INDEX_NAME);

    await sql.unsafe("SET enable_seqscan = off");
    const missingPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND liveness_state IS NULL AND status NOT IN ('queued', 'running') LIMIT 20",
    );
    expect(missingPlan.map((r) => Object.values(r)[0]).join("\n")).toContain(SPA_11264_INDEX_NAME);

    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'issueId' = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("heartbeat_runs_company_ctx_issue_created_idx");

    const taskPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'taskId' = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const taskText = taskPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(taskText).toContain("heartbeat_runs_company_ctx_task_created_idx");

    // The productivity-review run scope ORs issueId/taskId/taskKey; all three
    // expression indexes must exist so the planner can BitmapOr at real row
    // counts instead of detoasting every run snapshot for the agent. An empty
    // table plans a single index scan, so assert the taskKey index directly.
    const taskKeyPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'taskKey' = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const taskKeyText = taskKeyPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(taskKeyText).toContain("heartbeat_runs_company_ctx_taskkey_created_idx");

    const wakePlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM agent_wakeup_requests WHERE company_id = '00000000-0000-0000-0000-000000000001' AND status = 'deferred_issue_execution' AND payload ->> 'issueId' = 'x' LIMIT 1",
    );
    const wakeText = wakePlan.map((r) => Object.values(r)[0]).join("\n");
    expect(wakeText).toContain("agent_wakeup_requests_company_payload_issue_idx");

    // Idempotency: re-running the migration statements against an already
    // migrated database must be a no-op, not an error.
    for (const migration of [
      "./migrations/0209_heartbeat_context_snapshot_indexes.sql",
      "./migrations/0210_heartbeat_context_taskkey_index.sql",
    ]) {
      const migrationSql = await readFile(
        fileURLToPath(new URL(migration, import.meta.url)),
        "utf8",
      );
      const statements = migrationSql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    }
  }, 240_000);

  it("registers the migration in the journal exactly once, last, under the exact tag", async () => {
    const journal = await readJournal();
    const migrationFiles = await readMigrationFiles();

    const matches = journal.entries.filter((entry) => entry.tag === SPA_11264_JOURNAL_TAG);
    expect(matches).toHaveLength(1);
    expect(matches[0].tag).toBe(SPA_11264_JOURNAL_TAG);
    expect(matches[0].idx).toBe(9283);
    expect(typeof matches[0].when).toBe("number");

    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(migrationFiles);

    const tagIndexInFiles = migrationFiles.indexOf(SPA_11264_MIGRATION_FILE);
    const tagIndexInJournal = journal.entries.findIndex(
      (entry) => entry.tag === SPA_11264_JOURNAL_TAG,
    );
    expect(tagIndexInJournal).toBe(tagIndexInFiles);
  });

  it("declares the same index name and the same partial predicate in drizzle schema, migration SQL and the live catalogue", async () => {
    const migration = await readMigration(SPA_11264_MIGRATION_FILE);
    const schema = await readFile(SCHEMA_PATH, "utf8");
    const migrationCollapsed = collapseWhitespace(migration);

    expect(migrationCollapsed).toContain(
      `CREATE INDEX IF NOT EXISTS "${SPA_11264_INDEX_NAME}"`,
    );
    expect(migrationCollapsed).toContain('ON "heartbeat_runs" USING btree ("company_id")');
    expect(migrationCollapsed).toContain(
      `WHERE "liveness_state" IS NULL AND "status" NOT IN ('queued', 'running')`,
    );
    expect(migrationCollapsed).not.toMatch(/\bOR\b/i);

    expect(schema).toContain(`index("${SPA_11264_INDEX_NAME}")`);
    expect(collapseWhitespace(schema)).toContain(
      `companyMissingTerminalLivenessIdx: index("${SPA_11264_INDEX_NAME}") .on(table.companyId) .where(sql\`${'${table.livenessState}'} is null and ${'${table.status}'} not in ('queued', 'running')\`)`,
    );

    const dbh = await startEmbeddedPostgresTestDatabase("pap11264-predicate-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const parsed = await readParsedIndexDefinition(sql, SPA_11264_INDEX_NAME);
    expect(parsed).not.toBeNull();
    expect(parsed?.indexdef).not.toBeNull();
    const indexdefCollapsed = collapseWhitespace(parsed?.indexdef ?? "");
    expect(indexdefCollapsed).toContain(`CREATE INDEX ${SPA_11264_INDEX_NAME}`);
    expect(indexdefCollapsed).toContain("USING btree (company_id)");
    expect(indexdefCollapsed).toContain("ON public.heartbeat_runs");
    expect(parsed?.predicate).toBe(
      "((liveness_state IS NULL) AND (status <> ALL (ARRAY['queued'::text, 'running'::text])))",
    );

    const names = (await readHeartbeatRunIndexes(sql)).map((row) => row.indexname);
    expect(names.filter((name) => name === SPA_11264_INDEX_NAME)).toHaveLength(1);
  });

  it("indexes exactly the missing-terminal rows and excludes queued, running and already-stamped rows", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap11264-eligibility-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const companyId = "00000000-0000-0000-0000-0000000000aa";
    const agentId = "00000000-0000-0000-0000-0000000000ab";
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}::uuid, 'SPA-11264', 'SP64')`;
    await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}::uuid, ${companyId}::uuid, 'SPA-11264 agent', 'engineer', 'process')`;

    const statuses = [
      "queued", "running", "scheduled_retry", "succeeded",
      "failed", "cancelled", "timed_out", "interrupted",
    ] as const;
    const rows = statuses.map((status) => ({
      id: crypto.randomUUID(),
      companyId,
      agentId,
      status,
      livenessState: null as string | null,
    }));
    const stamped = {
      id: crypto.randomUUID(),
      companyId,
      agentId,
      status: "succeeded" as const,
      livenessState: "advanced" as const,
    };
    for (const row of [...rows, stamped]) {
      await sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status, liveness_state, created_at, updated_at)
        VALUES (${row.id}::uuid, ${companyId}::uuid, ${agentId}::uuid, ${row.status}, ${row.livenessState}, NOW(), NOW())
      `;
    }

    const expectedEligible = rows.filter(
      (row) => row.status !== "queued" && row.status !== "running",
    ).length;
    expect(expectedEligible).toBe(6);

    const parsed = await readParsedIndexDefinition(sql, SPA_11264_INDEX_NAME);
    expect(parsed?.predicate).not.toBeNull();
    const cataloguePredicate = parsed?.predicate ?? "";

    const selectedByIndexPredicate = (await sql.unsafe(
      `SELECT status::text AS status, liveness_state
       FROM heartbeat_runs
       WHERE company_id = $1 AND (${cataloguePredicate})
       ORDER BY status`,
      [companyId],
    )) as unknown as Array<{ status: string; liveness_state: string | null }>;

    expect(selectedByIndexPredicate.map((row) => row.status)).toEqual([
      "cancelled",
      "failed",
      "interrupted",
      "scheduled_retry",
      "succeeded",
      "timed_out",
    ]);
    expect(selectedByIndexPredicate.every((row) => row.liveness_state === null)).toBe(true);
    expect(selectedByIndexPredicate).toHaveLength(expectedEligible);

    const productionPredicate = (await sql.unsafe(
      `SELECT status::text AS status, liveness_state
       FROM heartbeat_runs
       WHERE company_id = $1 AND liveness_state IS NULL AND status NOT IN ('queued','running')
       ORDER BY status`,
      [companyId],
    )) as unknown as Array<{ status: string; liveness_state: string | null }>;
    expect(selectedByIndexPredicate).toEqual(productionPredicate);

    await sql.unsafe("SET enable_seqscan = off");
    const planText = (
      await sql.unsafe(
        `EXPLAIN SELECT id FROM heartbeat_runs
         WHERE company_id = '${companyId}'
           AND liveness_state IS NULL
           AND status NOT IN ('queued','running')
         LIMIT 20`,
      )
    )
      .map((row) => Object.values(row)[0])
      .join("\n");
    expect(planText).toContain(SPA_11264_INDEX_NAME);

    const total = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM heartbeat_runs WHERE company_id = $1`,
      [companyId],
    )) as unknown as Array<{ n: number }>;
    expect(total[0]?.n).toBe(rows.length + 1);
    const excluded = (await sql.unsafe(
      `SELECT status::text AS status FROM heartbeat_runs
       WHERE company_id = $1 AND status IN ('queued','running')`,
      [companyId],
    )) as unknown as Array<{ status: string }>;
    expect([...excluded.map((row) => row.status)].sort()).toEqual(["queued", "running"]);
  });

  it("preserves the frozen SPA-10699 index name and definition across the migration chain", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap11264-pcissue-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const seedStatement =
      `CREATE INDEX IF NOT EXISTS "${SPA_10699_FROZEN_INDEX_NAME}" ON "heartbeat_runs" USING btree ("company_id", ("context_snapshot" ->> 'issueId'))`;
    await sql.unsafe(seedStatement);
    const seededDefinition = await readIndexDefinition(sql, SPA_10699_FROZEN_INDEX_NAME);
    expect(seededDefinition).not.toBeNull();

    const migration = await readMigration(SPA_11264_MIGRATION_FILE);
    for (const statement of migration
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      await sql.unsafe(statement);
    }

    const afterDefinition = await readIndexDefinition(sql, SPA_10699_FROZEN_INDEX_NAME);
    expect(afterDefinition).toBe(seededDefinition);

    const names = (await readHeartbeatRunIndexes(sql)).map((row) => row.indexname);
    expect(names).toContain(SPA_10699_FROZEN_INDEX_NAME);
    expect(names).toContain(SPA_11264_INDEX_NAME);

    const newDefinition = collapseWhitespace(
      (await readIndexDefinition(sql, SPA_11264_INDEX_NAME)) ?? "",
    );
    expect(newDefinition).toContain("(liveness_state IS NULL)");
  });

  it("keeps PR #158 free of any statement that could rename or drop the frozen SPA-10699 index", async () => {
    const migrationFiles = await readMigrationFiles();
    const spa11264Migration = await readMigration(SPA_11264_MIGRATION_FILE);

    expect(spa11264Migration).not.toContain(SPA_10699_FROZEN_INDEX_NAME);
    expect(spa11264Migration.toUpperCase()).not.toMatch(/\bDROP\s+INDEX\b/);
    expect(spa11264Migration.toUpperCase()).not.toMatch(/\bALTER\s+INDEX\b/);
    expect(spa11264Migration.toUpperCase()).not.toMatch(/\bRENAME\b/);

    const fragment = "heartbeat_runs_company_ctx_pcissue";
    const offenders: string[] = [];
    for (const file of migrationFiles) {
      const sqlText = (await readMigration(file)).toUpperCase();
      const dropsIndexes = /\bDROP\s+INDEX\b/.test(sqlText);
      if (!dropsIndexes) continue;
      if (sqlText.includes(fragment.toUpperCase())) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});