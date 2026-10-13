import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_RUN_ID = "44444444-4444-4444-8444-444444444444";
const PAUSED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const IDLE_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const agentStatusById: Record<string, string> = {
  [AGENT_ACTOR_ID]: "idle",
  [PAUSED_AGENT_ID]: "paused",
  [IDLE_AGENT_ID]: "idle",
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  findOpenDelegationCycleAncestor: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({
    blockerIssueIds: [],
    isDependencyReady: false,
    unresolvedBlockerCount: 0,
  })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/cross-issue-influence-limit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/cross-issue-influence-limit.js")>(),
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => ({
      id,
      companyId: "company-1",
      status: agentStatusById[id] ?? "idle",
    })),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: {
        id: raw,
        companyId: "company-1",
        status: agentStatusById[raw] ?? "idle",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

type Actor = Record<string, unknown>;

function boardActor(): Actor {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function agentActor(): Actor {
  return {
    type: "agent",
    agentId: AGENT_ACTOR_ID,
    companyId: "company-1",
    source: "agent_key",
    runId: AGENT_RUN_ID,
  };
}

// Minimal chainable/thenable db stub: any query resolves to an empty row set.
// Run containment is mocked because this suite targets assignee invokability.
function stubDb(): any {
  const query: any = {};
  for (const method of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "for"]) {
    query[method] = () => query;
  }
  query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([]));
  return { select: () => query };
}

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(stubDb() as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_ACTOR_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Invokability test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue assignee invokability guard", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.findOpenDelegationCycleAncestor.mockReset();
    mockIssueService.findOpenDelegationCycleAncestor.mockResolvedValue(null);
    mockIssueService.update.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockClear();
    mockObserveCrossIssueInfluence.mockClear();
    mockObserveCrossIssueInfluence.mockResolvedValue(null);
  });

  it("refuses an agent assigning an issue to a paused agent", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent creating a child issue assigned to a paused agent", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Escalation for the manager",
        description: "Needs a decision",
        assigneeAgentId: PAUSED_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("still allows an agent to assign to an invokable agent", async () => {
    const existing = makeIssue();
    const updated = makeIssue({ assigneeAgentId: IDLE_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: IDLE_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows a board user to assign to a paused agent deliberately", async () => {
    const existing = makeIssue({ assigneeAgentId: null });
    const updated = makeIssue({ assigneeAgentId: PAUSED_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(createApp(boardActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});

describe("agent delegation cycle guard", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.findOpenDelegationCycleAncestor.mockReset();
    mockIssueService.findOpenDelegationCycleAncestor.mockResolvedValue(null);
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockClear();
  });

  /**
   * The shape the guard exists for: the proposed assignee created an open
   * ancestor AND that ancestor is assigned to the acting agent. The agent
   * holding work from the proposed assignee is now filing new work back to it.
   */
  function openAssignmentFromProposedAssignee(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      identifier: "PAP-100",
      parentId: null,
      createdByAgentId: IDLE_AGENT_ID,
      assigneeAgentId: AGENT_ACTOR_ID,
      status: "in_progress",
      ...overrides,
    };
  }

  it("refuses an agent child assigned to the delegator that still holds the actor's open work", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.findOpenDelegationCycleAncestor.mockResolvedValue(
      openAssignmentFromProposedAssignee(),
    );

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Hand it back",
        description: "Bounce",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Delegation cycle");
    expect(res.body.details).toMatchObject({ code: "delegation_cycle" });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.findOpenDelegationCycleAncestor).toHaveBeenCalledWith(
      parent.id,
      IDLE_AGENT_ID,
      AGENT_ACTOR_ID,
    );
  });

  /**
   * SPA-11956, the measured shape that started this fix: LaQuesha files a
   * parented child under an open ancestor Dex created, assigned to Dex. Dex
   * never delegated that ancestor to LaQuesha — it is standing ownership
   * (law 20), so there is no ping-pong and the create must succeed WITH the
   * parent attached. The parent chain is what carries workspace inheritance,
   * so dropping it to dodge a 409 is the defect, not the escape.
   */
  it("allows the parented re-route when the ancestor creator holds the work itself", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Route the git ops card",
        description: "Dex owns git ops and created the ancestor himself",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalledWith(
      parent.id,
      expect.objectContaining({ assigneeAgentId: IDLE_AGENT_ID }),
    );
    expect(mockIssueService.findOpenDelegationCycleAncestor).toHaveBeenCalledWith(
      parent.id,
      IDLE_AGENT_ID,
      AGENT_ACTOR_ID,
    );
  });

  /**
   * The same refusal must hold on the company-scoped create path — that is
   * the second (and only other) guarded call site, and it is the one that
   * carries a client-supplied parentIssueId.
   */
  it("refuses the same cycle on the company-scoped create path", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.findOpenDelegationCycleAncestor.mockResolvedValue(
      openAssignmentFromProposedAssignee(),
    );

    const res = await request(createApp(agentActor()))
      .post(`/api/companies/company-1/issues`)
      .send({
        title: "Hand it back",
        description: "Bounce",
        parentId: parent.id,
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "delegation_cycle" });
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.findOpenDelegationCycleAncestor).toHaveBeenCalledWith(
      parent.id,
      IDLE_AGENT_ID,
      AGENT_ACTOR_ID,
    );
  });

  it("allows the parented re-route on the company-scoped create path", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.create.mockResolvedValue(
      makeIssue({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
    );

    const res = await request(createApp(agentActor()))
      .post(`/api/companies/company-1/issues`)
      .send({
        title: "Route the git ops card",
        description: "Standing ownership, not a ping-pong",
        parentId: parent.id,
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
    );
  });

  it("allows the same child when no open ancestor was created by the assignee", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Legit subtask",
        description: "Fine",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalled();
  });

  it("does not consult the guard for board actors", async () => {
    const parent = makeIssue({ assigneeAgentId: null });
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Human-created child",
        description: "Deliberate",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.findOpenDelegationCycleAncestor).not.toHaveBeenCalled();
  });

  /**
   * The guard is create-only by design: the assignee path on PATCH is not
   * consulted, which is what keeps a re-route possible for an agent that
   * does hold work from the proposed assignee. Pinned here so a future change
   * that closes it also has to close a sanctioned alternative.
   */
  it("leaves the PATCH assignee path unguarded", async () => {
    const existing = makeIssue({ assigneeAgentId: null });
    const updated = makeIssue({ assigneeAgentId: IDLE_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    // The chain WOULD refuse on create — PATCH must not consult it at all.
    mockIssueService.findOpenDelegationCycleAncestor.mockResolvedValue(
      openAssignmentFromProposedAssignee(),
    );

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: IDLE_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockIssueService.findOpenDelegationCycleAncestor).not.toHaveBeenCalled();
  });
});
