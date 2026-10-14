import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { generateDrizzleJson } from "drizzle-kit/api";
import path from "node:path";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const MIGRATION_FILE = "9288_heartbeat_run_list_projection_columns.sql";
const JOURNAL_TAG = "9288_heartbeat_run_list_projection_columns";
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));
const JOURNAL_PATH = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));
const SNAPSHOT_PATH = fileURLToPath(new URL("./migrations/meta/9288_snapshot.json", import.meta.url));
const PREVIOUS_SNAPSHOT_PATH = fileURLToPath(new URL("./migrations/meta/9286_snapshot.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("./schema/heartbeat_runs.ts", import.meta.url));
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url));

const LEDGER_COLUMN = "result_ledger_summary";

const expectedColumns = {
  context_task_key: { type: "text", key: "taskKey", operator: "->>" },
  context_comment_id: { type: "text", key: "commentId", operator: "->>" },
  context_wake_comment_id: { type: "text", key: "wakeCommentId", operator: "->>" },
  context_wake_comment_ids: { type: "jsonb", key: "wakeCommentIds", operator: "->" },
  context_wake_reason: { type: "text", key: "wakeReason", operator: "->>" },
  context_wake_source: { type: "text", key: "wakeSource", operator: "->>" },
  context_wake_trigger_detail: { type: "text", key: "wakeTriggerDetail", operator: "->>" },
  result_list_summary: { type: "text", key: "summary", operator: "->>" },
  result_list_result: { type: "text", key: "result", operator: "->>" },
  result_list_message: { type: "text", key: "message", operator: "->>" },
  result_list_error: { type: "text", key: "error", operator: "->>" },
  result_list_total_cost_usd: { type: "text", key: "total_cost_usd", operator: "->>" },
  result_list_cost_usd: { type: "text", key: "cost_usd", operator: "->>" },
  result_list_cost_usd_camel: { type: "text", key: "costUsd", operator: "->>" },
} as const;

const allColumnNames = [...Object.keys(expectedColumns), LEDGER_COLUMN];

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_generated: string;
  generation_expression: string | null;
};

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startTestDatabase(prefix: string): Promise<postgres.Sql> {
  const dbh = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(() => dbh.cleanup());
  const sql = postgres(dbh.connectionString, { max: 1 });
  cleanups.push(async () => {
    await sql.end();
  });
  return sql;
}

async function seedRun(
  sql: postgres.Sql,
  resultJson: Record<string, unknown> | null,
): Promise<string> {
  const companyId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  // issue_prefix is uniquely indexed, so every seeded company needs its own.
  const issuePrefix = `SP47-${crypto.randomUUID().slice(0, 8)}`;
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}::uuid, 'SPA-11947', ${issuePrefix})`;
  await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}::uuid, ${companyId}::uuid, 'SPA-11947 A', 'engineer', 'process')`;
  await sql`
    INSERT INTO heartbeat_runs (id, company_id, agent_id, status, result_json)
    VALUES (
      ${runId}::uuid,
      ${companyId}::uuid,
      ${agentId}::uuid,
      'succeeded',
      ${resultJson === null ? null : sql.json(resultJson as postgres.JSONValue)}::jsonb
    )
  `;
  return runId;
}

async function readLedgerSummary(
  sql: postgres.Sql,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await sql.unsafe<Array<{ result_ledger_summary: unknown }>>(
    `SELECT result_ledger_summary FROM heartbeat_runs WHERE id = $1`,
    [runId],
  );
  return (row?.result_ledger_summary ?? null) as Record<string, unknown> | null;
}

// The pre-9286 per-row expression, copied verbatim from `summarizedResultJson`
// in server/src/services/activity.ts as it read before this migration. It is the
// oracle the stored column is compared against, so it is deliberately the OLD
// spelling: jsonb_build_object + jsonb_strip_nulls are STABLE, which is why the
// expression could not be a STORED generated column (SQLSTATE 42P17) and had to
// be rebuilt here out of IMMUTABLE pieces. Inside a plain SELECT both functions
// are perfectly legal, which is what makes this comparison possible at all.
const OLD_LEDGER_SUMMARY_EXPRESSION = `
  case
    when result_json is null then null
    else jsonb_strip_nulls(jsonb_build_object(
      'conversationReset', result_json -> 'conversationReset',
      'billingType', coalesce(result_json -> 'billingType', result_json -> 'billing_type'),
      'billing_type', coalesce(result_json -> 'billing_type', result_json -> 'billingType'),
      'costUsd', coalesce(
        result_json -> 'costUsd',
        result_json -> 'cost_usd',
        result_json -> 'total_cost_usd'
      ),
      'cost_usd', coalesce(
        result_json -> 'cost_usd',
        result_json -> 'costUsd',
        result_json -> 'total_cost_usd'
      ),
      'total_cost_usd', coalesce(
        result_json -> 'total_cost_usd',
        result_json -> 'cost_usd',
        result_json -> 'costUsd'
      ),
      'stopReason', result_json -> 'stopReason',
      'effectiveTimeoutSec', result_json -> 'effectiveTimeoutSec',
      'effectiveTimeoutMs', result_json -> 'effectiveTimeoutMs',
      'timeoutConfigured', result_json -> 'timeoutConfigured',
      'timeoutSource', result_json -> 'timeoutSource',
      'timeoutFired', result_json -> 'timeoutFired'
    ))
  end
`;

// Same-row parity oracle. Both expressions are evaluated in ONE SELECT against
// the SAME row, so the assertion is "the stored column equals what the old
// per-row read produced for this row", not "the stored column equals a value the
// test author also wrote by hand". Called for every seeded row in the semantic
// matrix below (and after every UPDATE that rewrites result_json).
async function expectLedgerSummaryParity(sql: postgres.Sql, runId: string): Promise<void> {
  const [row] = await sql.unsafe<Array<{ stored: unknown; from_old_expression: unknown }>>(
    `SELECT result_ledger_summary AS stored,
            ${OLD_LEDGER_SUMMARY_EXPRESSION} AS from_old_expression
     FROM heartbeat_runs WHERE id = $1`,
    [runId],
  );
  expect(row, "seeded row must be readable for the ledger parity read").toBeDefined();
  expect(row?.stored ?? null).toEqual(row?.from_old_expression ?? null);
}

d("SPA-11947 heartbeat run-list projection columns migration", () => {
  it(
    "lands all 15 columns as stored generated columns with the expected expressions",
    async () => {
      const sql = await startTestDatabase("pap11947-mig-");

      const rows = await sql.unsafe<ColumnRow[]>(
        `SELECT column_name, data_type, is_generated, generation_expression
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'heartbeat_runs'
           AND column_name = ANY($1::text[])
         ORDER BY column_name`,
        [allColumnNames],
      );
      expect(rows).toHaveLength(15);
      const byName = new Map(rows.map((row) => [row.column_name, row]));

      for (const [name, expected] of Object.entries(expectedColumns)) {
        const row = byName.get(name);
        expect(row, `${name} missing`).toBeDefined();
        expect(row?.data_type).toBe(expected.type);
        expect(row?.is_generated).toBe("ALWAYS");
        const expression = collapseWhitespace(row?.generation_expression ?? "");
        expect(expression).toContain(expected.key);
        expect(expression).toContain(expected.operator);
      }

      // The ledger column is a STORED generated column. Reaching this point at
      // all is the 42P17 proof: PostgreSQL refuses to create a stored generated
      // column whose expression is not IMMUTABLE, and the first cut of this
      // migration (jsonb_strip_nulls(jsonb_build_object(...))) failed exactly
      // that way when applied inside the embedded-Postgres test cluster.
      const ledger = byName.get(LEDGER_COLUMN);
      expect(ledger?.data_type).toBe("jsonb");
      expect(ledger?.is_generated).toBe("ALWAYS");
      const ledgerExpression = collapseWhitespace(ledger?.generation_expression ?? "");
      expect(ledgerExpression).toContain("jsonb_set('{}'::jsonb");
      expect(ledgerExpression).toContain("||");
      expect(ledgerExpression).toContain("conversationReset");
      expect(ledgerExpression).toContain("total_cost_usd");
      expect(ledgerExpression).toContain("timeoutFired");
      // The STABLE functions are gone rather than hidden behind an IMMUTABLE
      // wrapper: a false immutability claim would let the planner fold a value
      // that must follow its inputs.
      expect(ledgerExpression).not.toContain("jsonb_build_object");
      expect(ledgerExpression).not.toContain("jsonb_strip_nulls");
    },
    240_000,
  );

  it(
    "keeps the narrow columns identical to the pre-9286 list and ledger reads",
    async () => {
      const sql = await startTestDatabase("pap11947-values-");

      const companyId = crypto.randomUUID();
      const agentId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}::uuid, 'SPA-11947', 'SP47')`;
      await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}::uuid, ${companyId}::uuid, 'SPA-11947 A', 'engineer', 'process')`;
      await sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status, context_snapshot, result_json)
        VALUES (
          ${runId}::uuid,
          ${companyId}::uuid,
          ${agentId}::uuid,
          'succeeded',
          ${sql.json({
            issueId: "issue-1",
            taskId: "task-1",
            taskKey: "SPA-11947",
            commentId: "comment-1",
            wakeCommentId: "wake-1",
            wakeCommentIds: ["wake-1", "wake-2"],
            wakeReason: "issue_assigned",
            wakeSource: "assignment",
            wakeTriggerDetail: "detail",
            wide: "x".repeat(100_000),
          })}::jsonb,
          ${sql.json({
            summary: "done",
            result: "ok",
            message: "message",
            error: "none",
            total_cost_usd: 1.25,
            cost_usd: 1.5,
            costUsd: 1.75,
            conversationReset: true,
            billing_type: "metered",
            stopReason: "complete",
            timeoutFired: false,
            wide: "y".repeat(100_000),
          })}::jsonb
        )
      `;

      const [row] = await sql.unsafe<Array<Record<string, unknown>>>(
        `SELECT ${allColumnNames.join(", ")} FROM heartbeat_runs WHERE id = $1`,
        [runId],
      );
      expect(row).toMatchObject({
        context_task_key: "SPA-11947",
        context_comment_id: "comment-1",
        context_wake_comment_id: "wake-1",
        context_wake_comment_ids: ["wake-1", "wake-2"],
        context_wake_reason: "issue_assigned",
        context_wake_source: "assignment",
        context_wake_trigger_detail: "detail",
        result_list_summary: "done",
        result_list_result: "ok",
        result_list_message: "message",
        result_list_error: "none",
        result_list_total_cost_usd: "1.25",
        result_list_cost_usd: "1.5",
        result_list_cost_usd_camel: "1.75",
      });
      expect(row?.result_ledger_summary).toEqual({
        conversationReset: true,
        billingType: "metered",
        billing_type: "metered",
        costUsd: 1.75,
        cost_usd: 1.5,
        total_cost_usd: 1.25,
        stopReason: "complete",
        timeoutFired: false,
      });
    },
    240_000,
  );

  it("preserves null / alias / scalar-type semantics of the old per-row expression", async () => {
    const sql = await startTestDatabase("pap11947-parity-");

    // Every row below is asserted twice: against the hand-written expectation
    // (what the semantics must be) AND against the pre-9286 expression evaluated
    // on the same row (what the migration must reproduce). Neither check can
    // stand in for the other — the expectation encodes the intent, the parity
    // read encodes the equivalence.

    // SQL NULL result_json => SQL NULL summary (the outer CASE guard).
    const nullRun = await seedRun(sql, null);
    expect(await readLedgerSummary(sql, nullRun)).toBeNull();
    await expectLedgerSummaryParity(sql, nullRun);

    // A non-null document with none of the projected keys => empty object,
    // never NULL. jsonb_build_object of eleven nulls stripped to '{}' is the
    // behaviour being reproduced.
    const unrelatedRun = await seedRun(sql, { wide: "unrelated" });
    expect(await readLedgerSummary(sql, unrelatedRun)).toEqual({});
    await expectLedgerSummaryParity(sql, unrelatedRun);

    const emptyDocumentRun = await seedRun(sql, {});
    expect(await readLedgerSummary(sql, emptyDocumentRun)).toEqual({});
    await expectLedgerSummaryParity(sql, emptyDocumentRun);

    // Present-but-JSON-null values are omitted, and `->` on such a key yields
    // jsonb null (not SQL NULL) so coalesce does NOT fall through — the
    // camel key wins the coalesce, is null, and is then dropped. That is the
    // pre-existing PostgreSQL JSON-null behaviour the old expression had.
    const jsonNullRun = await seedRun(sql, {
      billingType: null,
      billing_type: "subscription",
      costUsd: null,
      cost_usd: 2,
      stopReason: null,
      timeoutConfigured: null,
    });
    expect(await readLedgerSummary(sql, jsonNullRun)).toEqual({
      billing_type: "subscription",
      cost_usd: 2,
      total_cost_usd: 2,
    });
    await expectLedgerSummaryParity(sql, jsonNullRun);

    // Absent keys fall through to the snake_case alias and every cost alias.
    const fallbackRun = await seedRun(sql, {
      billing_type: "subscription",
      cost_usd: 2,
      timeoutFired: false,
    });
    expect(await readLedgerSummary(sql, fallbackRun)).toEqual({
      billingType: "subscription",
      billing_type: "subscription",
      costUsd: 2,
      cost_usd: 2,
      total_cost_usd: 2,
      timeoutFired: false,
    });
    await expectLedgerSummaryParity(sql, fallbackRun);

    // total_cost_usd is the last-resort source for all three cost aliases.
    const lastResortRun = await seedRun(sql, { total_cost_usd: 7 });
    expect(await readLedgerSummary(sql, lastResortRun)).toEqual({
      costUsd: 7,
      cost_usd: 7,
      total_cost_usd: 7,
    });
    await expectLedgerSummaryParity(sql, lastResortRun);

    // Explicit values are never coalesced against each other: each alias key
    // reports the source that actually won.
    const precedenceRun = await seedRun(sql, {
      billingType: "metered",
      billing_type: "ignored",
      costUsd: 9,
      cost_usd: 8,
      total_cost_usd: 7,
    });
    expect(await readLedgerSummary(sql, precedenceRun)).toEqual({
      billingType: "metered",
      billing_type: "ignored",
      costUsd: 9,
      cost_usd: 8,
      total_cost_usd: 7,
    });
    await expectLedgerSummaryParity(sql, precedenceRun);

    // Scalar, array and object values survive verbatim (jsonb_set writes the
    // value as given; jsonb_build_object did the same).
    const typedRun = await seedRun(sql, {
      conversationReset: false,
      stopReason: "a/b c",
      effectiveTimeoutSec: 0,
      effectiveTimeoutMs: 1.5e9,
      timeoutConfigured: true,
      timeoutSource: { kind: "budget", nested: { deep: [1, 2, 3] } },
      timeoutFired: ["a", "b"],
      costUsd: { amount: 3, currency: "USD" },
    });
    // An OBJECT value for costUsd fans out to all three cost aliases, because
    // each alias independently coalesces over the same three source keys.
    expect(await readLedgerSummary(sql, typedRun)).toEqual({
      conversationReset: false,
      stopReason: "a/b c",
      effectiveTimeoutSec: 0,
      effectiveTimeoutMs: 1500000000,
      timeoutConfigured: true,
      timeoutSource: { kind: "budget", nested: { deep: [1, 2, 3] } },
      timeoutFired: ["a", "b"],
      costUsd: { amount: 3, currency: "USD" },
      cost_usd: { amount: 3, currency: "USD" },
      total_cost_usd: { amount: 3, currency: "USD" },
    });
    await expectLedgerSummaryParity(sql, typedRun);

    // Nested JSON nulls are preserved verbatim by the stored column
    // (jsonb_set writes the selected value unchanged), while the pre-9286
    // per-row expression stripped them recursively via jsonb_strip_nulls.
    // The same-row parity oracle is deliberately NOT called for this row —
    // it would fail by design — so the assertions below document the KNOWN
    // difference rather than claiming equivalence: nested `detail: null`
    // survives in `stored` but is gone from `from_old_expression`.
    // Top-level scalar/array/object behaviour is unchanged, so only the
    // nested-null keys differ. (Array-element nulls are kept by BOTH sides —
    // jsonb_strip_nulls strips null-valued OBJECT keys recursively but never
    // array elements — so no array case is pinned here.)
    const nestedNullRun = await seedRun(sql, {
      stopReason: "timeout",
      timeoutSource: { kind: "budget", detail: null, retryable: true },
      costUsd: { amount: 3, note: null },
    });
    const storedNested = await readLedgerSummary(sql, nestedNullRun);
    expect(storedNested).toEqual({
      stopReason: "timeout",
      timeoutSource: { kind: "budget", detail: null, retryable: true },
      costUsd: { amount: 3, note: null },
      cost_usd: { amount: 3, note: null },
      total_cost_usd: { amount: 3, note: null },
    });
    const [nestedRow] = await sql.unsafe<
      Array<{ stored: unknown; from_old_expression: unknown }>
    >(
      `SELECT result_ledger_summary AS stored,
              ${OLD_LEDGER_SUMMARY_EXPRESSION} AS from_old_expression
       FROM heartbeat_runs WHERE id = $1`,
      [nestedNullRun],
    );
    expect(nestedRow?.from_old_expression).toEqual({
      stopReason: "timeout",
      timeoutSource: { kind: "budget", retryable: true },
      costUsd: { amount: 3 },
      cost_usd: { amount: 3 },
      total_cost_usd: { amount: 3 },
    });
    expect(nestedRow?.stored ?? null).not.toEqual(
      nestedRow?.from_old_expression ?? null,
    );
  }, 240_000);

  it("keeps each projected key exactly once", async () => {
    const sql = await startTestDatabase("pap11947-keys-");
    const runId = await seedRun(sql, {
      conversationReset: true,
      billingType: "metered",
      billing_type: "metered",
      costUsd: 1,
      cost_usd: 1,
      total_cost_usd: 1,
      stopReason: "s",
      effectiveTimeoutSec: 1,
      effectiveTimeoutMs: 2,
      timeoutConfigured: true,
      timeoutSource: "src",
      timeoutFired: false,
    });
    const [row] = await sql.unsafe<Array<{ keys: string[] }>>(
      `SELECT array(
         SELECT jsonb_object_keys(result_ledger_summary)
       ) AS keys
       FROM heartbeat_runs WHERE id = $1`,
      [runId],
    );
    expect([...(row?.keys ?? [])].sort()).toEqual([
      "billingType",
      "billing_type",
      "conversationReset",
      "costUsd",
      "cost_usd",
      "effectiveTimeoutMs",
      "effectiveTimeoutSec",
      "stopReason",
      "timeoutConfigured",
      "timeoutFired",
      "timeoutSource",
      "total_cost_usd",
    ]);
    await expectLedgerSummaryParity(sql, runId);
  }, 240_000);

  it("recomputes the ledger summary on UPDATE", async () => {
    const sql = await startTestDatabase("pap11947-update-");
    const runId = await seedRun(sql, { summary: "first", stopReason: "complete" });
    expect(await readLedgerSummary(sql, runId)).toEqual({ stopReason: "complete" });
    await expectLedgerSummaryParity(sql, runId);

    await sql`
      UPDATE heartbeat_runs
      SET result_json = ${sql.json({
        conversationReset: false,
        billingType: "metered",
        costUsd: 4.5,
        stopReason: "budget_exhausted",
        timeoutFired: false,
      })}::jsonb
      WHERE id = ${runId}::uuid
    `;
    expect(await readLedgerSummary(sql, runId)).toEqual({
      conversationReset: false,
      billingType: "metered",
      billing_type: "metered",
      costUsd: 4.5,
      cost_usd: 4.5,
      total_cost_usd: 4.5,
      stopReason: "budget_exhausted",
      timeoutFired: false,
    });
    await expectLedgerSummaryParity(sql, runId);

    // Clearing result_json clears the summary — same NULL semantics on the
    // update path as on the insert path.
    await sql`UPDATE heartbeat_runs SET result_json = NULL WHERE id = ${runId}::uuid`;
    expect(await readLedgerSummary(sql, runId)).toBeNull();
    await expectLedgerSummaryParity(sql, runId);

    // The seven scalar projections follow the same UPDATE, so the list shape
    // and the ledger shape never disagree.
    await sql`
      UPDATE heartbeat_runs
      SET result_json = ${sql.json({ summary: "second" })}::jsonb
      WHERE id = ${runId}::uuid
    `;
    const [scalarRow] = await sql.unsafe<Array<Record<string, unknown>>>(
      `SELECT result_list_summary, result_list_error, result_ledger_summary FROM heartbeat_runs WHERE id = $1`,
      [runId],
    );
    expect(scalarRow).toMatchObject({
      result_list_summary: "second",
      result_list_error: null,
      result_ledger_summary: {},
    });
    await expectLedgerSummaryParity(sql, runId);
  }, 240_000);

  it("registers one 9288 migration and chains its snapshot to the base 9286 snapshot", async () => {
    const journal = JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const matches = journal.entries.filter((entry) => entry.tag === JOURNAL_TAG);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ idx: 9288, tag: JOURNAL_TAG });
    expect(journal.entries.at(-1)).toEqual(matches[0]);
    expect(await readdir(MIGRATIONS_DIR)).toContain(MIGRATION_FILE);

    // This migration was renumbered 9286 -> 9288 because the base branch landed
    // 9286 and 9287 out from under the original index. A merge that resolves the
    // journal conflict by taking one side wholesale silently DELETES the other
    // side's entries: the .sql files stay on disk, so every assertion above
    // still passes while those migrations never run. Pin the neighbours this
    // renumber had to preserve, and pin the ordering the chain depends on.
    for (const idx of [9286, 9287]) {
      expect(
        journal.entries.some((entry) => entry.idx === idx),
        `journal entry ${idx} was dropped — the base branch's migration would never run`,
      ).toBe(true);
    }
    const indices = journal.entries.map((entry) => entry.idx);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(new Set(indices).size).toBe(indices.length);

    const previous = JSON.parse(await readFile(PREVIOUS_SNAPSHOT_PATH, "utf8")) as { id: string };
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as {
      prevId: string;
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    expect(snapshot.prevId).toBe(previous.id);
    const columns = snapshot.tables["public.heartbeat_runs"]?.columns ?? {};
    expect(allColumnNames.every((name) => name in columns)).toBe(true);

    // All fifteen are stored generated columns in the snapshot too, so the next
    // `generateMigration` diff is empty instead of re-adding the column.
    for (const name of allColumnNames) {
      expect(columns[name], `${name} must be a stored generated column`).toMatchObject({
        generated: { type: "stored" },
      });
    }
  });

  it("declares every generated column in the drizzle schema, including the ledger", async () => {
    const schema = await readFile(SCHEMA_PATH, "utf8");
    for (const name of allColumnNames) expect(schema).toContain(`"${name}"`);
    expect(schema).toContain(".generatedAlwaysAs(");
    expect(schema).toContain("heartbeatRuns.contextSnapshot");
    expect(schema).toContain("heartbeatRuns.resultJson");

    // Slice the WHOLE declaration — the builder chain and the expression body —
    // between the surrounding field boundaries, so these assertions inspect the
    // SQL itself instead of stopping at the `generatedAlwaysAs(` call.
    const start = schema.indexOf("resultLedgerSummary:");
    const end = schema.indexOf("createdAt:", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const declaration = schema.slice(start, end);
    expect(declaration).toContain('jsonb("result_ledger_summary")');
    // The schema mirrors the SQL: immutable pieces only, no STABLE function and
    // no IMMUTABLE wrapper standing in for one. The prose comment above the
    // declaration names those functions while explaining why they are gone, so
    // it must stay outside this slice for these two assertions to mean anything.
    expect(declaration).toContain("jsonb_set('{}'::jsonb");
    expect(declaration).toContain("||");
    expect(declaration).not.toContain("jsonb_build_object");
    expect(declaration).not.toContain("jsonb_strip_nulls");
  });

  it("adds no trigger, function or backfill UPDATE to the table", async () => {
    const migration = await readFile(MIGRATION_PATH, "utf8");
    // A trigger-maintained column was the first repair: it needed a full-table
    // backfill UPDATE, which fires 0282's terminal audit trigger once per
    // terminal row and rewrites the whole relation a second time. The column is
    // a stored generated column now, so none of those objects may come back.
    //
    // These guards read the EXECUTABLE SQL only. The header comment
    // deliberately discusses 42P17, STABLE and IMMUTABLE while explaining why
    // no IMMUTABLE wrapper is declared; matching prose would make this test
    // unreadable rather than strict, and the point is what Postgres executes.
    const executable = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executable).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i);
    expect(executable).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(executable).not.toMatch(/UPDATE\s+"?heartbeat_runs"?/i);
    expect(executable).not.toMatch(/IMMUTABLE/i);
    // The migration really is one ALTER TABLE, so the stored columns are filled
    // by the single rewrite PostgreSQL performs for that command.
    expect(executable).toMatch(/^ALTER TABLE "heartbeat_runs"$/m);
    expect(executable.match(/ALTER TABLE/gi)).toHaveLength(1);
  });

  it("is idempotent on re-run", async () => {
    const sql = await startTestDatabase("pap11947-idem-");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    await sql.unsafe(migrationSql);
  }, 240_000);

  it(
    "keeps the 9288 snapshot byte-identical to what drizzle-kit would emit",
    async () => {
      const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as {
        id: string;
        tables: Record<string, { columns: Record<string, { generated?: { as: string; type: string } }> }>;
      };
      const schemaDir = fileURLToPath(new URL("./schema", import.meta.url));
      const exports: Record<string, unknown> = {};
      const seen = new Set<unknown>();
      for (const file of (await readdir(schemaDir)).filter((entry) => entry.endsWith(".ts")).sort()) {
        const mod = (await import(
          /* @vite-ignore */ pathToFileURL(path.join(schemaDir, file)).href
        )) as Record<string, unknown>;
        for (const [name, value] of Object.entries(mod)) {
          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) continue;
            seen.add(value);
          }
          exports[`${file}#${name}`] = value;
        }
      }
      const derived = generateDrizzleJson(exports, snapshot.id) as typeof snapshot;
      const committedColumns = snapshot.tables["public.heartbeat_runs"]?.columns ?? {};
      const rebuiltColumns = derived.tables["public.heartbeat_runs"]?.columns ?? {};

      // EVERY generated column this migration added, not only the ledger one: a
      // snapshot entry that is present but wrong (wrong key path, wrong
      // operator, jsonb where text was declared) still diffs cleanly for
      // `generateMigration`, so the receipt has to be per column and exact.
      // `toEqual` compares the full snapshot entry — name, type, primaryKey,
      // notNull and the generated definition — so any serializer or content
      // difference fails here rather than in the next `generate`.
      for (const name of allColumnNames) {
        const committed = committedColumns[name];
        const rebuilt = rebuiltColumns[name];
        expect(committed, `${name} missing from the committed 9288 snapshot`).toBeDefined();
        expect(rebuilt, `${name} missing from generateDrizzleJson output`).toBeDefined();
        expect(committed).toEqual(rebuilt);
        // Spelled out separately so a failure says WHICH half of the entry is
        // wrong rather than only that two entries differ.
        expect(committed?.generated?.type).toBe("stored");
        expect(committed?.generated?.as).toBe(rebuilt?.generated?.as);
      }

      // The ledger column is the one whose expression is hand-assembled rather
      // than a single `->>` projection, so its definition gets the extra
      // structural assertions the generated-AlwaysAs form makes redundant.
      expect(committedColumns[LEDGER_COLUMN]?.generated?.as).toContain("jsonb_set('{}'::jsonb");
      expect(committedColumns[LEDGER_COLUMN]?.generated?.as).not.toContain("jsonb_build_object");
      expect(committedColumns[LEDGER_COLUMN]?.generated?.as).not.toContain("jsonb_strip_nulls");
    },
    240_000,
  );
});