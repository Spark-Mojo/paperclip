import { strictEqual, ok } from "node:assert";
import { describe, expect, it } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import { fileURLToPath } from "node:url";

// Card SPA-11886 acceptance item 1: after migration 9285, the
// agent_wakeup_requests_company_agent_issue_created_idx index exists in
// pg_indexes (proven in fresh embedded postgres), and the planner does not
// regress to a Seq Scan on the dedup/hourly probe queries. The migration
// must be additive: the pre-existing agent_wakeup_requests_company_payload_issue_idx
// index must remain present.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDir = path.join(repoRoot, "packages/db/src/migrations");
const newIndexName = "agent_wakeup_requests_company_agent_issue_created_idx";
const oldIndexName = "agent_wakeup_requests_company_payload_issue_idx";

async function listMigrations(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
}

async function applyMigrations(sql: postgres.Sql, onlyUpTo: string | null) {
  const files = await listMigrations();
  for (const f of files) {
    if (onlyUpTo && f > onlyUpTo) break;
    const body = await readFile(path.join(migrationsDir, f), "utf8");
    const stripped = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    await sql.unsafe(stripped);
  }
}

async function spinUp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pg-wakeloop-"));
  const port = 25432 + Math.floor(Math.random() * 1000);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  return {
    pg,
    dir,
    connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
  };
}

async function populateFixtures(sql: postgres.Sql, n: number) {
  await sql.unsafe(`
    INSERT INTO companies (id, name, issue_prefix, issue_counter, created_at, updated_at)
    SELECT
      ('00000000-0000-4000-8000-' || lpad(to_hex(i::int), 12, '0'))::uuid,
      'Company ' || i,
      'TEST' || lpad(i::text, 2, '0'),
      0,
      now(),
      now()
    FROM generate_series(1, 5) i
  `);
  await sql.unsafe(`
    INSERT INTO agents (id, company_id, name, adapter_type, status, created_at, updated_at)
    SELECT
      ('00000000-0000-4000-8000-' || lpad(to_hex(i::int), 12, '0'))::uuid,
      ('00000000-0000-4000-8000-' || lpad(to_hex((i % 5 + 1)::int), 12, '0'))::uuid,
      'Agent ' || i,
      'process',
      'active',
      now(),
      now()
    FROM generate_series(1, 50) i
  `);
  await sql.unsafe(`
    INSERT INTO agent_wakeup_requests (company_id, agent_id, source, payload, created_at)
    SELECT
      ('00000000-0000-4000-8000-' || lpad(to_hex(((i % 5) + 1)::int), 12, '0'))::uuid,
      ('00000000-0000-4000-8000-' || lpad(to_hex(((i % 50) + 1)::int), 12, '0'))::uuid,
      'test-fixture',
      jsonb_build_object('issueId', 'is-' || (i % 100)),
      now() - (i * interval '1 second')
    FROM generate_series(1, ${n}) i
  `);
}

async function runProbeAndCapture(sql: postgres.Sql): Promise<string[]> {
  const plan: string[] = [];
  const dedup = await sql.unsafe(
    "EXPLAIN ANALYZE SELECT count(*) FROM agent_wakeup_requests WHERE company_id = $1 AND agent_id = $2 AND (payload->>'issueId') = $3 AND created_at > now() - interval '60 seconds'",
    ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001", "is-5"],
  );
  for (const r of dedup) plan.push(r["QUERY PLAN"] ?? Object.values(r)[0]);
  return plan;
}

describe("SPA-11886 wake-loop guard index migration", { timeout: 120_000 }, () => {
  it("applying 9285 creates the composite index and the pre-existing payload-issue index remains", async () => {
    const { pg, dir, connectionString } = await spinUp();
    const sql = postgres(connectionString);
    try {
      await applyMigrations(sql, null);
      const rows = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE indexname IN (${newIndexName}, ${oldIndexName}) ORDER BY indexname
      `;
      const names = rows.map((r) => r.indexname);
      ok(names.includes(newIndexName), `pg_indexes must include ${newIndexName} after applying 9285; got ${JSON.stringify(names)}`);
      ok(names.includes(oldIndexName), `pg_indexes must still include ${oldIndexName} (migration is additive, not replacing); got ${JSON.stringify(names)}`);
    } finally {
      await sql.end();
      await pg.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("applying through 9284 (without 9285) does NOT create the composite index", async () => {
    const { pg, dir, connectionString } = await spinUp();
    const sql = postgres(connectionString);
    try {
      await applyMigrations(sql, "9284_heartbeat_context_snapshot_id_columns.sql");
      const rows = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE indexname = ${newIndexName}
      `;
      strictEqual(rows.length, 0, "composite index must not exist before 9285; got " + JSON.stringify(rows));
    } finally {
      await sql.end();
      await pg.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("EXPLAIN ANALYZE of the dedup probe uses an Index Scan (no Seq Scan regression)", async () => {
    const { pg, dir, connectionString } = await spinUp();
    const sql = postgres(connectionString);
    try {
      await applyMigrations(sql, null);
      await populateFixtures(sql, 5000);
      const plan = await runProbeAndCapture(sql);
      const planText = plan.join("\n");
      expect(planText, "planner must not fall back to Seq Scan").not.toMatch(/Seq Scan on agent_wakeup_requests/);
      expect(planText, "planner must use one of the two agent_wakeup_requests indexes").toMatch(/Index Scan using agent_wakeup_requests_(company_payload_issue_idx|company_agent_issue_created_idx)/);
    } finally {
      await sql.end();
      await pg.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});