import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

vi.hoisted(() => {
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue patch stage-decision ban tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The PATCH /api/issues/:id execution-policy transition mints stage-decision
// rows (approved / changes_requested) through the same participant branch the
// POST stage-decision route gates with a builder ban. These tests prove the
// ban holds on the PATCH channel too, and that a non-creator participant is
// untouched.
describeEmbeddedPostgres("issue patch stage-decision builder ban", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-patch-stage-ban-");
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
    ]);
    return { companyId, assigneeAgentId, peerAgentId, reviewerAgentId, memberUserId };
  }

  // Builder (createdBy) starts as assignee; the stage participant defaults to
  // the reviewer. `participantAgentId` re-points the CONFIGURED participant
  // (and currentParticipant) to simulate the builder-as-reviewer
  // misconfiguration the ban exists for.
  async function seedStageIssue(input: {
    companyId: string;
    builderAgentId: string;
    reviewerAgentId: string;
    identifier: string;
    participantAgentId?: string;
  }) {
    const stageId1 = randomUUID();
    const stages = [
      {
        id: stageId1,
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: input.participantAgentId ?? input.reviewerAgentId }],
      },
    ];
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      description: `Stage work for ${input.identifier}`,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.builderAgentId,
      createdByAgentId: input.builderAgentId,
    });
    await db.update(issues).set({
      executionPolicy: { mode: "normal", commentRequired: true, stages },
      executionState: {
        status: "pending",
        currentStageId: stageId1,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: input.participantAgentId ?? input.reviewerAgentId },
        returnAssignee: { type: "agent", agentId: input.builderAgentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issueId));
    return { issueId, stageId1 };
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

  it("PATCH done by the builder misconfigured as participant is forbidden with no decision recorded", async () => {
    const seeded = await seedCompany("PBD");
    // Misconfigure the builder as the configured stage participant AND the
    // current participant so the PATCH participant gate (which also requires
    // stage membership) admits them — the builder ban must fire first.
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "PBD-1",
      participantAgentId: seeded.assigneeAgentId,
    });
    const persisted = await readIssue(issueId);
    await db.update(issues).set({
      executionState: {
        ...persisted.executionState,
        currentParticipant: { type: "agent", agentId: seeded.assigneeAgentId },
      },
    }).where(eq(issues.id, issueId));

    const runId = await seedRun(seeded.companyId, seeded.assigneeAgentId, issueId);
    const testApp = app(agentActor(seeded.companyId, seeded.assigneeAgentId, runId));

    const doneDenied = await request(testApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Self-approving my own work." });
    expect(doneDenied.status, JSON.stringify(doneDenied.body)).toBe(403);
    expect(doneDenied.body.error).toBe("The card builder cannot record a stage decision");
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(0);
    let after = await readIssue(issueId);
    expect(after.status).toBe("in_review");
    expect(after.executionState.lastDecisionId).toBeNull();
    expect(after.executionState.completedStageIds).not.toContain(stageId1);

    // The changes_requested mint on the same channel is banned identically.
    const changesDenied = await request(testApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Requesting changes on my own work." });
    expect(changesDenied.status, JSON.stringify(changesDenied.body)).toBe(403);
    expect(changesDenied.body.error).toBe("The card builder cannot record a stage decision");
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(0);
    after = await readIssue(issueId);
    expect(after.status).toBe("in_review");
    expect(after.executionState.lastDecisionId).toBeNull();
  });

  it("PATCH done by the creator on a legacy null-returnAssignee card is forbidden with no decision recorded", async () => {
    const seeded = await seedCompany("PBC");
    // Legacy card: no returnAssignee; the creator (also builder here) is the
    // CONFIGURED stage participant and the current participant, so the
    // createdBy fallback must ban them.
    const { issueId } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "PBC-1",
      participantAgentId: seeded.assigneeAgentId,
    });
    const persisted = await readIssue(issueId);
    await db.update(issues).set({
      executionState: {
        ...persisted.executionState,
        currentParticipant: { type: "agent", agentId: seeded.assigneeAgentId },
        returnAssignee: null,
      },
    }).where(eq(issues.id, issueId));

    const runId = await seedRun(seeded.companyId, seeded.assigneeAgentId, issueId);
    const denied = await request(app(agentActor(seeded.companyId, seeded.assigneeAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Legacy self-approval." });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error).toBe("The card builder cannot record a stage decision");
    expect(await countDecisions(issueId, seeded.companyId)).toHaveLength(0);
    const after = await readIssue(issueId);
    expect(after.status).toBe("in_review");
    expect(after.executionState.lastDecisionId).toBeNull();
  });

  it("PATCH done by the non-creator designated participant succeeds and records the decision", async () => {
    const seeded = await seedCompany("PBG");
    const { issueId, stageId1 } = await seedStageIssue({
      companyId: seeded.companyId,
      builderAgentId: seeded.assigneeAgentId,
      reviewerAgentId: seeded.reviewerAgentId,
      identifier: "PBG-1",
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Looks good, shipping it." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const decisions = await countDecisions(issueId, seeded.companyId);
    expect(decisions).toHaveLength(1);
    const after = await readIssue(issueId);
    expect(after.status).toBe("done");
    expect(after.executionState.completedStageIds).toContain(stageId1);
    expect(after.executionState.lastDecisionOutcome).toBe("approved");
    expect(typeof after.executionState.lastDecisionId).toBe("string");
  });
});
