import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { boundHeartbeatRunEventPayloadForStorage, heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// SPA-11947 — the run-list projections are read on every board poll. Draining the
// 70 KB `context_snapshot` / `result_json` TOAST value per row is what stalled the
// board API on 2026-10-12, so the regression guard has to read the SQL the
// service actually emits (not the nulls it happens to return). This proxy records
// the generated SQL of every select the service runs while still executing it.
function captureRunListSql(db: ReturnType<typeof createDb>) {
  const captured: { sql: string }[] = [];

  const wrapBuilder = (builder: unknown): unknown => {
    if (typeof builder !== "object" || builder === null) return builder;
    return new Proxy(builder as Record<PropertyKey, unknown>, {
      get(target, property) {
        if (property === "then") {
          return (...args: unknown[]) => {
            const built = (target.toSQL as () => { sql: string })();
            captured.push({ sql: built.sql });
            return (target.then as (...thenArgs: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property);
        if (typeof value === "function") {
          return (...args: unknown[]) =>
            wrapBuilder((value as (...callArgs: unknown[]) => unknown).apply(target, args));
        }
        return value;
      },
    });
  };

  const observedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "select") {
        return (...args: unknown[]) =>
          wrapBuilder(Reflect.apply(target.select as (...selectArgs: unknown[]) => unknown, target, args));
      }
      return Reflect.get(target, property, receiver);
    },
  });

  return { observedDb, captured };
}

// Guards against a vacuous pass: an uncaptured or empty statement must fail the
// test before the "no raw JSONB" assertions are even reached.
function expectRealRunListSql(statement: { sql: string } | undefined) {
  expect(statement, "expected the run-list select to be captured").toBeDefined();
  const sql = statement!.sql;
  expect(sql).toMatch(/^\s*select/i);
  expect(sql).toContain('"heartbeat_runs"');
  return sql;
}

// SPA-11947 — the fifteen stored generated columns are read-side plumbing. The
// run-list projections consume them under the PUBLIC names the API already
// returned (resultSummary, wakeCommentIds, contextCommentId, ...), so getRun
// must keep returning the pre-9286 public shape and must NOT start exposing the
// generated columns themselves. Both spellings are listed because a leaked
// column could surface under either the drizzle property name or the SQL column
// name, and the shape contract covers the row object, not the SELECT list.
const SPA11947_INTERNAL_PROJECTION_COLUMNS = {
  contextTaskKey: "context_task_key",
  contextCommentId: "context_comment_id",
  contextWakeCommentId: "context_wake_comment_id",
  contextWakeCommentIds: "context_wake_comment_ids",
  contextWakeReason: "context_wake_reason",
  contextWakeSource: "context_wake_source",
  contextWakeTriggerDetail: "context_wake_trigger_detail",
  resultListSummary: "result_list_summary",
  resultListResult: "result_list_result",
  resultListMessage: "result_list_message",
  resultListError: "result_list_error",
  resultListTotalCostUsd: "result_list_total_cost_usd",
  resultListCostUsd: "result_list_cost_usd",
  resultListCostUsdCamel: "result_list_cost_usd_camel",
  resultLedgerSummary: "result_ledger_summary",
} as const;

function expectNoInternalProjectionColumns(run: object | null | undefined) {
  expect(run, "expected getRun to return the run").toBeTruthy();
  for (const [property, column] of Object.entries(SPA11947_INTERNAL_PROJECTION_COLUMNS)) {
    expect(Object.hasOwn(run!, property), `${property} must stay internal to getRun`).toBe(false);
    expect(Object.hasOwn(run!, column), `${column} must stay internal to getRun`).toBe(false);
  }
}

describeEmbeddedPostgres("heartbeat list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns runs even when the linked db schema lacks processGroupId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date("2026-04-18T12:00:00Z"),
      nextAction: "continue implementation",
      contextSnapshot: { issueId: randomUUID() },
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(heartbeatRuns, "processGroupId");
    Object.defineProperty(heartbeatRuns, "processGroupId", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const runs = await heartbeatService(db).list(companyId, agentId, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(runId);
      expect(runs[0]?.processGroupId ?? null).toBeNull();
      expect(runs[0]).toMatchObject({
        livenessState: "advanced",
        livenessReason: "run produced action evidence",
        continuationAttempt: 1,
        nextAction: "continue implementation",
      });
      expect(runs[0]?.lastUsefulActionAt).toEqual(new Date("2026-04-18T12:00:00Z"));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(heartbeatRuns, "processGroupId", originalDescriptor);
      } else {
        delete (heartbeatRuns as Record<string, unknown>).processGroupId;
      }
    }
  });

  it("returns small result json payloads unchanged from getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "done",
        structured: { ok: true },
      },
    });

    const run = await heartbeatService(db).getRun(runId);

    expect(run?.resultJson).toEqual({
      summary: "done",
      structured: { ok: true },
    });
  });

  it("keeps getRun's public shape while hiding the generated projection columns", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const taskId = randomUUID();
    const contextSnapshot = {
      issueId,
      taskId,
      taskKey: "SPA-11947",
      commentId: randomUUID(),
      wakeCommentId: randomUUID(),
      wakeCommentIds: [randomUUID()],
      wakeReason: "issue_assigned",
      wakeSource: "assignment",
      wakeTriggerDetail: "card checkout",
    };
    const resultJson = { summary: "done", structured: { ok: true } };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      contextSnapshot,
      resultJson,
    });

    const safe = await heartbeatService(db).getRun(runId);
    const unsafe = await heartbeatService(db).getRun(runId, { unsafeFullResultJson: true });

    for (const run of [safe, unsafe]) {
      expect(run).toMatchObject({
        id: runId,
        companyId,
        agentId,
        status: "succeeded",
        contextIssueId: issueId,
        contextTaskId: taskId,
        contextSnapshot,
        resultJson,
      });
      expectNoInternalProjectionColumns(run);
    }
  });

  it("returns summary list rows without heavy run detail fields", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "Failed after doing useful work",
      usageJson: {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 123,
      },
      resultJson: {
        summary: "large run summary",
        stdout: "x".repeat(20_000),
      },
      sessionIdBefore: "session-before",
      sessionIdAfter: "session-after",
      logStore: "local",
      logRef: "logs/run.log",
      logSha256: "abc123",
      externalRunId: "external-run",
      processPid: 12345,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });

    const runs = await heartbeatService(db).list(companyId, undefined, 5, { summary: true });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      error: "Failed after doing useful work",
      usageJson: null,
      resultJson: null,
      sessionIdBefore: null,
      sessionIdAfter: null,
      logStore: null,
      logRef: null,
      logSha256: null,
      externalRunId: null,
      processPid: null,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });
  });

  it("keeps the summary run list off the raw heartbeat_runs jsonb TOAST columns", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      usageJson: { provider: "openai", model: "gpt-5", inputTokens: 123 },
      resultJson: { summary: "done", stdout: "x".repeat(20_000) },
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
    });

    const { observedDb, captured } = captureRunListSql(db);

    const runs = await heartbeatService(observedDb).list(companyId, agentId, 5, { summary: true });

    // The list still returns the run; the point is what it had to ask Postgres for.
    expect(runs.map((run) => run.id)).toEqual([runId]);

    const sql = expectRealRunListSql(captured[0]);
    // The summary projection is the one the board polls. It must not dereference
    // the wide JSONB documents at all — neither in the projection nor in a filter.
    expect(sql).not.toContain("context_snapshot");
    expect(sql).not.toContain("result_json");
    // Narrow stored columns are the sanctioned way to read these scalars.
    expect(sql).toContain("context_issue_id");
  });

  it("keeps the non-summary run list off the raw heartbeat_runs jsonb TOAST columns", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "large run summary",
        stdout: "x".repeat(20_000),
        total_cost_usd: 1.25,
        cost_usd: 1.5,
        costUsd: 1.75,
      },
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
    });

    const { observedDb, captured } = captureRunListSql(db);

    // Default (non-summary) projection — the richer of the two run-list shapes.
    const runs = await heartbeatService(observedDb).list(companyId, agentId, 5);

    expect(runs.map((run) => run.id)).toEqual([runId]);
    expect(runs[0]?.resultJson).toEqual({
      summary: "large run summary",
      total_cost_usd: 1.25,
      cost_usd: 1.5,
      costUsd: 1.75,
    });

    const sql = expectRealRunListSql(captured[0]);
    expect(sql).not.toContain("context_snapshot");
    expect(sql).not.toContain("result_json");
    expect(sql).toContain("context_issue_id");
  });

  it("keeps non-summary list result text bounded after moving it to narrow columns", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const oversizedSummary = "s".repeat(5_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: { summary: oversizedSummary },
    });

    const runs = await heartbeatService(db).list(companyId, agentId, 5);
    const result = runs[0]?.resultJson as Record<string, unknown> | null;

    expect(result?.summary).toBe(oversizedSummary.slice(0, 500));
  });

  it("bounds oversized legacy result json payloads on getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const oversizedStdout = Array.from({ length: 8_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}-${randomUUID()}`,
    ).join("|");
    const oversizedNestedPayload = Array.from({ length: 6_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}:${randomUUID()}`,
    ).join("|");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "completed",
        stdout: oversizedStdout,
        nestedHuge: { payload: oversizedNestedPayload },
      },
    });

    const run = await heartbeatService(db).getRun(runId);
    const result = run?.resultJson as Record<string, unknown> | null;

    expect(result).toMatchObject({
      summary: "completed",
      truncated: true,
      truncationReason: "oversized_result_json",
      stdoutTruncated: true,
    });
    expect(typeof result?.stdout).toBe("string");
    expect((result?.stdout as string).length).toBeLessThan(oversizedStdout.length);
    expect(result).not.toHaveProperty("nestedHuge");
  });
});

describe("heartbeat run event payload bounding", () => {
  it("truncates oversized adapter metadata before storage", () => {
    const payload = boundHeartbeatRunEventPayloadForStorage({
      adapterType: "codex_local",
      prompt: "x".repeat(40_000),
      context: {
        issueId: "issue-1",
        memory: "y".repeat(40_000),
      },
    });

    expect(payload.adapterType).toBe("codex_local");
    expect(typeof payload.prompt).toBe("string");
    expect((payload.prompt as string).length).toBeLessThan(20_000);
    expect(payload.prompt).toContain("[truncated");
    expect(payload.context).toMatchObject({
      issueId: "issue-1",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(45_000);
  });
});
