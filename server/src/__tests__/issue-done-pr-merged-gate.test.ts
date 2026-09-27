import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { issueDoneGateService } from "../services/issue-done-gate.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import type { PullRequestMergeDetails } from "../services/github-pull-request-merge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OWNER_REPO = { owner: "Spark-Mojo", repo: "paperclip" } as const;

function prReference(number: number) {
  return { host: "github.com" as const, ...OWNER_REPO, number };
}

function details(state: PullRequestMergeDetails["state"], workProductState?: PullRequestMergeDetails["workProductState"]): PullRequestMergeDetails {
  return {
    state,
    headRef: null,
    headSha: null,
    ...(workProductState ? { workProductState } : {}),
  };
}

async function createCompany(db: ReturnType<typeof createDb>) {
  const company = await db
    .insert(companies)
    .values({
      name: `Done Gate ${randomUUID()}`,
      issuePrefix: `DG${randomUUID().slice(0, 6).toUpperCase()}`,
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

async function attachPullRequestWorkProduct(
  db: ReturnType<typeof createDb>,
  issue: { id: string; companyId: string },
  number: number,
) {
  await db.insert(issueWorkProducts).values({
    companyId: issue.companyId,
    issueId: issue.id,
    type: "pull_request",
    provider: "github",
    title: `PR ${number}`,
    url: `https://github.com/${OWNER_REPO.owner}/${OWNER_REPO.repo}/pull/${number}`,
    status: "open",
  });
}

describeEmbeddedPostgres("issue done gate — unmerged PR refuses done (SPA-8957)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-done-gate-");
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
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("done_refused_unmerged_pr: a card with an open PR cannot reach done", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    await attachPullRequestWorkProduct(db, card, 4242);

    // Production resolver (no GitHub credentials in the test environment)
    // fails closed to "unknown" — still a refusal, same 409 shape.
    await expect(
      issueService(db).update(card.id, { status: "done" }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "issue_done_with_unmerged_pull_request",
        pullRequests: [expect.objectContaining({ number: 4242 })],
      },
    });

    const after = await db.select().from(issues).where(eq(issues.id, card.id)).then((rows) => rows[0]!);
    expect(after.status).toBe("in_progress");

    // With the resolver seam pinned to a genuinely open PR, the refusal names
    // the open state explicitly.
    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => details("open", "open"),
    });
    const decision = await gate.evaluateDoneGate({ id: card.id, companyId });
    expect(decision).toMatchObject({
      outcome: "refuse",
      reason: {
        kind: "open_pull_requests",
        pullRequests: [expect.objectContaining({ state: "open", reference: expect.objectContaining({ number: 4242 }) })],
      },
    });
  });

  it("done_allowed_without_pr: control card with no PR closes cleanly", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    const updated = await issueService(db).update(card.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("done_allowed_merged_pr: merged PR closes cleanly", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    await attachPullRequestWorkProduct(db, card, 4243);
    // The default resolver hits GitHub in production; this test pins the
    // decision surface with the test seam instead of the update path.
    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => details("merged"),
    });
    const decision = await gate.evaluateDoneGate({ id: card.id, companyId });
    expect(decision).toEqual({ outcome: "allow" });
  });

  it("closed_refused_pr does not block: a refused PR is a human signal", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    await attachPullRequestWorkProduct(db, card, 4244);
    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => details("open", "closed"),
    });
    const decision = await gate.evaluateDoneGate({ id: card.id, companyId });
    expect(decision).toEqual({ outcome: "allow" });
  });

  it("unknown state is fail-closed", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    await attachPullRequestWorkProduct(db, card, 4245);
    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => details("unknown"),
    });
    const decision = await gate.evaluateDoneGate({ id: card.id, companyId });
    expect(decision).toMatchObject({ outcome: "refuse", reason: { kind: "unknown_pull_request_state" } });
  });

  it("prose PR mentions are not a binding: comments never wedge the card", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    await issueService(db).addComment(card.id, "Related: https://github.com/Spark-Mojo/paperclip/pull/9999", {});
    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => { throw new Error("must not be called — no binding PRs"); },
    });
    const decision = await gate.evaluateDoneGate({ id: card.id, companyId });
    expect(decision).toEqual({ outcome: "allow" });
  });

  it("override_by_board_recorded: doneOverride closes the card and writes an activity row", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    await attachPullRequestWorkProduct(db, card, 4246);

    const updated = await issueService(db).update(card.id, {
      status: "done",
      doneGateOverride: {
        reason: "Merged by hand outside GitHub; merge sha verified on main.",
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        runId: null,
      },
    });
    expect(updated?.status).toBe("done");

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, card.id));
    const overrideRow = rows.find((row) => row.action === "issue.done_gate_overridden");
    expect(overrideRow).toBeTruthy();
    expect(overrideRow?.details).toMatchObject({
      gate: "issue_done_with_unmerged_pull_request",
      reason: expect.stringContaining("merge sha verified"),
    });
  });

  it("already-done card re-PATCHes without re-firing the gate", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId, status: "done" });
    await attachPullRequestWorkProduct(db, card, 4247);
    const updated = await issueService(db).update(card.id, { title: "retitled while done" });
    expect(updated?.title).toBe("retitled while done");
    expect(updated?.status).toBe("done");
  });

  // SPA-8708 / SPA-8669 / SPA-8919 shape: a reviewer's APPROVED comment on a
  // card whose PR is open auto-closed the card with auto-merge never armed.
  // After SPA-8957 the approve comment is refused with the same 409 and the
  // card stays in_review — James's 2026-09-27 design note.
  it("review_approve_comment_held_open: approve comment does not close a card whose PR is open", async () => {
    const reviewerAgent = await db
      .insert(agents)
      .values({ companyId, name: `reviewer-${randomUUID().slice(0, 8)}`, role: "engineer" })
      .returning()
      .then((rows) => rows[0]!);
    const builderAgent = await db
      .insert(agents)
      .values({ companyId, name: `builder-${randomUUID().slice(0, 8)}`, role: "engineer" })
      .returning()
      .then((rows) => rows[0]!);

    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgent.id }],
        },
      ],
    })!;
    const card = await createCard(db, companyId, {
      status: "in_review",
      assigneeAgentId: reviewerAgent.id,
      executionPolicy: policy as unknown as Record<string, unknown>,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgent.id, userId: null },
        returnAssignee: { type: "agent", agentId: builderAgent.id, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      } as unknown as Record<string, unknown>,
    });
    await attachPullRequestWorkProduct(db, card, 4248);

    const reviewRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: reviewerAgent.id,
        invocationSource: "issue_commented",
        status: "running",
        contextSnapshot: { issueId: card.id },
      })
      .returning()
      .then((rows) => rows[0]!);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "agent",
        agentId: reviewerAgent.id,
        companyId,
        runId: reviewRun.id,
        source: "agent_key",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/issues/${card.id}/comments`)
      .set("X-Paperclip-Run-Id", reviewRun.id)
      .send({ body: "## Review: SPA-4248 — APPROVED\n\nLGTM; ship it." });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("cannot be marked done"),
    });

    const after = await db.select().from(issues).where(eq(issues.id, card.id)).then((rows) => rows[0]!);
    expect(after.status).toBe("in_review");
    // No orphan approve comment survives the rollback.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, card.id));
    expect(comments).toHaveLength(0);
  });

  it("override_denied_for_agent: an agent PATCH carrying doneOverride is 403", async () => {
    const card = await createCard(db, companyId, { assigneeAgentId: agentId });
    await attachPullRequestWorkProduct(db, card, 4249);

    const agentRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: { issueId: card.id },
      })
      .returning()
      .then((rows) => rows[0]!);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "agent",
        agentId,
        companyId,
        runId: agentRun.id,
        source: "agent_key",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);

    const res = await request(app)
      .patch(`/api/issues/${card.id}`)
      .set("X-Paperclip-Run-Id", agentRun.id)
      .send({ status: "done", doneOverride: { reason: "trust me" } });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("Agents cannot override"),
    });
    const after = await db.select().from(issues).where(eq(issues.id, card.id)).then((rows) => rows[0]!);
    expect(after.status).toBe("in_progress");
  });
});
