import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  activityLog,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

async function seedCompany(
  db: ReturnType<typeof createDb>,
  suffix: string,
) {
  const company = await db
    .insert(companies)
    .values({
      name: `Terminal Drain ${suffix} ${randomUUID()}`,
      issuePrefix: `TD${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: `owner-${randomUUID()}`,
    status: "active",
    membershipRole: "owner",
  });
  const agent = await db
    .insert(agents)
    .values({ companyId: company.id, name: `builder-${suffix}`, role: "engineer" })
    .returning()
    .then((rows) => rows[0]!);
  return { companyId: company.id, agentId: agent.id };
}

async function seedIssue(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
) {
  return db
    .insert(issues)
    .values({
      companyId,
      title: `Card ${randomUUID()}`,
      status: "in_progress",
      assigneeAgentId: agentId,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedWake(
  db: ReturnType<typeof createDb>,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
    runId?: string | null;
  },
) {
  return db
    .insert(agentWakeupRequests)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: input.issueId, mutation: "comment" },
      status: input.status,
      ...(input.runId ? { runId: input.runId } : {}),
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres(
  "SPA-11805 A2: terminal transition drains pending deferred wakes",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-terminal-drain-",
      );
      db = createDb(tempDb.connectionString);
    }, 30_000);

    afterEach(async () => {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(issueComments);
      await db.delete(issueWorkProducts);
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(companyMemberships);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    it("done_drains_deferred_and_queued_but_spares_claimed_and_running", async () => {
      const { companyId, agentId } = await seedCompany(db, "done");
      const issue = await seedIssue(db, companyId, agentId);

      const deferred = await seedWake(db, {
        companyId,
        agentId,
        issueId: issue.id,
        status: "deferred_issue_execution",
      });
      const queued = await seedWake(db, {
        companyId,
        agentId,
        issueId: issue.id,
        status: "queued",
      });
      // An unrelated issue's pending wake must survive the drain.
      const otherIssue = await seedIssue(db, companyId, agentId);
      const otherDeferred = await seedWake(db, {
        companyId,
        agentId,
        issueId: otherIssue.id,
        status: "deferred_issue_execution",
      });

      // Claimed/running rows belong to a live run: bind them to heartbeatRuns
      // so the drain's `runId IS NULL` guard must spare them.
      const liveRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "running",
        contextSnapshot: { issueId: issue.id },
      });
      const claimed = await seedWake(db, {
        companyId,
        agentId,
        issueId: issue.id,
        status: "claimed",
        runId: liveRunId,
      });
      const secondRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: secondRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "running",
        contextSnapshot: { issueId: issue.id },
      });
      const running = await seedWake(db, {
        companyId,
        agentId,
        issueId: issue.id,
        status: "running",
        runId: secondRunId,
      });

      const updated = await issueService(db).update(issue.id, {
        status: "done",
      });
      expect(updated?.status).toBe("done");

      const rows = await db
        .select({
          id: agentWakeupRequests.id,
          status: agentWakeupRequests.status,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      const byId = new Map(rows.map((row) => [row.id, row.status]));

      // POSITIVE controls of the drain.
      expect(byId.get(deferred.id)).toBe("cancelled");
      expect(byId.get(queued.id)).toBe("cancelled");
      // POSITIVE control that the drain does not kill live work.
      expect(byId.get(claimed.id)).toBe("claimed");
      expect(byId.get(running.id)).toBe("running");
      // POSITIVE control that the drain is issue-scoped.
      expect(byId.get(otherDeferred.id)).toBe("deferred_issue_execution");
    });

    it("cancelled_drains_pending_wakes_too", async () => {
      const { companyId, agentId } = await seedCompany(db, "cancelled");
      const issue = await seedIssue(db, companyId, agentId);
      const deferred = await seedWake(db, {
        companyId,
        agentId,
        issueId: issue.id,
        status: "deferred_issue_execution",
      });

      const updated = await issueService(db).update(issue.id, {
        status: "cancelled",
      });
      expect(updated?.status).toBe("cancelled");

      const [row] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.id, deferred.id),
            eq(agentWakeupRequests.companyId, companyId),
          ),
        );
      expect(row?.status).toBe("cancelled");
    });
  },
);
