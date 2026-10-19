import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  executionWorkspaces,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>) {
  const company = await db
    .insert(companies)
    .values({
      name: `Escalation Guard ${randomUUID()}`,
      issuePrefix: `EG${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    });
  return company;
}

async function createCard(
  db: ReturnType<typeof createDb>,
  companyId: string,
  overrides: Partial<typeof issues.$inferInsert> = {},
) {
  return db
    .insert(issues)
    .values({
      companyId,
      title: `Card ${randomUUID()}`,
      status: "in_progress",
      ...overrides,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function attachCommitReceipt(
  db: ReturnType<typeof createDb>,
  issue: { id: string; companyId: string },
) {
  await db.insert(issueWorkProducts).values({
    companyId: issue.companyId,
    issueId: issue.id,
    type: "commit",
    provider: "github",
    title: "Commit 9c12ae7",
    url: "https://github.com/paperclipai/paperclip/commit/9c12ae7b41e5",
    status: "open",
  });
}

describeEmbeddedPostgres("issue done gate — escalation close-guard (SPA-13737)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-escalation-guard-");
    db = createDb(tempDb.connectionString);
    const company = await createCompany(db);
    companyId = company.id;
    const agent = await db
      .insert(agents)
      .values({ companyId, name: `builder-${randomUUID().slice(0, 8)}`, role: "engineer" })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
    await db.delete(issueWorkProducts);
    await db.delete(activityLog);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("refuses done for stranded_issue_recovery without an action receipt", async () => {
    const card = await createCard(db, companyId, {
      assigneeAgentId: agentId,
      originKind: "stranded_issue_recovery",
    });
    await expect(
      issueService(db).update(card.id, { status: "done" }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "issue_done_without_escalation_receipt" },
    });
    const after = await db.select().from(issues).where(eq(issues.id, card.id)).then((rows) => rows[0]!);
    expect(after.status).toBe("in_progress");
  });

  it("allows done for stranded_issue_recovery with a commit receipt", async () => {
    const card = await createCard(db, companyId, {
      assigneeAgentId: agentId,
      originKind: "stranded_issue_recovery",
    });
    await attachCommitReceipt(db, card);
    const updated = await issueService(db).update(card.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("refuses done for harness_liveness_escalation without an action receipt", async () => {
    const card = await createCard(db, companyId, {
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
    });
    await expect(
      issueService(db).update(card.id, { status: "done" }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "issue_done_without_escalation_receipt" },
    });
    const after = await db.select().from(issues).where(eq(issues.id, card.id)).then((rows) => rows[0]!);
    expect(after.status).toBe("in_progress");
  });

  it("non-escalation card without a receipt closes cleanly", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    const updated = await issueService(db).update(card.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("refuses done for escalation card with doneGateBypass and no receipt", async () => {
    const card = await createCard(db, companyId, {
      assigneeAgentId: agentId,
      originKind: "stranded_issue_recovery",
    });
    await expect(
      issueService(db).update(card.id, { status: "done", doneGateBypass: true }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "issue_done_without_escalation_receipt" },
    });
    const after = await db.select().from(issues).where(eq(issues.id, card.id)).then((rows) => rows[0]!);
    expect(after.status).toBe("in_progress");
  });

  it("allows done for escalation card with board doneGateOverride and no receipt", async () => {
    const card = await createCard(db, companyId, {
      assigneeAgentId: agentId,
      originKind: "stranded_issue_recovery",
    });
    const updated = await issueService(db).update(card.id, {
      status: "done",
      doneGateOverride: {
        reason: "Board reviewed the stranded recovery and waived the receipt",
        actorType: "board",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(updated?.status).toBe("done");
  });

  it("refuses done for manual Escalation-titled card without a receipt (SPA-13683 shape)", async () => {
    const card = await createCard(db, companyId, {
      assigneeAgentId: agentId,
      originKind: "manual",
      title: "Escalation: SPA-13683 stuck waiting on blocked",
    });
    await expect(
      issueService(db).update(card.id, { status: "done" }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "issue_done_without_escalation_receipt", signal: "title-fallback" },
    });
    const after = await db.select().from(issues).where(eq(issues.id, card.id)).then((rows) => rows[0]!);
    expect(after.status).toBe("in_progress");
  });

  it("allows done for manual Escalation-titled card with a commit receipt", async () => {
    const card = await createCard(db, companyId, {
      assigneeAgentId: agentId,
      originKind: "manual",
      title: "Escalation: SPA-13683 stuck waiting on blocked",
    });
    await attachCommitReceipt(db, card);
    const updated = await issueService(db).update(card.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("allows done for plain manual card with non-escalation title and no receipt", async () => {
    const card = await createCard(db, companyId, {
      assigneeAgentId: agentId,
      originKind: "manual",
      title: "Routine follow-up work",
    });
    const updated = await issueService(db).update(card.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("allows done for non-escalation card with doneGateBypass and no receipt", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    const updated = await issueService(db).update(card.id, { status: "done", doneGateBypass: true });
    expect(updated?.status).toBe("done");
  });
});
