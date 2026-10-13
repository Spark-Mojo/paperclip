import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityService } from "../services/activity.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type ActivityService = ReturnType<typeof activityService>;
type IssueRun = Awaited<ReturnType<ActivityService["runsForIssue"]>>[number];

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForIssueRun(
  service: ActivityService,
  companyId: string,
  issueId: string,
  predicate: (run: IssueRun) => boolean,
) {
  const deadline = Date.now() + 2_000;
  let latestRuns: IssueRun[] = [];
  while (Date.now() < deadline) {
    latestRuns = await service.runsForIssue(companyId, issueId);
    const run = latestRuns.find(predicate);
    if (run) return { run, runs: latestRuns };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for issue run. Latest run count: ${latestRuns.length}`);
}

async function waitForEligibleStampPlateau(
  db: ReturnType<typeof createDb>,
  eligibleRunIds: Set<string>,
  deadlineMs = 15_000,
): Promise<number> {
  const stampedCount = async () => {
    const rows = await db.select().from(heartbeatRuns);
    return rows.filter((row) => eligibleRunIds.has(row.id) && row.livenessState !== null).length;
  };
  let previous = await stampedCount();
  let stableReads = 0;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline && stableReads < 3) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const current = await stampedCount();
    if (current === previous) {
      stableReads += 1;
    } else {
      stableReads = 0;
      previous = current;
    }
  }
  return previous;
}

describeEmbeddedPostgres("activity service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("limits company activity lists", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.oldest",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.middle",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.newest",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T12:00:00.000Z"),
      },
    ]);

    const result = await activityService(db).list({ companyId, limit: 2 });

    expect(result.map((event) => event.action)).toEqual(["test.newest", "test.middle"]);
  });

  it("returns compact usage and result summaries for issue runs", async () => {
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
      status: "succeeded",
      contextSnapshot: { issueId },
      usageJson: {
        inputTokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        billingType: "metered",
        costUsd: 0.42,
        enormousBlob: "x".repeat(256_000),
      },
      resultJson: {
        conversationReset: true,
        billing_type: "metered",
        total_cost_usd: 0.42,
        stopReason: "timeout",
        effectiveTimeoutSec: 30,
        timeoutFired: true,
        summary: "done",
        nestedHuge: { payload: "y".repeat(256_000) },
      },
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });

    const runs = await activityService(db).runsForIssue(companyId, issueId);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId,
      agentId,
      invocationSource: "assignment",
      contextIssueId: issueId,
    });
    expect(runs[0]?.usageJson).toEqual({
      inputTokens: 11,
      input_tokens: 11,
      outputTokens: 7,
      output_tokens: 7,
      cachedInputTokens: 3,
      cached_input_tokens: 3,
      cache_read_input_tokens: 3,
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
    });
    expect(runs[0]?.resultJson).toEqual({
      conversationReset: true,
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutFired: true,
    });
    expect(runs[0]).toMatchObject({
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });
    expect(runs[0]).not.toHaveProperty("contextSnapshot");
  });

  it("coalesces repeated legacy backfill scans and picks up new terminal runs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Read ledger",
      description: "Read repeatedly",
      status: "in_progress",
      priority: "medium",
    });
    const queries: string[] = [];
    const observedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "select") {
          return (...args: Parameters<typeof db.select>) => {
            const query = db.select(...args);
            const originalFrom = query.from.bind(query);
            query.from = ((table: Parameters<typeof query.from>[0]) => {
              if (table === heartbeatRuns) queries.push("heartbeatRuns");
              return originalFrom(table);
            }) as typeof query.from;
            return query;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const service = activityService(observedDb);
    await Promise.all(Array.from({ length: 5 }, () => service.runsForIssue(companyId, issueId)));
    expect(queries).toHaveLength(5);

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId },
      livenessState: null,
    });
    await waitForIssueRun(service, companyId, issueId, (run) => run.runId === runId && run.livenessState !== null);
  });

  it("drains every eligible run across batches when more than twenty legacy runs lack liveness", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const BATCH_BOUND = 20;
    const ELIGIBLE = 47;

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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Drain the legacy ledger",
      description: "More un-backfilled runs than one bounded batch can take.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const baseCreatedAt = new Date("2026-04-18T21:00:00.000Z");
    const eligibleRunIds = new Set<string>();
    const tiedRunIds: string[] = [];

    const eligibleRows = Array.from({ length: ELIGIBLE }, (_unused, index) => {
      const id = randomUUID();
      eligibleRunIds.add(id);
      const createdAt = index < 3
        ? baseCreatedAt
        : new Date(baseCreatedAt.getTime() + (index - 2) * 1_000);
      if (index < 3) tiedRunIds.push(id);
      return {
        id,
        companyId,
        agentId,
        invocationSource: "assignment" as const,
        status: "succeeded" as const,
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 1_000),
        createdAt,
        contextSnapshot: { issueId },
        resultJson: { summary: "Next steps:\n- inspect files" },
        livenessState: null,
        livenessReason: null,
      };
    });

    const ineligibleRows = [
      {
        id: randomUUID(),
        status: "running" as const,
        contextIssueId: issueId,
        livenessState: null,
      },
      {
        id: randomUUID(),
        status: "queued" as const,
        contextIssueId: issueId,
        livenessState: null,
      },
      {
        id: randomUUID(),
        status: "succeeded" as const,
        contextIssueId: issueId,
        livenessState: "advanced" as const,
      },
      {
        id: randomUUID(),
        status: "succeeded" as const,
        contextIssueId: issueId,
        livenessState: "plan_only" as const,
      },
      {
        id: randomUUID(),
        status: "succeeded" as const,
        contextIssueId: randomUUID(),
        livenessState: null,
      },
      {
        id: randomUUID(),
        status: "succeeded" as const,
        contextIssueId: null,
        livenessState: null,
      },
    ].map((row, index) => {
      const createdAt = new Date(baseCreatedAt.getTime() + (index - 2) * 500);
      return {
        id: row.id,
        companyId,
        agentId,
        invocationSource: "assignment" as const,
        status: row.status,
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 1_000),
        createdAt,
        contextSnapshot:
          row.contextIssueId === null ? { taskId: randomUUID() } : { issueId: row.contextIssueId },
        resultJson: { summary: "Finished." },
        livenessState: row.livenessState,
        livenessReason: row.livenessState === null ? null : "pre-existing",
      };
    });

    await db.insert(heartbeatRuns).values([...eligibleRows, ...ineligibleRows]);

    const service = activityService(db);

    expect(eligibleRunIds.size).toBe(ELIGIBLE);
    const pending = new Set(eligibleRunIds);
    let reads = 0;
    let firstReadStamped = 0;
    const missingFromAnyRead: string[] = [];
    const pendingEligibleCounts: number[] = [];
    while (pending.size > 0 && reads < 60) {
      reads += 1;
      const runs = await service.runsForIssue(companyId, issueId);
      const returnedIds = new Set(runs.map((run) => run.runId));
      for (const id of eligibleRunIds) {
        if (!returnedIds.has(id)) missingFromAnyRead.push(id);
      }
      pendingEligibleCounts.push(
        runs.filter((run) => pending.has(run.runId) && run.livenessState === null).length,
      );
      if (reads === 1) {
        firstReadStamped = await waitForEligibleStampPlateau(db, eligibleRunIds);
      }
      for (const run of runs) {
        if (pending.has(run.runId) && run.livenessState !== null) {
          pending.delete(run.runId);
        }
      }
      if (pending.size === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(missingFromAnyRead).toEqual([]);
    expect(pending).toEqual(new Set());
    expect(reads).toBeGreaterThan(1);
    expect(pendingEligibleCounts[0]).toBe(ELIGIBLE);
    expect(firstReadStamped).toBe(BATCH_BOUND);
    expect(Math.min(...pendingEligibleCounts)).toBeLessThanOrEqual(BATCH_BOUND);

    const persisted = await db.select().from(heartbeatRuns);
    const byId = new Map(persisted.map((row) => [row.id, row]));
    for (const id of eligibleRunIds) {
      expect(byId.get(id)).toMatchObject({
        id,
        livenessState: "plan_only",
        livenessReason: "Run described runnable future work without concrete action evidence",
        lastUsefulActionAt: null,
      });
    }
    expect(tiedRunIds.length).toBe(3);
    for (const id of tiedRunIds) {
      expect(byId.get(id)?.livenessState).toBe("plan_only");
    }

    const untouched = new Map(ineligibleRows.map((row) => [row.id, row]));
    for (const [id, original] of untouched) {
      expect(byId.get(id)?.livenessState).toBe(original.livenessState);
    }
    const stampedEligible = [...eligibleRunIds].filter(
      (id) => byId.get(id)?.livenessState === "plan_only",
    );
    expect(stampedEligible).toHaveLength(ELIGIBLE);
    expect(eligibleRunIds.size).toBe(ELIGIBLE);
  }, 60_000);

  it("processes runs that fall outside the first bounded batch on the next read", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const FIRST_BATCH = 20;
    const LATER = 5;

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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Later work must survive the bound",
      description: "Runs beyond the bounded head are still eligible.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const newestCreatedAt = new Date("2026-04-18T22:00:00.000Z");
    const olderCreatedAt = new Date("2026-04-18T21:00:00.000Z");
    const makeRun = (id: string, createdAt: Date) => ({
      id,
      companyId,
      agentId,
      invocationSource: "assignment" as const,
      status: "succeeded" as const,
      startedAt: createdAt,
      finishedAt: new Date(createdAt.getTime() + 1_000),
      createdAt,
      contextSnapshot: { issueId },
      resultJson: { summary: "Next steps:\n- inspect files" },
      livenessState: null,
      livenessReason: null,
    });

    const headRunIds = Array.from({ length: FIRST_BATCH }, () => randomUUID());
    const laterRunIds = Array.from({ length: LATER }, () => randomUUID());
    await db.insert(heartbeatRuns).values([
      ...headRunIds.map((id, index) =>
        makeRun(id, new Date(newestCreatedAt.getTime() - index * 1_000)),
      ),
      ...laterRunIds.map((id, index) =>
        makeRun(id, new Date(olderCreatedAt.getTime() - index * 1_000)),
      ),
    ]);

    const service = activityService(db);
    const allRunIds = [...headRunIds, ...laterRunIds];
    const missingFromAnyRead: string[] = [];

    let headDone = false;
    for (let attempt = 0; attempt < 60 && !headDone; attempt += 1) {
      const runs = await service.runsForIssue(companyId, issueId);
      const returnedIds = new Set(runs.map((entry) => entry.runId));
      for (const id of allRunIds) {
        if (!returnedIds.has(id)) missingFromAnyRead.push(id);
      }
      const stampedHead = headRunIds.filter((id) => {
        const run = runs.find((entry) => entry.runId === id);
        return run?.livenessState !== null && run?.livenessState !== undefined;
      });
      headDone = stampedHead.length === headRunIds.length;
      if (!headDone) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(headDone).toBe(true);
    expect(missingFromAnyRead).toEqual([]);

    let laterDone = false;
    for (let attempt = 0; attempt < 60 && !laterDone; attempt += 1) {
      const runs = await service.runsForIssue(companyId, issueId);
      const returnedIds = new Set(runs.map((entry) => entry.runId));
      for (const id of allRunIds) {
        if (!returnedIds.has(id)) missingFromAnyRead.push(id);
      }
      const stampedLater = laterRunIds.filter((id) => {
        const run = runs.find((entry) => entry.runId === id);
        return run?.livenessState !== null && run?.livenessState !== undefined;
      });
      laterDone = stampedLater.length === laterRunIds.length;
      if (!laterDone) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(laterDone).toBe(true);
    expect(missingFromAnyRead).toEqual([]);

    const finalRows = await db.select().from(heartbeatRuns);
    const finalById = new Map(finalRows.map((row) => [row.id, row]));
    for (const id of laterRunIds) {
      expect(finalById.get(id)).toMatchObject({
        id,
        livenessState: "plan_only",
        livenessReason: "Run described runnable future work without concrete action evidence",
      });
    }
    for (const id of headRunIds) {
      expect(finalById.get(id)?.livenessState).toBe("plan_only");
    }
  }, 60_000);

  it("backfills missing liveness for completed issue runs before returning the ledger", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const completedAt = new Date("2026-04-18T20:04:00.000Z");

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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:00:00.000Z"),
      finishedAt: completedAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Finished the implementation.",
      },
      livenessState: null,
      livenessReason: null,
      lastUsefulActionAt: null,
      nextAction: null,
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Done",
      createdAt: completedAt,
    });

    const service = activityService(db);
    const { run, runs } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "completed",
    );

    expect(runs).toHaveLength(1);
    expect(run).toMatchObject({
      runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });

    const [persisted] = await db.select().from(heartbeatRuns);
    expect(persisted).toMatchObject({
      id: runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });
  });

  it("does not backfill document evidence from a different run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:08:00.000Z");

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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:00:00.000Z"),
        finishedAt: new Date("2026-04-18T20:02:00.000Z"),
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Next steps:\n- inspect files",
        },
        livenessState: null,
        livenessReason: null,
      },
      {
        id: otherRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:05:00.000Z"),
        finishedAt: createdAt,
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Updated the plan document.",
        },
        livenessState: "advanced",
        livenessReason: "Run produced concrete action evidence: 1 document revision(s)",
      },
    ]);

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "# Plan\n\n- Inspect files",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "# Plan\n\n- Inspect files",
      createdByAgentId: agentId,
      createdByRunId: otherRunId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described runnable future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });

  it("does not treat continuation summary revisions as concrete backfill evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:12:00.000Z");

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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:10:00.000Z"),
      finishedAt: createdAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Next steps:\n- inspect files",
      },
      livenessState: null,
      livenessReason: null,
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: "# Continuation Summary",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Continuation Summary",
      createdByAgentId: agentId,
      createdByRunId: runId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described runnable future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });
});
