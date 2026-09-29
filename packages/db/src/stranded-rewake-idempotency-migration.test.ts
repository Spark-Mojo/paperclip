import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb } from "./index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const EXHAUSTED_INDEX = "agent_wakeup_requests_exhausted_retry_rewake_idempotency_uq";
const ORPHANED_INDEX = "agent_wakeup_requests_orphaned_retry_rewake_idempotency_uq";

type DuplicateKeyError = {
  code?: string;
  constraint?: string;
  constraint_name?: string;
  cause?: { code?: string; constraint?: string; constraint_name?: string };
};

function readUniqueViolation(error: unknown) {
  const wrapped = error as DuplicateKeyError | null;
  return {
    code: wrapped?.code ?? wrapped?.cause?.code ?? null,
    constraint:
      wrapped?.constraint ??
      wrapped?.constraint_name ??
      wrapped?.cause?.constraint ??
      wrapped?.cause?.constraint_name ??
      null,
  };
}

const migrationSql = await readFile(
  fileURLToPath(new URL("./migrations/0283_stranded_rewake_idempotency.sql", import.meta.url)),
  "utf8",
);

describe("SPA-9351 stranded re-wake idempotency migration", () => {
  it("creates both partial unique indexes", () => {
    expect(migrationSql).toContain(`CREATE UNIQUE INDEX "${EXHAUSTED_INDEX}"`);
    expect(migrationSql).toContain(`CREATE UNIQUE INDEX "${ORPHANED_INDEX}"`);
  });

  it("scopes each index on company and issue, both encoded in the key", () => {
    expect(migrationSql).toContain("exhausted_retry_rewake:%");
    expect(migrationSql).toContain("orphaned_retry_rewake:%");
    for (const index of [EXHAUSTED_INDEX, ORPHANED_INDEX]) {
      const statement = migrationSql
        .split("\n")
        .find((line) => line.includes(`CREATE UNIQUE INDEX "${index}"`))!;
      expect(statement).toContain('"company_id","idempotency_key"');
    }
  });

  it("nulls duplicate historical keys rather than deleting the rows", () => {
    expect(migrationSql).toContain('UPDATE "agent_wakeup_requests"');
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\s+agent_wakeup_requests\b/i);
    expect(migrationSql).toContain("row_number() OVER");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("SPA-9351 stranded re-wake idempotency indexes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-9351-idx-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  let companySeq = 0;

  async function insertCompany(companyId: string) {
    companySeq += 1;
    await db
      .insert(companies)
      .values({
        id: companyId,
        name: `co-${companyId.slice(0, 4)}`,
        issuePrefix: `P${companySeq}${companyId.slice(0, 2)}`,
        requireBoardApprovalForNewAgents: false,
      })
      .onConflictDoNothing();
  }

  async function insertAgent(agentId: string, companyId: string) {
    await db
      .insert(agents)
      .values({
        id: agentId,
        companyId,
        name: `agent-${agentId.slice(0, 4)}`,
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .onConflictDoNothing();
  }

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(companyId: string, agentId: string) {
    await insertCompany(companyId);
    await insertAgent(agentId, companyId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: "issue_exhausted_retry_rewake",
      status: "queued",
      idempotencyKey: `exhausted_retry_rewake:${companyId}:issue-1:run-1:rewake`,
      payload: {},
    });
  }

  it("rejects a second exhausted-retry wake for the same episode", async () => {
    const companyId = "0a0a0a0a-0a0a-40a0-80a0-0a0a0a0a0a0a";
    const agentId = "0b0b0b0b-0b0b-40b0-80b0-0b0b0b0b0b0b";
    await seed(companyId, agentId);

    const conflict = await db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId,
        source: "automation",
        reason: "issue_exhausted_retry_rewake",
        status: "queued",
        idempotencyKey: `exhausted_retry_rewake:${companyId}:issue-1:run-1:rewake`,
        payload: {},
      })
      .then(() => null)
      .catch((error: unknown) => error as DuplicateKeyError);
    expect(readUniqueViolation(conflict)).toEqual({ code: "23505", constraint: EXHAUSTED_INDEX });
  });

  it("rejects a second orphaned-retry redispatch for the same episode", async () => {
    const companyId = "0c0c0c0c-0c0c-40c0-80c0-0c0c0c0c0c0c";
    const agentId = "0d0d0d0d-0d0d-40d0-80d0-0d0d0d0d0d0d";
    await insertCompany(companyId);
    await insertAgent(agentId, companyId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: "issue_orphaned_retry_redispatch",
      status: "queued",
      idempotencyKey: `orphaned_retry_rewake:${companyId}:issue-2:run-2:redispatch`,
      payload: {},
    });

    const conflict = await db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId,
        source: "automation",
        reason: "issue_orphaned_retry_redispatch",
        status: "queued",
        idempotencyKey: `orphaned_retry_rewake:${companyId}:issue-2:run-2:redispatch`,
        payload: {},
      })
      .then(() => null)
      .catch((error: unknown) => error as DuplicateKeyError);
    expect(readUniqueViolation(conflict)).toEqual({ code: "23505", constraint: ORPHANED_INDEX });
  });

  it("leaves other issues and companies free", async () => {
    const companyA = "0e0e0e0e-0e0e-40e0-80e0-0e0e0e0e0e0e";
    const companyB = "0f0f0f0f-0f0f-40f0-80f0-0f0f0f0f0f0f";
    const agentA = "10101010-1010-4010-8010-101010101010";
    for (const companyId of [companyA, companyB]) await insertCompany(companyId);
    await insertAgent(agentA, companyA);

    await db.insert(agentWakeupRequests).values([
      {
        companyId: companyA,
        agentId: agentA,
        source: "automation",
        reason: "issue_exhausted_retry_rewake",
        status: "queued",
        idempotencyKey: `exhausted_retry_rewake:${companyA}:issue-1:run-1:rewake`,
        payload: {},
      },
      {
        companyId: companyA,
        agentId: agentA,
        source: "automation",
        reason: "issue_exhausted_retry_rewake",
        status: "queued",
        idempotencyKey: `exhausted_retry_rewake:${companyA}:issue-2:run-2:rewake`,
        payload: {},
      },
      {
        companyId: companyB,
        agentId: agentA,
        source: "automation",
        reason: "issue_exhausted_retry_rewake",
        status: "queued",
        idempotencyKey: `exhausted_retry_rewake:${companyB}:issue-1:run-1:rewake`,
        payload: {},
      },
    ]);
  });

  it("retains the earliest receipt and nulls the redundant historical keys", async () => {
    await db.execute(sql`drop index if exists "agent_wakeup_requests_exhausted_retry_rewake_idempotency_uq"`);
    await db.execute(sql`drop index if exists "agent_wakeup_requests_orphaned_retry_rewake_idempotency_uq"`);

    const companyId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    await insertCompany(companyId);
    await insertAgent(agentId, companyId);
    const key = `exhausted_retry_rewake:${companyId}:issue-9:run-9:rewake`;

    const base = new Date("2026-09-01T00:00:00.000Z");
    await db.insert(agentWakeupRequests).values([
      { companyId, agentId, source: "automation", reason: "r", status: "failed", idempotencyKey: key, payload: { n: 1 }, requestedAt: base },
      { companyId, agentId, source: "automation", reason: "r", status: "queued", idempotencyKey: key, payload: { n: 2 }, requestedAt: new Date(base.getTime() + 60_000) },
      { companyId, agentId, source: "automation", reason: "r", status: "skipped", idempotencyKey: key, payload: { n: 3 }, requestedAt: new Date(base.getTime() + 120_000) },
    ]);

    await db.execute(
      sql.raw(
        migrationSql
          .split("--> statement-breakpoint")[0]!
          .replace(/\s+/g, " ")
          .trim(),
      ),
    );

    const rows = await db
      .select({
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        payload: agentWakeupRequests.payload,
        requestedAt: agentWakeupRequests.requestedAt,
      })
      .from(agentWakeupRequests)
      .orderBy(agentWakeupRequests.requestedAt);

    expect(rows).toHaveLength(3);
    expect(rows[0]!.idempotencyKey).toBe(key);
    expect(rows[1]!.idempotencyKey).toBeNull();
    expect(rows[2]!.idempotencyKey).toBeNull();
    expect(rows.map((row) => (row.payload as { n: number }).n)).toEqual([1, 2, 3]);

    await db.execute(
      sql`CREATE UNIQUE INDEX "agent_wakeup_requests_exhausted_retry_rewake_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'exhausted_retry_rewake:%'`,
    );
    await db.execute(
      sql`CREATE UNIQUE INDEX "agent_wakeup_requests_orphaned_retry_rewake_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'orphaned_retry_rewake:%'`,
    );
    const indexes = await db
      .select({ indexName: sql<string>`indexname` })
      .from(sql`pg_indexes`)
      .where(
        sql`tablename = 'agent_wakeup_requests' and indexname like '%retry_rewake%'`,
      );
    expect([...indexes].sort((a, b) => a.indexName.localeCompare(b.indexName)).map((row) => row.indexName)).toEqual([
      EXHAUSTED_INDEX,
      ORPHANED_INDEX,
    ]);
  });
});
