import { readFile } from "node:fs/promises";
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

const SPA_11865_INDEX_NAME = "heartbeat_runs_company_agent_created_ctx_ids_idx";
const SPA_11865_ISSUE_ID_COL = "context_issue_id";
const SPA_11865_TASK_ID_COL = "context_task_id";
const SPA_11865_MIGRATION_FILE = "9284_heartbeat_context_snapshot_id_columns.sql";
const SPA_11865_JOURNAL_TAG = "9284_heartbeat_context_snapshot_id_columns";
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));
const JOURNAL_PATH = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("./schema/heartbeat_runs.ts", import.meta.url));

type ColumnRow = { column_name: string; data_type: string; is_generated: string; generation_expression: string | null };

type IndexDefRow = { indexdef: string };

type PgIndexRow = {
  indexrelid: string;
  indkey: string;
  indnatts: number;
  indnkeyatts: number;
  indexprs: string | null;
  indisready: boolean;
};

async function readColumn(sql: postgres.Sql, columnName: string): Promise<ColumnRow | null> {
  const rows = (await sql.unsafe(
    `SELECT column_name, data_type, is_generated, generation_expression
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'heartbeat_runs' AND column_name = $1`,
    [columnName],
  )) as unknown as ColumnRow[];
  return rows[0] ?? null;
}

async function readIndexDefinition(sql: postgres.Sql, indexName: string): Promise<string | null> {
  const rows = (await sql.unsafe(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'heartbeat_runs' AND indexname = $1`,
    [indexName],
  )) as unknown as IndexDefRow[];
  return rows[0]?.indexdef ?? null;
}

async function readJournalTag(): Promise<{ idx: number; tag: string; when: number } | null> {
  const journal = JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const found = journal.entries.find((entry) => entry.tag === SPA_11865_JOURNAL_TAG);
  return found ?? null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

d("SPA-11865 heartbeat context_snapshot id columns migration", () => {
  it("applies the migration and lands the new generated columns + covering index", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap11865-mig-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const issueColumn = await readColumn(sql, SPA_11865_ISSUE_ID_COL);
    expect(issueColumn).not.toBeNull();
    expect(issueColumn?.data_type).toBe("text");
    expect(issueColumn?.is_generated).toBe("ALWAYS");
    // PG 17 information_schema.columns.generation_expression renders the
    // expression verbatim as we wrote it in the migration (single parens).
    // Older dumps / wrappers sometimes add a redundant outer pair; accept
    // either form rather than over-couple to a PG version detail.
    expect(collapseWhitespace(issueColumn?.generation_expression ?? "")).toMatch(
      /^\(?\(?context_snapshot\)?\s*->>\s*'issueId'::text\)?$/,
    );

    const taskColumn = await readColumn(sql, SPA_11865_TASK_ID_COL);
    expect(taskColumn).not.toBeNull();
    expect(taskColumn?.data_type).toBe("text");
    expect(taskColumn?.is_generated).toBe("ALWAYS");
    expect(collapseWhitespace(taskColumn?.generation_expression ?? "")).toMatch(
      /^\(?\(?context_snapshot\)?\s*->>\s*'taskId'::text\)?$/,
    );

    const indexDef = await readIndexDefinition(sql, SPA_11865_INDEX_NAME);
    expect(indexDef).not.toBeNull();
    const collapsed = collapseWhitespace(indexDef ?? "");
    expect(collapsed).toBe(
      `CREATE INDEX ${SPA_11865_INDEX_NAME} ON public.heartbeat_runs USING btree (company_id, agent_id, created_at) INCLUDE (context_issue_id, context_task_id)`,
    );
  }, 240_000);

  it("populates the generated columns and lands an INCLUDE btree that supports an Index Only Scan for the failed-run attention feed's projection", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap11865-explain-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const companyId = "00000000-0000-0000-0000-0000000000c1";
    const c1Agent = "00000000-0000-0000-0000-0000000000c2";
    const c1Agent2 = "00000000-0000-0000-0000-0000000000c3";
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}::uuid, 'SPA-11865', 'SP65')`;
    await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${c1Agent}::uuid, ${companyId}::uuid, 'SPA-11865 A', 'engineer', 'process')`;
    await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${c1Agent2}::uuid, ${companyId}::uuid, 'SPA-11865 B', 'engineer', 'process')`;

    // Seed an "old" run that the failed-run feed uses as the watermark,
    // then a few "newer" runs whose context_snapshot is the kind of 70 KB
    // blob that de-TOASTs under the old query.
    const oldRunId = crypto.randomUUID();
    await sql`
      INSERT INTO heartbeat_runs (
        id, company_id, agent_id, status, context_snapshot, created_at, updated_at
      ) VALUES (
        ${oldRunId}::uuid, ${companyId}::uuid, ${c1Agent}::uuid, 'failed',
        ${sql.json({ issueId: "old-issue" })}::jsonb, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour'
      )
    `;

    const bigSnapshot = (issueId: string) => ({
      issueId,
      taskId: `task-${issueId}`,
      payload: Array.from({ length: 1200 }, (_, i) => `x-${i}-${"filler-filler-filler-filler-filler"}`).join("|"),
    });

    for (let i = 0; i < 30; i += 1) {
      await sql`
        INSERT INTO heartbeat_runs (
          id, company_id, agent_id, status, context_snapshot, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid, ${companyId}::uuid, ${c1Agent}::uuid, 'running',
          ${sql.json(bigSnapshot(`newer-${i}`))}::jsonb, NOW() - INTERVAL '30 minutes', NOW()
        )
      `;
    }

    // The generated columns materialised the JSONB keys on the existing rows.
    const seedCheck = await sql.unsafe(
      `SELECT context_issue_id, context_task_id
       FROM heartbeat_runs
       WHERE id = $1`,
      [oldRunId],
    ) as unknown as Array<{ context_issue_id: string | null; context_task_id: string | null }>;
    expect(seedCheck[0]?.context_issue_id).toBe("old-issue");
    expect(seedCheck[0]?.context_task_id).toBeNull();

    // STRUCTURAL: pg_index tells us the new index has 5 columns: 3 keys
    // (company_id, agent_id, created_at) and 2 INCLUDE columns
    // (context_issue_id, context_task_id). With INCLUDE columns the leaf
    // pages carry their values, so the IOScan path can answer the failed-
    // run feed's projection (agent_id, created_at, context_issue_id,
    // context_task_id) without a heap visit. We assert this directly
    // rather than via EXPLAIN — the planner's choice on a 30-row fixture
    // is data-driven and unstable, but the index's structure is the
    // contract the fix delivers, and the structure proves IOScan works.
    const pgIndexRows = await sql.unsafe<PgIndexRow[]>(
      `SELECT
         c.relname AS indexrelid,
         i.indkey::text AS indkey,
         i.indnatts,
         i.indnkeyatts,
         i.indexprs::text AS indexprs,
         i.indisready
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = $1`,
      [SPA_11865_INDEX_NAME],
    );
    expect(pgIndexRows).toHaveLength(1);
    const idx = pgIndexRows[0];
    expect(idx.indisready).toBe(true);
    // indkey lists key columns by pg_attribute.attnum position (1-based).
    // heartbeat_runs schema: id=1, company_id=2, agent_id=3, ...,
    // created_at is somewhere late in the column list. We assert indkey
    // starts with company_id (attnum 2) and agent_id (attnum 3), and
    // indnkeyatts = 3 (3 key columns). The INCLUDE columns live past
    // indnkeyatts in the leaf pages, so IOScan can serve them.
    expect(idx.indnatts).toBeGreaterThanOrEqual(5);
    expect(idx.indnkeyatts).toBe(3);
    const keyParts = (idx.indkey ?? "").split(" ").filter(Boolean);
    expect(keyParts[0]).toBe("2"); // company_id
    expect(keyParts[1]).toBe("3"); // agent_id
    expect(Number(keyParts[2])).toBeGreaterThan(0); // created_at attnum
    // INCLUDE columns live past indnkeyatts in the index's leaf pages —
    // 5 columns total (3 keys + 2 INCLUDE) so the projection columns exist
    // in the leaf and IOScan can answer the failed-run feed's query
    // without a heap visit.
    expect(keyParts.length).toBe(5);
    expect(idx.indnkeyatts).toBe(3);
    expect(idx.indnatts - idx.indnkeyatts).toBe(2);
    // no indexprs (no expression keys) — keys are all column refs.
    expect(idx.indexprs).toBeNull();

    // Cross-check the INCLUDE columns are the two generated text columns.
    const includeColumns = await sql.unsafe<{ attname: string; attnum: number }[]>(
      `SELECT attname, attnum FROM pg_attribute
       WHERE attrelid = 'heartbeat_runs'::regclass
         AND attnum = ANY($1::smallint[])
         AND NOT attisdropped
       ORDER BY attnum`,
      [keyParts.slice(-2).map(Number)],
    );
    expect(includeColumns.map((r) => r.attname).sort()).toEqual([
      "context_issue_id",
      "context_task_id",
    ]);
  }, 240_000);

  it("EXPLAIN ANALYZE of the failed-run attention feed's exact query shows the new covering btree with Heap Fetches: 0", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap11865-explain-buffers-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const companyId = "00000000-0000-0000-0000-0000000000c1";
    const c1Agent = "00000000-0000-0000-0000-0000000000c2";
    const c1Agent2 = "00000000-0000-0000-0000-0000000000c3";
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}::uuid, 'SPA-11865', 'SP65')`;
    await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${c1Agent}::uuid, ${companyId}::uuid, 'SPA-11865 A', 'engineer', 'process')`;
    await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${c1Agent2}::uuid, ${companyId}::uuid, 'SPA-11865 B', 'engineer', 'process')`;

    const bigSnapshot = (issueId: string) => ({
      issueId,
      taskId: `task-${issueId}`,
      payload: Array.from({ length: 1200 }, (_, i) => `x-${i}-${"filler-filler-filler-filler-filler"}`).join("|"),
    });

    // Seed a few rows so the planner has data to cost. We do NOT need to
    // reproduce production volume here: production volume exists so the
    // planner sees the heap-touch cost. We isolate that path below by
    // disabling bitmap and seq plans, which forces the planner to choose
    // between heap-touching index plans and the only no-heap option, our
    // covering index. Any index that can serve the projection without a
    // heap visit wins — and our new btree is the ONLY one whose leaf
    // pages carry context_issue_id/context_task_id as INCLUDE cols.
    const noiseAgents = Array.from({ length: 18 }, (_, i) =>
      `00000000-0000-0000-0000-0000000000${(i + 10).toString(16).padStart(2, "0")}`,
    );
    for (const agentId of noiseAgents) {
      await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}::uuid, ${companyId}::uuid, ${`N-${agentId.slice(-4)}`}, 'engineer', 'process')`;
    }
    const allAgents = [c1Agent, c1Agent2, ...noiseAgents];
    for (let i = 0; i < 500; i += 1) {
      const agent = allAgents[i % allAgents.length];
      const ageMinutes = (i % 90) + 1;
      const status = i % 3 === 0 ? "running" : (i % 3 === 1 ? "queued" : "failed");
      await sql`
        INSERT INTO heartbeat_runs (
          id, company_id, agent_id, status, context_snapshot, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid, ${companyId}::uuid, ${agent}::uuid, ${status},
          ${sql.json(bigSnapshot(`run-${i}`))}::jsonb,
          NOW() - (${ageMinutes}::int * INTERVAL '1 minute'),
          NOW()
        )
      `;
    }

    // Force stats so the planner has real cost data.
    await sql.unsafe("ANALYZE heartbeat_runs");
    // After ANALYZE, run a sentinel VACUUM so the visibility map marks our
    // freshly-inserted rows as all-visible. Without this, IOScan cannot
    // answer without re-checking the heap (PG refuses IOScan unless the
    // visibility map says the heap pages are all-visible). On a real
    // cluster the autovacuum daemon does this; here we trigger it
    // explicitly because embedded PG has no autovacuum worker.
    await sql.unsafe("VACUUM heartbeat_runs");
    // Planner isolation: disable bitmap scans and seq scans so the planner
    // must choose between heap-touching index plans and the only no-heap
    // option — our covering index. We are NOT pinning the new index: any
    // index that can serve the projection without a heap visit wins, and
    // our index is the only btree whose leaf pages carry
    // context_issue_id/context_task_id as INCLUDE columns.
    await sql.unsafe("SET enable_bitmapscan = off");
    await sql.unsafe("SET enable_seqscan = off");
    // The failed-run feed's exact query, with the projection from the new
    // covering btree. EXPLAIN ANALYZE BUFFERS gives us Heap Fetches on
    // Index Only Scan plans — that is the field that proves IOScan
    // answered the projection without a heap visit.
    const planRows = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT agent_id, created_at, context_issue_id, context_task_id
       FROM heartbeat_runs
       WHERE company_id = $1 AND agent_id IN ($2, $3) AND created_at > NOW() - INTERVAL '60 minutes'`,
      [companyId, c1Agent, c1Agent2],
    );
    const planText = (planRows as Array<Record<string, unknown>>)
      .map((row) => Object.values(row)[0])
      .join("\n");

    // The covering btree is the only index that can serve this projection
    // without a heap visit. Either the planner picks it (Index Only Scan,
    // Heap Fetches: 0), or it picks a smaller index (Heap Fetches > 0),
    // which would re-trigger the de-TOAST the fix is built to eliminate.
    // We assert the WIN: Index Only Scan on the new btree, Heap Fetches: 0.
    expect(planText).toContain(SPA_11865_INDEX_NAME);
    expect(planText).toMatch(/Index Only Scan/);
    // Heap Fetches: N where N > 0 — fail closed on any non-zero count.
    expect(planText).not.toMatch(/Heap Fetches:\s*[1-9]\d*/);
  }, 240_000);

  it("declares the generated columns in the drizzle schema with the same GENERATED expression", async () => {
    const schema = await readFile(SCHEMA_PATH, "utf8");
    expect(schema).toContain(`text("${SPA_11865_ISSUE_ID_COL}")`);
    expect(schema).toContain(`text("${SPA_11865_TASK_ID_COL}")`);
    expect(schema).toContain(".generatedAlwaysAs(");
    expect(schema).toContain(
      `(): SQL => sql\`\${heartbeatRuns.contextSnapshot} ->> 'issueId'\``,
    );
    expect(schema).toContain(
      `(): SQL => sql\`\${heartbeatRuns.contextSnapshot} ->> 'taskId'\``,
    );
  });

  it("registers the migration in the journal exactly once and in slot 9284", async () => {
    const journal = JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const matches = journal.entries.filter((entry) => entry.tag === SPA_11865_JOURNAL_TAG);
    expect(matches).toHaveLength(1);
    expect(matches[0].tag).toBe(SPA_11865_JOURNAL_TAG);
    expect(matches[0].idx).toBe(9284);
    expect(matches[0].when).toBeGreaterThan(1790649901603);

    const journalTag = await readJournalTag();
    expect(journalTag?.idx).toBe(9284);

    const fileNames = (await import("node:fs/promises")).readdir;
    const listed = await fileNames(MIGRATIONS_DIR);
    expect(listed).toContain(SPA_11865_MIGRATION_FILE);
  });

  it("is idempotent on re-run (no-op second apply)", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap11865-idem-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const migrationSql = await readFile(
      fileURLToPath(new URL(`./migrations/${SPA_11865_MIGRATION_FILE}`, import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // ALTER TABLE ... ADD COLUMN with a name that already exists would fail;
    // we expect Postgres to accept every statement here because the
    // generated columns and the IF NOT EXISTS index are already in place
    // from the cluster's pending-migrations apply.
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  }, 240_000);
});