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
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SPA-9282 terminal-rewrite tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("SPA-9282 — terminal run rows are not rewritten every sweep tick", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-9282-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTerminalRunWithQuotaError(input: {
    issueStatus: "todo" | "in_progress" | "in_review";
    errorText: string;
    agentName: string;
  }) {
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
        name: `${input.agentName} Manager`,
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
        name: input.agentName,
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "failed",
      errorCode: "adapter_failed",
      error: input.errorText,
      // SPA-9282 seeds the run with the bootstrap evidence the recovery
      // sweep needs so the legacy-execution reconcile path is bypassed
      // and the provider-quota / configuration_incomplete classifier is
      // reached. Without this, a null executionRecovery causes the
      // sweep to escalate as legacy and never persist a classification.
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      startedAt: new Date("2026-09-20T12:00:00.000Z"),
      finishedAt: new Date("2026-09-20T12:00:30.000Z"),
      processPid: 4242,
      processGroupId: 4242,
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: `SPA-9282 ${input.agentName} adapter failure`,
      status: input.issueStatus,
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `SPA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    return { companyId, managerId, agentId, sourceIssueId, runId };
  }

  async function readRunShape(runId: string) {
    return db
      .select({
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
        processPid: heartbeatRuns.processPid,
        processGroupId: heartbeatRuns.processGroupId,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
  }

  it("writes the provider_quota classification exactly once and leaves updated_at unchanged on subsequent sweeps", async () => {
    const { runId } = await seedTerminalRunWithQuotaError({
      issueStatus: "in_progress",
      errorText:
        "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      agentName: "Steve",
    });

    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileStrandedAssignedIssues();
    expect(first.providerQuotaMonitored).toBe(1);

    const afterFirst = await readRunShape(runId);
    expect(afterFirst?.errorCode).toBe("provider_quota");
    expect(afterFirst?.processPid).toBeNull();
    expect(afterFirst?.processGroupId).toBeNull();
    expect(afterFirst?.resultJson?.recoveryClassification).toBe("provider_quota");
    expect(afterFirst?.resultJson?.retryNotBefore).toBeTruthy();
    const updatedAtAfterFirst = afterFirst?.updatedAt.getTime();

    // Sleep 25ms so a real rewrite would move updated_at. The guard must
    // recognize the no-op and skip the write entirely.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await heartbeat.reconcileStrandedAssignedIssues();
    // The second sweep finds nothing new to do — providerQuotaMonitored
    // must NOT re-increment, the issue has the armed monitor so the
    // sweep short-circuits before re-classifying.
    expect(second.providerQuotaMonitored).toBe(0);

    const afterSecond = await readRunShape(runId);
    expect(afterSecond?.errorCode).toBe("provider_quota");
    expect(afterSecond?.processPid).toBeNull();
    expect(afterSecond?.processGroupId).toBeNull();
    expect(afterSecond?.resultJson?.recoveryClassification).toBe("provider_quota");
    expect(afterSecond?.updatedAt.getTime()).toBe(updatedAtAfterFirst);
  });

  it("persists a configuration_incomplete classification exactly once and stops re-writing the row", async () => {
    const { runId } = await seedTerminalRunWithQuotaError({
      issueStatus: "in_progress",
      errorText: "model_not_found: requested model does not exist",
      agentName: "Argus",
    });

    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileStrandedAssignedIssues();
    expect(first.escalated).toBe(1);

    const afterFirst = await readRunShape(runId);
    expect(afterFirst?.errorCode).toBe("configuration_incomplete");
    expect(afterFirst?.processPid).toBeNull();
    expect(afterFirst?.resultJson?.recoveryClassification).toBe("configuration_incomplete");
    const updatedAtAfterFirst = afterFirst?.updatedAt.getTime();

    await new Promise((resolve) => setTimeout(resolve, 25));

    // Subsequent sweep — same shape must short-circuit. The first escalation
    // minted a source-scoped recovery action, and the issue is now flagged
    // stranded. Either path the loop takes, the heartbeat_runs row must NOT
    // be re-written (the bug under test).
    await heartbeat.reconcileStrandedAssignedIssues();

    const afterSecond = await readRunShape(runId);
    expect(afterSecond?.errorCode).toBe("configuration_incomplete");
    expect(afterSecond?.processPid).toBeNull();
    expect(afterSecond?.updatedAt.getTime()).toBe(updatedAtAfterFirst);
  });
});