import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SPA-9282 terminalizeLegacyExecution tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("SPA-9282 — terminalizeLegacyExecution once-write guarantee", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-9282-terminalize-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLegacyFailedRun() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = randomUUID();
    const sourceIssueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Spark Mojo",
      issuePrefix: `SPA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        reportsTo: null,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Steve",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "SPA-9282 legacy reconcile — once-write",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `SPA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "adapter_failed",
      error: "Generic legacy execution failure",
      processPid: 4321,
      startedAt: new Date("2026-09-20T12:00:00.000Z"),
      finishedAt: new Date("2026-09-20T12:00:30.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, sourceIssueId));

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows);
    return { companyId, managerId, agentId, sourceIssueId, run, runId };
  }

  it("writes terminalization exactly once; updated_at and executionStatusDeliveryId stay put on repeat calls", async () => {
    const { run, runId } = await seedLegacyFailedRun();

    // First call: row has no executionStatusDeliveryId, so the guard
    // admits it. Persists a fresh executionStatusDeliveryId, a new
    // updated_at, and mints a source-scoped issueRecoveryAction.
    const first = await terminalizeLegacyExecution({
      db,
      run,
      status: "failed",
    });
    expect(first).not.toBeNull();
    const afterFirst = await db
      .select({
        executionStatusDeliveryId: heartbeatRuns.executionStatusDeliveryId,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(afterFirst?.executionStatusDeliveryId).toBeTruthy();
    const updatedAtAfterFirst = afterFirst?.updatedAt.getTime();
    const deliveryAfterFirst = afterFirst?.executionStatusDeliveryId;
    const recoveryActionsAfterFirst = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions);
    expect(recoveryActionsAfterFirst).toHaveLength(1);

    // Sleep 25ms so a real rewrite would move updated_at.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Second call: same run, same status, no patch. The guard sees a
    // populated executionStatusDeliveryId and an empty patch, so it
    // returns null without writing.
    const second = await terminalizeLegacyExecution({
      db,
      run,
      status: "failed",
    });
    expect(second).toBeNull();

    const afterSecond = await db
      .select({
        executionStatusDeliveryId: heartbeatRuns.executionStatusDeliveryId,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(afterSecond?.executionStatusDeliveryId).toBe(deliveryAfterFirst);
    expect(afterSecond?.updatedAt.getTime()).toBe(updatedAtAfterFirst);

    // Recovery action must not be re-minted.
    const recoveryActionsAfterSecond = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions);
    expect(recoveryActionsAfterSecond).toHaveLength(1);
    expect(recoveryActionsAfterSecond[0]?.id).toBe(recoveryActionsAfterFirst[0]?.id);
  });

  it("does not reopen the once-write guard when status delivery clears executionStatusDeliveryId", async () => {
    // SPA-9282 cycle 4 regression: deliverExecutionStatuses (a 15s sweep)
    // publishes the run status and then CLEARS executionStatusDeliveryId to
    // null after each pass. A guard latched on the delivery id therefore
    // re-opens on the next periodic reconciliation sweep and the terminal
    // run is rewritten with a fresh delivery id + updated_at (toast flood).
    // The once marker must live in result_json so it survives the
    // publish-and-clear cycle.
    const { run, runId } = await seedLegacyFailedRun();

    const first = await terminalizeLegacyExecution({
      db,
      run,
      status: "failed",
    });
    expect(first).not.toBeNull();
    const afterFirst = await db
      .select({
        executionStatusDeliveryId: heartbeatRuns.executionStatusDeliveryId,
        resultJson: heartbeatRuns.resultJson,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(afterFirst?.executionStatusDeliveryId).toBeTruthy();
    expect(
      (afterFirst?.resultJson as Record<string, unknown> | null)
        ?.executionTerminalizedAt,
    ).toEqual(expect.any(String));
    const updatedAtAfterFirst = afterFirst?.updatedAt.getTime();

    // Simulate deliverExecutionStatuses publishing and clearing the receipt.
    await db
      .update(heartbeatRuns)
      .set({ executionStatusDeliveryId: null })
      .where(eq(heartbeatRuns.id, runId));

    // The next periodic sweep re-terminalizes the same already-terminal run
    // with an empty patch. The result_json marker (not the delivery id) must
    // make this a no-op: no new delivery id, no updated_at bump.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await terminalizeLegacyExecution({
      db,
      run,
      status: "failed",
    });
    expect(second).toBeNull();

    const afterSecond = await db
      .select({
        executionStatusDeliveryId: heartbeatRuns.executionStatusDeliveryId,
        resultJson: heartbeatRuns.resultJson,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(afterSecond?.executionStatusDeliveryId).toBeNull();
    expect(afterSecond?.updatedAt.getTime()).toBe(updatedAtAfterFirst);
    expect(
      (afterSecond?.resultJson as Record<string, unknown> | null)
        ?.executionTerminalizedAt,
    ).toEqual(expect.any(String));

    const recoveryActionsAfterSecond = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions);
    expect(recoveryActionsAfterSecond).toHaveLength(1);
  });

  it("admits a second call when the caller carries a patch (status transition shape)", async () => {
    const { run, runId } = await seedLegacyFailedRun();

    const first = await terminalizeLegacyExecution({
      db,
      run,
      status: "failed",
    });
    expect(first).not.toBeNull();

    // Status-transition caller (heartbeat.ts line 12891/12975 carries a
    // patch). The guard admits the call because patch is non-empty, even
    // though executionStatusDeliveryId is already set.
    const second = await terminalizeLegacyExecution({
      db,
      run: { ...run, status: "running" },
      status: "cancelled",
      patch: { errorCode: "operator_interrupted" },
      fromStatuses: ["running"],
    });
    // The CAS rejects (status already failed), so the row is untouched
    // and the call returns null — but the important point is that the
    // guard did NOT pre-empt this call. To prove the guard admits the
    // shape, run with a status that DOES match fromStatuses on a
    // freshly-inserted row.
    const freshRow = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const third = await terminalizeLegacyExecution({
      db,
      run: freshRow,
      status: "cancelled",
      patch: { errorCode: "operator_interrupted" },
      fromStatuses: [freshRow.status],
    });
    // Third call does write because patch is set and CAS matches.
    expect(third).not.toBeNull();
  });
});