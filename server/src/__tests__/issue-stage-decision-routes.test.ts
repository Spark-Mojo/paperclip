import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueExecutionDecisions,
  issueInboxArchives,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue stage-decision route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue stage decision routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-stage-decision-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueExecutionDecisions);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const memberUserId = `${prefix.toLowerCase()}-member`;
    const peerUserId = `${prefix.toLowerCase()}-peer`;
    const viewerUserId = `${prefix.toLowerCase()}-viewer`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: assigneeAgentId, companyId, name: `${prefix} Assignee`, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: peerAgentId, companyId, name: `${prefix} Peer`, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: reviewerAgentId, companyId, name: `${prefix} Reviewer`, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: memberUserId, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: peerUserId, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer" },
    ]);
    return { companyId, assigneeAgentId, peerAgentId, reviewerAgentId, memberUserId, peerUserId, viewerUserId };
  }

  // Builder (createdBy) starts as assignee; reviewer is a distinct principal.
  async function seedStageIssue(input: {
    companyId: string;
    builderAgentId: string;
    reviewerAgentId: string;
    identifier: string;
    status?: string;
    description?: string;
    stageCount?: 1 | 2;
    creatorAgentId?: string;
  }) {
    const stageId1 = randomUUID();
    const stageId2 = randomUUID();
    const stages = [
      {
        id: stageId1,
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: input.reviewerAgentId }],
      },
      ...((input.stageCount ?? 1) === 2
        ? [{
            id: stageId2,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: input.reviewerAgentId }],
          }]
        : []),
    ];
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      description: input.description ?? `Stage work for ${input.identifier}`,
      status: input.status ?? "in_review",
      priority: "medium",
      assigneeAgentId: input.builderAgentId,
      createdByAgentId: input.creatorAgentId ?? input.builderAgentId,
    });
    await db.update(issues).set({
      executionPolicy: { mode: "normal", commentRequired: true, stages },
      executionState: {
        status: "pending",
        currentStageId: stageId1,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: input.reviewerAgentId },
        returnAssignee: { type: "agent", agentId: input.builderAgentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issueId));
    return { issueId, stageId1, stageId2 };
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId = randomUUID()) {
    return {
      type: "agent",
      source: "agent_key",
      companyId,
      agentId,
      runId,
    };
  }

  async function seedRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function readIssue(issueId: string) {
    const [row] = await db.select({
      status: issues.status,
      executionState: issues.executionState,
    }).from(issues).where(eq(issues.id, issueId));
    return row as { status: string; executionState: Record<string, any> };
  }

  async function countDecisions(issueId: string, companyId: string) {
    return db.select({ id: issueExecutionDecisions.id })
      .from(issueExecutionDecisions)
      .where(and(
        eq(issueExecutionDecisions.issueId, issueId),
        eq(issueExecutionDecisions.companyId, companyId),
      ));
  }

  it("reviewer approve with an unmerged PR link leaves the card in_review and records the decision", async () => {
    const seeded = await seedCompany("STD");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "STD-1",
      description: "Needs review. PR: https://github.com/o/r/pull/1 (unmerged).",
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Looks good, shipping it.", stageId: stageId1 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue).toMatchObject({ id: issueId, status: "in_review" });
    expect(res.body.decision).toMatchObject({ outcome: "approved", stageId: stageId1 });
    const persisted = await readIssue(issueId);
    expect(persisted.status).toBe("in_review");
    expect(persisted.executionState.completedStageIds).toContain(stageId1);
    expect(persisted.executionState.lastDecisionOutcome).toBe("approved");
  });

  it("forbids the builder and the current assignee from recording a decision", async () => {
    const seeded = await seedCompany("RVO");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "RVO-1",
    });
    // Split builder from assignee so each 403 branch is hit distinctly.
    await db.update(issues).set({ assigneeAgentId: seeded.peerAgentId }).where(eq(issues.id, issueId));

    const builderRunId = await seedRun(seeded.companyId, seeded.assigneeAgentId, issueId);
    const builderDenied = await request(app(agentActor(seeded.companyId, seeded.assigneeAgentId, builderRunId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Self-approving my own work.", stageId: stageId1 });
    expect(builderDenied.status).toBe(403);

    const assigneeRunId = await seedRun(seeded.companyId, seeded.peerAgentId, issueId);
    const assigneeDenied = await request(app(agentActor(seeded.companyId, seeded.peerAgentId, assigneeRunId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Approving from the assignee seat.", stageId: stageId1 });
    expect(assigneeDenied.status).toBe(403);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(0);
  });

  it("R1: card creator who did not build may record a decision", async () => {
    const seeded = await seedCompany("CRT");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      creatorAgentId: seeded.reviewerAgentId,
      identifier: "CRT-1",
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Filing the card is not building it.", stageId: stageId1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.decision).toMatchObject({ outcome: "approved", stageId: stageId1 });
  });

  it("R2: build executor as designated participant is still banned", async () => {
    const seeded = await seedCompany("BLD");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      creatorAgentId: seeded.reviewerAgentId,
      identifier: "BLD-1",
    });
    // Misconfigure the builder as the current participant so the participant
    // gate would admit them — the builder ban must fire first.
    const persistedBld = await readIssue(issueId);
    await db.update(issues).set({
      executionState: {
        ...persistedBld.executionState,
        currentParticipant: { type: "agent", agentId: seeded.assigneeAgentId },
      },
    }).where(eq(issues.id, issueId));

    const runId = await seedRun(seeded.companyId, seeded.assigneeAgentId, issueId);
    const res = await request(app(agentActor(seeded.companyId, seeded.assigneeAgentId, runId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Self-approving as participant.", stageId: stageId1 });
    expect(res.status).toBe(403);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(0);
  });

  it("fallback: null returnAssignee bans on createdBy", async () => {
    const seeded = await seedCompany("FBK");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "FBK-1",
    });
    // Legacy card: no returnAssignee; creator (also builder here) decides.
    const persistedFbk = await readIssue(issueId);
    await db.update(issues).set({
      executionState: {
        ...persistedFbk.executionState,
        currentParticipant: { type: "agent", agentId: seeded.assigneeAgentId },
        returnAssignee: null,
      },
    }).where(eq(issues.id, issueId));

    const runId = await seedRun(seeded.companyId, seeded.assigneeAgentId, issueId);
    const res = await request(app(agentActor(seeded.companyId, seeded.assigneeAgentId, runId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Legacy self-approval.", stageId: stageId1 });
    expect(res.status).toBe(403);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(0);
  });

  it("replays an identical decision as a duplicate without inserting a second row", async () => {
    // Approve is terminal on a single-stage policy; request_changes keeps the stage open.
    const seeded = await seedCompany("IDM");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "IDM-1",
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const actor = agentActor(seeded.companyId, seeded.reviewerAgentId, runId);
    const payload = { action: "request_changes", body: "Needs a null-check on line 42.", stageId: stageId1 };

    const first = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.duplicate ?? false).toBe(false);

    const second = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send(payload);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.duplicate).toBe(true);

    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(1);
    const persisted = await readIssue(issueId);
    expect(persisted.executionState.lastDecisionId).toBe(first.body.decision.id);
    expect(second.body.decision.id).toBe(first.body.decision.id);
  });

  it("last writer wins: a different body is a new decision and state reflects the latest write", async () => {
    const seeded = await seedCompany("LWW");
    const { issueId, stageId1, stageId2 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "LWW-1",
      stageCount: 2,
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const actor = agentActor(seeded.companyId, seeded.reviewerAgentId, runId);

    const approveBody = "Stage one looks good.";
    const approved = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: approveBody, stageId: stageId1 });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const changesBody = "Stage two needs rework on error handling.";
    const changes = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "request_changes", body: changesBody, stageId: stageId2 });
    expect(changes.status, JSON.stringify(changes.body)).toBe(200);
    expect(changes.body.duplicate ?? false).toBe(false);
    let persisted = await readIssue(issueId);
    expect(persisted.executionState.status).toBe("changes_requested");
    expect(persisted.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Stale approve body on the now-open stage lands as a NEW decision.
    const staleApprove = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: approveBody, stageId: stageId2 });
    expect(staleApprove.status, JSON.stringify(staleApprove.body)).toBe(200);
    expect(staleApprove.body.duplicate ?? false).toBe(false);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(3);
    persisted = await readIssue(issueId);
    expect(persisted.executionState.lastDecisionOutcome).toBe("approved");
    expect(persisted.executionState.completedStageIds).toContain(stageId1);
  });

  it("approve retry across stage transition is idempotent", async () => {
    const seeded = await seedCompany("RTY");
    const { issueId, stageId1, stageId2 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "RTY-1",
      stageCount: 2,
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const actor = agentActor(seeded.companyId, seeded.reviewerAgentId, runId);
    const payload = { action: "approve", body: "Stage one looks good, retry me.", stageId: stageId1 };

    const first = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.duplicate ?? false).toBe(false);
    let persisted = await readIssue(issueId);
    expect(persisted.executionState.currentStageId).toBe(stageId2);
    expect(persisted.executionState.completedStageIds).toContain(stageId1);
    expect(persisted.executionState.completedStageIds).not.toContain(stageId2);

    const second = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ ...payload, stageId: stageId1 });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.decision.id).toBe(first.body.decision.id);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(1);
    persisted = await readIssue(issueId);
    expect(persisted.executionState.currentStageId).toBe(stageId2);
    expect(persisted.executionState.completedStageIds).not.toContain(stageId2);
    expect(persisted.executionState.lastDecisionId).toBe(first.body.decision.id);
  });

  it("same actor same body on the new active stage is a fresh approval", async () => {
    const seeded = await seedCompany("NXS");
    const { issueId, stageId1, stageId2 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "NXS-1",
      stageCount: 2,
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const actor = agentActor(seeded.companyId, seeded.reviewerAgentId, runId);

    const first = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Looks good at every stage.", stageId: stageId1 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.duplicate ?? false).toBe(false);

    const second = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Looks good at every stage.", stageId: stageId2 });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.duplicate ?? false).toBe(false);
    expect(second.body.decision.id).not.toBe(first.body.decision.id);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(2);
    const persisted = await readIssue(issueId);
    expect(persisted.executionState.completedStageIds).toContain(stageId2);
  });

  it("mismatched stageId with non-matching payload is a 409 conflict", async () => {
    const seeded = await seedCompany("CF4");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "CF4-1",
      stageCount: 2,
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const actor = agentActor(seeded.companyId, seeded.reviewerAgentId, runId);

    const first = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Stage one complete.", stageId: stageId1 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const stale = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "request_changes", body: "Different payload, stale stage.", stageId: stageId1 });
    expect(stale.status).toBe(409);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(1);
  });

  it("rejects a non-participant stranger with 422 and admits the designated participant", async () => {
    const seeded = await seedCompany("STR");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "STR-1",
    });
    const strangerRunId = await seedRun(seeded.companyId, seeded.peerAgentId, issueId);
    const stranger = await request(app(agentActor(seeded.companyId, seeded.peerAgentId, strangerRunId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "I am not the reviewer.", stageId: stageId1 });
    expect(stranger.status).toBe(422);

    const reviewerRunId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const reviewer = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, reviewerRunId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "I am the designated reviewer.", stageId: stageId1 });
    expect(reviewer.status, JSON.stringify(reviewer.body)).toBe(200);
  });

  it("identical retry without stageId cannot approve the next stage", async () => {
    const seeded = await seedCompany("NSI");
    const { issueId, stageId1, stageId2 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "NSI-1",
      stageCount: 2,
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const actor = agentActor(seeded.companyId, seeded.reviewerAgentId, runId);

    const first = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Stage one approved.", stageId: stageId1 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    let persisted = await readIssue(issueId);
    expect(persisted.executionState.currentStageId).toBe(stageId2);
    const lastDecisionId = persisted.executionState.lastDecisionId;

    // Identical action+body with NO stageId must not approve stage 2.
    // validate() rejects the missing stageId before the handler: 400.
    const retry = await request(app(actor))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Stage one approved." });
    expect(retry.status).toBe(400);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(1);
    persisted = await readIssue(issueId);
    expect(persisted.executionState.currentStageId).toBe(stageId2);
    expect(persisted.executionState.completedStageIds).not.toContain(stageId2);
    expect(persisted.executionState.lastDecisionId).toBe(lastDecisionId);
  });

  it("returns 409 for a card that is not in_review", async () => {
    const seeded = await seedCompany("NIR");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "NIR-1",
      status: "todo",
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .post(`/api/issues/${issueId}/stage-decision`)
      .send({ action: "approve", body: "Too late.", stageId: stageId1 });
    expect(res.status).toBe(409);
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(0);
  });

  // SPA-13732 R2 rehearsal: BOTH blocked-entry 422 branches return without
  // mutating status — the card stays on its prior wakeable status and never
  // lands on backlog. Branch 1 = terminal-blocker 422 (~13864: named
  // blockedByIssueIds resolve to done/cancelled). Branch 2 = generic
  // baseBlockedRefusal 422 (~13876: no unresolved blocker, no pending
  // interaction/approval, no descriptor). No new guard code under test — the
  // 422 arms return before any status write, behavior-preserving.
  it("forced-422 blocked entry on both branches leaves the prior wakeable status byte-equal and never backlog", async () => {
    const seeded = await seedCompany("PRK");

    async function seedTodoIssue(identifier: string) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId: seeded.companyId,
        identifier,
        title: identifier,
        description: `Park-guard rehearsal for ${identifier}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: seeded.assigneeAgentId,
        createdByAgentId: seeded.assigneeAgentId,
      });
      return issueId;
    }

    // Branch 1: terminal-blocker 422 — named blocker is done.
    const doneBlockerId = randomUUID();
    await db.insert(issues).values({
      id: doneBlockerId,
      companyId: seeded.companyId,
      identifier: "PRK-DONE",
      title: "PRK-DONE",
      description: "terminal blocker",
      status: "done",
      priority: "medium",
      assigneeAgentId: seeded.assigneeAgentId,
      createdByAgentId: seeded.assigneeAgentId,
    });
    const terminalIssueId = await seedTodoIssue("PRK-1");
    const terminalRunId = await seedRun(seeded.companyId, seeded.assigneeAgentId, terminalIssueId);
    const terminal = await request(app(agentActor(seeded.companyId, seeded.assigneeAgentId, terminalRunId)))
      .patch(`/api/issues/${terminalIssueId}`)
      .send({ status: "blocked", blockedByIssueIds: [doneBlockerId] });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(422);
    const terminalAfter = await readIssue(terminalIssueId);
    expect(terminalAfter.status).toBe("todo");
    expect(terminalAfter.status).not.toBe("backlog");

    // Branch 2: generic baseBlockedRefusal 422 — no blockers, no pending
    // interaction/approval, no descriptor.
    const genericIssueId = await seedTodoIssue("PRK-2");
    const genericRunId = await seedRun(seeded.companyId, seeded.assigneeAgentId, genericIssueId);
    const generic = await request(app(agentActor(seeded.companyId, seeded.assigneeAgentId, genericRunId)))
      .patch(`/api/issues/${genericIssueId}`)
      .send({ status: "blocked" });
    expect(generic.status, JSON.stringify(generic.body)).toBe(422);
    const genericAfter = await readIssue(genericIssueId);
    expect(genericAfter.status).toBe("todo");
    expect(genericAfter.status).not.toBe("backlog");
  });
});
