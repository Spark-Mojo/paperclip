import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
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
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres done-transition enforcement tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

async function seedCompany(db: Db, label = "DoneTransition") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `DT${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning();
  return agent!;
}

async function seedRun(db: Db, companyId: string, agentId: string, issueId: string) {
  const [run] = await db.insert(heartbeatRuns).values({
    companyId,
    agentId,
    status: "running",
    contextSnapshot: { issueId },
  }).returning();
  return run!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    title: string;
    status?: string;
    assigneeAgentId?: string | null;
  },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentId: null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    responsibleUserId: "board-user",
  }).returning();
  return issue!;
}

async function blockIssue(db: Db, companyId: string, blockerIssueId: string, blockedIssueId: string) {
  await db.insert(issueRelations).values({
    companyId,
    issueId: blockerIssueId,
    relatedIssueId: blockedIssueId,
    type: "blocks",
  });
}

async function removeRelation(db: Db, blockerIssueId: string, blockedIssueId: string) {
  await db.delete(issueRelations).where(and(
    eq(issueRelations.issueId, blockerIssueId),
    eq(issueRelations.relatedIssueId, blockedIssueId),
    eq(issueRelations.type, "blocks"),
  ));
}

async function seedUserComment(
  db: Db,
  input: { companyId: string; issueId: string; clientRequestId: string; body: string },
) {
  const [comment] = await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    authorUserId: "board-user",
    authorType: "user",
    clientRequestId: input.clientRequestId,
    body: input.body,
  }).returning();
  return comment!;
}

async function commentCount(db: Db, issueId: string) {
  const rows = await db.select({ id: issueComments.id })
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId));
  return rows.length;
}

async function readIssue(app: express.Express, issueId: string) {
  const res = await request(app).get(`/api/issues/${issueId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    status: string;
    completedAt: string | null;
    blockedBy?: Array<{ id: string; status: string }>;
  };
}

function sortedBlockerIds(readback: Awaited<ReturnType<typeof readIssue>>) {
  return (readback.blockedBy ?? []).map((blocker) => blocker.id).sort();
}

// receipt-close-contract §1: expectedState = {status:'done', blockers:[{issueId,status}]}
function closeBody(declaredBlockers: Array<{ issueId: string; status: string }>, comment: string) {
  return {
    status: "done",
    comment,
    expectedState: {
      status: "done",
      blockers: declaredBlockers,
    },
  };
}

describeEmbeddedPostgres("issues done transition enforcement (receipt-close contract)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // 30s mirrors vitest.config.ts hookTimeout: embedded-postgres boot needs
  // the same headroom under a loaded shard; a tighter cap can flake the hook.
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-done-transition-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    // Status-update routes write activity_log rows that reference the run;
    // clear them before the runs or the delete violates the FK.
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("S1a refuses close with blockerMismatch when a blocker was added after the actor read the card", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const card = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Actor card (added blocker)",
      assigneeAgentId: agent.id,
    });
    const blockerB1 = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Blocker B1",
    });
    await blockIssue(db, company.id, blockerB1.id, card.id);
    const run = await seedRun(db, company.id, agent.id, card.id);
    const app = createApp(db, agentActor(company, agent, run.id));

    // Actor reads the card and declares exactly what it saw.
    const readbackBefore = await readIssue(app, card.id);
    expect(readbackBefore.status).toBe("todo");
    const declared = (readbackBefore.blockedBy ?? []).map((blocker) => ({
      issueId: blocker.id,
      status: blocker.status,
    }));
    expect(declared).toEqual([{ issueId: blockerB1.id, status: "todo" }]);

    // Concurrent writer adds B2 between the read and the close.
    const blockerB2 = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Blocker B2 (late)",
    });
    await blockIssue(db, company.id, blockerB2.id, card.id);
    const blockersAtPatchTime = sortedBlockerIds(await readIssue(app, card.id));
    const commentsBefore = await commentCount(db, card.id);

    const res = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send(closeBody(declared, "closing on stale read: B2 appeared"));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("blockerMismatch");

    // Refused close must not have touched the card.
    const readbackAfter = await readIssue(app, card.id);
    expect(readbackAfter.status).toBe("todo");
    expect(readbackAfter.completedAt).toBeNull();
    expect(await commentCount(db, card.id)).toBe(commentsBefore);
    // The close must not mutate relations: live set is exactly what the writer left behind.
    expect(sortedBlockerIds(readbackAfter)).toEqual(blockersAtPatchTime);
    expect(sortedBlockerIds(readbackAfter)).toContain(blockerB1.id);
  }, 30_000);

  it("S1b refuses close with blockerMismatch when a declared blocker's own status changed after the read", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const card = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Actor card (blocker status drift)",
      assigneeAgentId: agent.id,
    });
    const blockerB1 = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Blocker B1",
    });
    await blockIssue(db, company.id, blockerB1.id, card.id);
    const run = await seedRun(db, company.id, agent.id, card.id);
    const app = createApp(db, agentActor(company, agent, run.id));

    const readbackBefore = await readIssue(app, card.id);
    const declared = (readbackBefore.blockedBy ?? []).map((blocker) => ({
      issueId: blocker.id,
      status: blocker.status,
    }));
    expect(declared).toEqual([{ issueId: blockerB1.id, status: "todo" }]);

    // Concurrent writer moves only B1's own status.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, blockerB1.id));
    const blockersAtPatchTime = sortedBlockerIds(await readIssue(app, card.id));
    const commentsBefore = await commentCount(db, card.id);

    const res = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send(closeBody(declared, "closing on stale read: B1 moved on"));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("blockerMismatch");

    const readbackAfter = await readIssue(app, card.id);
    expect(readbackAfter.status).toBe("todo");
    expect(readbackAfter.completedAt).toBeNull();
    expect(await commentCount(db, card.id)).toBe(commentsBefore);
    expect(sortedBlockerIds(readbackAfter)).toEqual(blockersAtPatchTime);
  }, 30_000);

  it("S1c refuses close with blockerMismatch when a declared blocker was removed after the read", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const card = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Actor card (removed blocker)",
      assigneeAgentId: agent.id,
    });
    const blockerB1 = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Blocker B1",
    });
    await blockIssue(db, company.id, blockerB1.id, card.id);
    const run = await seedRun(db, company.id, agent.id, card.id);
    const app = createApp(db, agentActor(company, agent, run.id));

    const readbackBefore = await readIssue(app, card.id);
    const declared = (readbackBefore.blockedBy ?? []).map((blocker) => ({
      issueId: blocker.id,
      status: blocker.status,
    }));
    expect(declared).toEqual([{ issueId: blockerB1.id, status: "todo" }]);

    // Concurrent writer removes B1 entirely.
    await removeRelation(db, blockerB1.id, card.id);
    const blockersAtPatchTime = sortedBlockerIds(await readIssue(app, card.id));
    const commentsBefore = await commentCount(db, card.id);

    const res = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send(closeBody(declared, "closing on stale read: B1 gone"));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("blockerMismatch");

    const readbackAfter = await readIssue(app, card.id);
    expect(readbackAfter.status).toBe("todo");
    expect(readbackAfter.completedAt).toBeNull();
    expect(await commentCount(db, card.id)).toBe(commentsBefore);
    expect(sortedBlockerIds(readbackAfter)).toEqual(blockersAtPatchTime);
    expect(sortedBlockerIds(readbackAfter)).not.toContain(blockerB1.id);
  }, 30_000);

  it("S2 commits close when the declared blocker set matches live state exactly (vehicle)", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const card = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Actor card (vehicle)",
      assigneeAgentId: agent.id,
    });
    const blockerB1 = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Open blocker B1",
    });
    await blockIssue(db, company.id, blockerB1.id, card.id);
    const run = await seedRun(db, company.id, agent.id, card.id);
    const app = createApp(db, agentActor(company, agent, run.id));

    const readbackBefore = await readIssue(app, card.id);
    const declared = (readbackBefore.blockedBy ?? []).map((blocker) => ({
      issueId: blocker.id,
      status: blocker.status,
    }));
    expect(declared).toEqual([{ issueId: blockerB1.id, status: "todo" }]);
    const blockedByBefore = readbackBefore.blockedBy ?? [];

    const res = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send(closeBody(declared, "closing with an exact declaration"));

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const readbackAfter = await readIssue(app, card.id);
    expect(readbackAfter.status).toBe("done");
    expect(readbackAfter.completedAt).not.toBeNull();
    // Exactly one receipt comment for the close.
    expect(await commentCount(db, card.id)).toBe(1);
    // Closing must not alter the relation set.
    expect(readbackAfter.blockedBy ?? []).toEqual(blockedByBefore);
  }, 30_000);

  it("S3i commits a plain no-input done close exactly as base does", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const card = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Actor card (plain close)",
      assigneeAgentId: agent.id,
    });
    const run = await seedRun(db, company.id, agent.id, card.id);
    const app = createApp(db, agentActor(company, agent, run.id));

    const res = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send({ status: "done", comment: "plain close without expectedState" });

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const readback = await readIssue(app, card.id);
    expect(readback.status).toBe("done");
    expect(readback.completedAt).not.toBeNull();
    expect(await commentCount(db, card.id)).toBe(1);
  }, 30_000);

  it("S3ii keeps the base P2 shape: comment clientRequestId conflict 409s after the status already committed", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const card = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "User card (P2 conflict shape)",
    });
    const app = createApp(db, boardActor(company));
    const reusedRequestId = randomUUID();
    await seedUserComment(db, {
      companyId: company.id,
      issueId: card.id,
      clientRequestId: reusedRequestId,
      body: "original turn content",
    });
    const commentsBefore = await commentCount(db, card.id);

    const res = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send({
        status: "done",
        comment: "different content under the same request id",
        commentClientRequestId: reusedRequestId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // Base P2 shape: the refusal comes after the status write already committed.
    const readback = await readIssue(app, card.id);
    expect(readback.status).toBe("done");
    expect(readback.completedAt).not.toBeNull();
    expect(await commentCount(db, card.id)).toBe(commentsBefore);
  }, 30_000);

  it("S4b rolls back the done write when the receipt comment conflicts under a carried expectedState", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const card = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "User card (rollback)",
    });
    const app = createApp(db, boardActor(company));
    const reusedRequestId = randomUUID();
    await seedUserComment(db, {
      companyId: company.id,
      issueId: card.id,
      clientRequestId: reusedRequestId,
      body: "original turn content",
    });
    const commentsBefore = await commentCount(db, card.id);

    const res = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send({
        status: "done",
        comment: "different content under the same request id",
        commentClientRequestId: reusedRequestId,
        expectedState: { status: "done", blockers: [] },
      });

    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    // Verified base shape: the P2 comment-dedupe conflict is a bare HttpError
    // with no details, and errorHandler only emits `reason` for skill-policy
    // denials and workspace-repair preconditions — so the 409 body carries no
    // `reason`. A hypothetical contract refusal of every expectedState write
    // would answer with its own refusal shape and must not satisfy S4b; the
    // S2 joint pinning (exact declaration MUST commit) carries the rest of
    // the non-vacuousness.
    expect(res.body.reason).toBeUndefined();

    // Contract §2: input present ⇒ the whole write is one transaction; the
    // comment conflict must roll the status write back.
    const readback = await readIssue(app, card.id);
    expect(readback.status).not.toBe("done");
    expect(readback.completedAt).toBeNull();
    expect(await commentCount(db, card.id)).toBe(commentsBefore);
  }, 30_000);

  it("S4c refuses a repeat close with alreadyClosed and leaves completedAt byte-identical", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const card = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Actor card (repeat close)",
      assigneeAgentId: agent.id,
    });
    const run = await seedRun(db, company.id, agent.id, card.id);
    const app = createApp(db, agentActor(company, agent, run.id));

    const readbackBefore = await readIssue(app, card.id);
    const declared = (readbackBefore.blockedBy ?? []).map((blocker) => ({
      issueId: blocker.id,
      status: blocker.status,
    }));

    const first = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send(closeBody(declared, "first close"));
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const readbackAfterFirst = await readIssue(app, card.id);
    expect(readbackAfterFirst.status).toBe("done");
    expect(readbackAfterFirst.completedAt).not.toBeNull();
    const commentsAfterFirst = await commentCount(db, card.id);
    expect(commentsAfterFirst).toBe(1);

    const second = await request(app)
      .patch(`/api/issues/${card.id}`)
      .send(closeBody(declared, "second close of an already-closed card"));

    expect(second.status, JSON.stringify(second.body)).toBeGreaterThanOrEqual(400);
    expect(second.body.reason).toBe("alreadyClosed");
    // No duplicate receipt comment, and completedAt is untouched by the repeat.
    expect(await commentCount(db, card.id)).toBe(commentsAfterFirst);
    const readbackAfterSecond = await readIssue(app, card.id);
    expect(readbackAfterSecond.completedAt).toBe(readbackAfterFirst.completedAt);
  }, 30_000);
});
