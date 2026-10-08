import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as dbSchema from "@paperclipai/db";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type RawClient = {
  unsafe(query: string, params?: unknown[]): PromiseLike<Array<Record<string, unknown>>>;
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<Array<Record<string, unknown>>>;
};

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function rawClientOf(database: Db): RawClient {
  const client = (database as unknown as { $client?: RawClient }).$client;
  if (!client || typeof client.unsafe !== "function") {
    throw new Error("createDb did not expose a postgres.js client on $client");
  }
  return client;
}

function issuePredicateSpan(statement: string): [number, number] {
  const compare = statement.match(/"context_snapshot"->>'issueId' = \$\d+/);
  if (!compare || compare.index === undefined) throw new Error(`no issue arm in: ${statement}`);
  const end = compare.index + compare[0].length;
  let depth = 0;
  let start = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    const character = statement[index];
    if (character === ")") depth += 1;
    else if (character === "(") {
      if (depth === 0) {
        start = index;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) throw new Error(`no enclosing group in: ${statement}`);
  let close = -1;
  depth = 0;
  for (let index = start; index < statement.length; index += 1) {
    const character = statement[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) throw new Error(`unterminated group in: ${statement}`);
  return [start, close + 1];
}

function withOriginalIssuePredicate(statement: string, params: unknown[]): [string, unknown[]] {
  const [start, end] = issuePredicateSpan(statement);
  const predicate = statement.slice(start, end);
  const textBind = predicate.match(/->>'issueId' = \$(\d+)/);
  if (!textBind) throw new Error(`no text arm bind in: ${predicate}`);
  const original = `${statement.slice(0, start)}coalesce("heartbeat_runs"."native_issue_id"::text, "heartbeat_runs"."context_snapshot"->>'issueId') = $${textBind[1]}${statement.slice(end)}`;
  const mapping = new Map<number, number>();
  const rebinds: string[] = [];
  const renumbered = original.replace(/\$(\d+)/g, (_, digits: string) => {
    const previous = Number(digits);
    let next = mapping.get(previous);
    if (next === undefined) {
      next = mapping.size + 1;
      mapping.set(previous, next);
    }
    return `$${next}`;
  });
  for (const previous of mapping.keys()) {
    if (previous < 1 || previous > params.length) {
      throw new Error(`placeholder $${previous} is outside the captured ${params.length} params`);
    }
    rebinds.push(params[previous - 1] as never);
  }
  return [renumbered, rebinds];
}

function ids(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) => String(row.id));
}

describeEmbeddedPostgres("SPA-11264 conversation ownership lookup is index-bounded", () => {
  let db!: ReturnType<typeof createDb>;
  let raw!: RawClient;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let nativeIssueId!: string;
  let contextIssueId!: string;

  function loggingDb() {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const logging = drizzle(raw as never, {
      schema: dbSchema,
      logger: {
        logQuery(query: string, params: unknown[]) {
          queries.push({ sql: query, params });
        },
      },
    });
    return { db: logging as unknown as Db, queries };
  }

  async function captureOwnership(issueId: string) {
    const capture = loggingDb();
    const blocker = await getConversationOwnershipBlocker(capture.db, companyId, issueId);
    expect(capture.queries, issueId).toHaveLength(1);
    return { blocker, sql: collapseWhitespace(capture.queries[0]!.sql), params: capture.queries[0]!.params };
  }

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("spa-11264-ownership-");
    db = createDb(tempDb.connectionString);
    raw = rawClientOf(db as unknown as Db);
    companyId = randomUUID();
    agentId = randomUUID();
    nativeIssueId = randomUUID();
    contextIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "SPA-11264",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ownership agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 180_000);

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  }, 60_000);

  type RunSeed = {
    status?: string;
    nativeIssueId?: string | null;
    contextIssueId?: string | null;
    runtimeMode?: string;
    processPid?: number | null;
    processGroupId?: number | null;
    adapterDispatch?: string | null;
    adapterEvent?: string | null;
    createdAt?: Date;
  };

  async function seedRun(seed: RunSeed): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: seed.status ?? "interrupted",
      runtimeMode: seed.runtimeMode ?? "legacy",
      nativeIssueId: seed.nativeIssueId ?? null,
      contextSnapshot: seed.contextIssueId === null || seed.contextIssueId === undefined
        ? { wakeReason: "issue_assigned" }
        : { issueId: seed.contextIssueId, taskId: seed.contextIssueId },
      runnerProfileJson: seed.adapterDispatch === null
        ? {}
        : { adapterDispatch: { adapterType: seed.adapterDispatch ?? "opencode_local" } },
      processPid: seed.processPid ?? null,
      processGroupId: seed.processGroupId ?? null,
      createdAt: seed.createdAt ?? new Date(),
    });
    if (seed.adapterEvent) {
      await db.insert(heartbeatRunEvents).values({
        companyId,
        agentId,
        runId: id,
        seq: 1,
        eventType: "adapter.invoke",
        payload: { adapterType: seed.adapterEvent },
      });
    }
    return id;
  }

  async function seedLease(runId: string) {
    await db.insert(environmentLeases).values({
      companyId,
      heartbeatRunId: runId,
      status: "active",
    });
  }

  it("selects the same rows in the same order as the original predicate for every issue input shape", async () => {
    const nativeOwnedOlder = await seedRun({
      nativeIssueId,
      contextIssueId: randomUUID(),
      processGroupId: 999_001,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const nativeOwnedNewer = await seedRun({
      nativeIssueId,
      contextIssueId: randomUUID(),
      processPid: 1,
      createdAt: new Date("2026-01-01T00:00:01Z"),
    });
    const contextOwnedOldest = await seedRun({
      contextIssueId,
      processGroupId: 999_002,
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const contextOwnedNewest = await seedRun({
      contextIssueId,
      adapterDispatch: null,
      adapterEvent: "claude_local",
      processPid: 1,
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    const tieLater = await seedRun({
      contextIssueId,
      processPid: 1,
      createdAt: new Date("2026-01-05T00:00:00Z"),
    });
    const tieEarlier = await seedRun({ contextIssueId, createdAt: new Date("2026-01-05T00:00:00Z") });
    await seedLease(tieEarlier);
    const foreignNativeContextMatch = await seedRun({
      nativeIssueId: randomUUID(),
      contextIssueId: nativeIssueId,
      processPid: 1,
    });
    await seedRun({ contextIssueId: randomUUID(), processPid: 1 });
    await seedRun({ contextIssueId, status: "running", processPid: 1 });
    await seedRun({ contextIssueId, status: "succeeded", processPid: 1 });
    await seedRun({ contextIssueId });
    await seedRun({ contextIssueId, runtimeMode: "native", processPid: 1 });
    await seedRun({ contextIssueId: null, nativeIssueId: null, processPid: 1 });
    const releasedLease = await seedRun({ contextIssueId });
    await seedLease(releasedLease);
    await db.update(environmentLeases)
      .set({ releasedAt: new Date(), status: "released" })
      .where(eq(environmentLeases.heartbeatRunId, releasedLease));

    const legacyInputs = [nativeIssueId.toUpperCase(), `${nativeIssueId}\n`, "SPA-1", "", "123", "true"];
    for (const input of legacyInputs) await seedRun({ contextIssueId: input, processPid: process.pid });
    for (const value of [null, 123, true, { nested: "value" }, ["value"]]) {
      const runId = await seedRun({ contextIssueId: null, processPid: process.pid });
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: value } }).where(eq(heartbeatRuns.id, runId));
    }

    for (const input of [
      ...legacyInputs,
      nativeIssueId,
      contextIssueId,
      nativeIssueId.toUpperCase(),
      contextIssueId.toUpperCase(),
      nativeIssueId.replaceAll("-", ""),
      ` ${nativeIssueId}`,
      "SPA-1",
      "",
    ]) {
      const { sql: rewritten, params } = await captureOwnership(input);
      expect(rewritten, `input=${JSON.stringify(input)}`).not.toContain("coalesce");
      const current = ids(await raw.unsafe(rewritten, params));
      const [oracleStatement, oracleParams] = withOriginalIssuePredicate(rewritten, params);
      const original = ids(await raw.unsafe(oracleStatement, oracleParams));
      expect(current, `input=${JSON.stringify(input)}`).toEqual(original);
    }

    const nativeCapture = await captureOwnership(nativeIssueId);
    const nativeIds = ids(await raw.unsafe(nativeCapture.sql, nativeCapture.params));
    expect(nativeIds).toEqual([nativeOwnedNewer, nativeOwnedOlder]);
    expect(nativeIds).not.toContain(contextOwnedNewest);
    expect(nativeIds).not.toContain(foreignNativeContextMatch);

    const contextCapture = await captureOwnership(contextIssueId);
    const contextIds = ids(await raw.unsafe(contextCapture.sql, contextCapture.params));
    expect(contextIds).toEqual([...[tieLater, tieEarlier].sort().reverse(), contextOwnedNewest, contextOwnedOldest]);
    expect(contextIds).not.toContain(nativeOwnedOlder);
    expect(contextIds).not.toContain(foreignNativeContextMatch);
  }, 180_000);

  it("binds the native uuid arm only for canonical lowercase input", async () => {
    const contextArm = /"heartbeat_runs"\."native_issue_id" is null and "heartbeat_runs"\."context_snapshot"->>'issueId' = \$\d+\)/;
    for (const anchored of [
      nativeIssueId,
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "deadbeef-dead-4bee-8fff-deadbeef00dd",
    ]) {
      const { sql: emitted } = await captureOwnership(anchored);
      expect(emitted, anchored).toContain(`"native_issue_id" = $22::uuid`);
      expect(emitted, anchored).toMatch(contextArm);
    }
    for (const unanchored of [
      `${nativeIssueId}\n`,
      "00000000-0000-0000-0000-00000000000A",
      "0000000000000000000000000000000A",
      "{00000000-0000-0000-0000-00000000000a}",
      "urn:uuid:00000000-0000-0000-0000-00000000000a",
      " 00000000-0000-0000-0000-00000000000a",
      "00000000-0000-0000-0000-00000000000a ",
      "00000000_0000_0000_0000_00000000000a",
      "00000000-0000-0000-0000-00000000000ag",
      "00000000-0000-0000-0000-00000000000",
      "00000000-0000-0000-0000-0000000000000",
      "deadbeef-dead-4bee-8fff-deadbeef00d",
      "deadbeef-dead-4bee-8fff-deadbeef00",
      "00000000-0000-0000-0000-00000000000g",
      "issue-00000000-0000-0000-0000-00000000000a",
      "SPA-1234",
      "",
    ]) {
      const { sql: emitted } = await captureOwnership(unanchored);
      expect(emitted, JSON.stringify(unanchored)).toMatch(contextArm);
      expect(emitted, JSON.stringify(unanchored)).not.toContain(`"native_issue_id" = $22::uuid`);
      expect(emitted, JSON.stringify(unanchored)).not.toContain("coalesce");
    }
  }, 180_000);

  it("plans the captured production read against the existing issue indexes", async () => {
    for (let index = 0; index < 400; index += 1) {
      await seedRun({
        status: index % 5 === 0 ? "running" : "succeeded",
        contextIssueId: index % 2 === 0 ? randomUUID() : null,
        nativeIssueId: index % 2 === 0 ? null : randomUUID(),
        processPid: index % 2 === 0 ? 4_000 + index : null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      });
    }
    await seedRun({ contextIssueId, processGroupId: 999_005, createdAt: new Date("2026-01-09T00:00:00Z") });
    await raw`ANALYZE heartbeat_runs`;

    const { sql: rewritten, params } = await captureOwnership(contextIssueId);
    const planOf = async (statement: string) =>
      (await raw.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${statement}`, params))
        .map((row) => String(Object.values(row)[0]))
        .join("\n");

    const rewrittenPlan = await planOf(rewritten);

    expect(rewrittenPlan).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(rewrittenPlan).not.toMatch(/Seq Scan on heartbeat_runs/);
    expect(rewrittenPlan).not.toMatch(/Sort\s+cost/);
  }, 240_000);

  it("observes ownership that changes between two reads", async () => {
    const first = await seedRun({ contextIssueId });
    await seedLease(first);
    expect(await getConversationOwnershipBlocker(db, companyId, contextIssueId))
      .toMatchObject({ runId: first, cause: "execution_owner_active" });

    await db.update(environmentLeases)
      .set({ releasedAt: new Date(), status: "released" })
      .where(eq(environmentLeases.heartbeatRunId, first));
    expect(await getConversationOwnershipBlocker(db, companyId, contextIssueId)).toBeNull();

    const successor = await seedRun({
      nativeIssueId: contextIssueId,
      status: "failed",
      processPid: process.pid,
      createdAt: new Date("2026-01-07T00:00:00Z"),
    });
    expect(await getConversationOwnershipBlocker(db, companyId, contextIssueId))
      .toMatchObject({ runId: successor, cause: "execution_owner_active" });
  }, 180_000);

  it("reads ownership inside one transaction snapshot without leaking a later change backwards", async () => {
    const original = await seedRun({ contextIssueId });
    await seedLease(original);
    expect(await getConversationOwnershipBlocker(db, companyId, contextIssueId)).toMatchObject({ runId: original });

    let successorId = "";
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      expect(await getConversationOwnershipBlocker(tx as unknown as Db, companyId, contextIssueId))
        .toMatchObject({ runId: original });
      await db.update(environmentLeases)
        .set({ releasedAt: new Date(), status: "released" })
        .where(eq(environmentLeases.heartbeatRunId, original));
      successorId = await seedRun({
        contextIssueId,
        status: "failed",
        processPid: process.pid,
        createdAt: new Date("2026-01-08T00:00:00Z"),
      });
      expect(await getConversationOwnershipBlocker(tx as unknown as Db, companyId, contextIssueId))
        .toMatchObject({ runId: original });
    });

    expect(successorId).not.toBe("");
    expect(await getConversationOwnershipBlocker(db, companyId, contextIssueId))
      .toMatchObject({ runId: successorId, cause: "execution_owner_active" });
  }, 180_000);
});