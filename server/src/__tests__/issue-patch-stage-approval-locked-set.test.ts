/**
 * SPA-9396 — the PATCH premerge-approval path must recheck the CANONICAL bound
 * pull-request set under the locked issue transaction, immediately before the
 * approval is persisted.
 *
 * The pre-transaction verification proves the claim matches the set as it read
 * from the outer connection. Between that read and the commit, a concurrent
 * writer can rebind the set — including a same-size change (swap one PR for a
 * different one) and a description edit, since the description is one of the
 * binding surfaces. A guard that compares only the locked issue ROW therefore
 * passes on a changed bound set: the row's own columns are identical, so
 * `issueStageApprovalSnapshotEqual` is true and the approval lands on a set
 * nobody reviewed.
 *
 * These cases pin the two set mutations the row comparison is blind to, plus
 * the positive control, and assert the same durability facts on every refusal.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
  cancelLiveRunsForIssue: vi.fn(async () => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));

const mockDbSelectWhere = vi.hoisted(() =>
  vi.fn(() => ({
    for: () => ({
      then: (
        onFulfilled: (rows: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve([
          {
            id: "55555555-5555-4555-8555-555555555555",
            companyId: "company-1",
            agentId: "33333333-3333-4333-8333-333333333333",
            contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
            permissions: null,
          },
        ]).then(onFulfilled, onRejected),
    }),
    then: (
      onFulfilled: (rows: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve([
        {
          id: "55555555-5555-4555-8555-555555555555",
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          permissions: null,
        },
      ]).then(onFulfilled, onRejected),
  })),
);
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));

/** The transaction handle, with the row/binding selects the guard must run on it. */
const mockTx = vi.hoisted(() => {
  const tx = {
    select: vi.fn(),
    insert: vi.fn((table: unknown) => ({
      values: async (row: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any).__inserted.push({ table, row });
        return undefined;
      },
    })),
    __inserted: [] as unknown[],
  };
  return tx;
});
const insertedDecisionRows = mockTx.__inserted as unknown[];

const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) =>
    callback(mockTx),
  ),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockIssueReferencesSvc = vi.hoisted(() => ({
  deleteDocumentSource: async () => undefined,
  diffIssueReferenceSummary: () => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  }),
  emptySummary: () => ({ outbound: [], inbound: [] }),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

/**
 * The bound-set reader is stubbed so the canonical set is a fixture keyed on
 * the description the reader is handed, not a description regex. The
 * pre-transaction read sees the issue as it was; the in-transaction recheck
 * hands the service the transaction handle, which the seam records so a test
 * can assert the recheck actually ran on `tx`.
 */
const mockIssueDoneGateService = vi.hoisted(() => ({
  handles: [] as unknown[],
  listBoundPullRequests: vi.fn(async () => [] as Array<{
    host: string;
    owner: string;
    repo: string;
    number: number;
  }>),
}));

const mockGithubMerge = vi.hoisted(() => ({
  createPullRequestMergeDetailsResolver: vi.fn(() => async () => ({
    state: "open",
    headRef: null,
    headSha: "9e0e5288875f46460e711ca233c3a88506ea2ecf",
  })),
}));

function registerModuleMocks() {
  vi.doMock("../services/runner-goals.js", () => ({
    runnerGoalService: () => ({ projection: async () => null, act: vi.fn() }),
    RunnerGoalActionError: class RunnerGoalActionError extends Error {},
    RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
  }));

  vi.doMock("../services/issue-done-gate.js", () => ({
    issueDoneGateService: (handle: unknown) => {
      mockIssueDoneGateService.handles.push(handle);
      return {
        ...mockIssueDoneGateService,
        listBoundPullRequests: (issue: { id: string; companyId: string; description?: string | null }) =>
          mockIssueDoneGateService.listBoundPullRequests(issue, handle),
      };
    },
    APPROVAL_WORK_PRODUCT_SCAN_LIMIT: 100,
    APPROVAL_COMMENT_SCAN_LIMIT: 200,
  }));

  vi.doMock("../services/github-pull-request-merge.js", () => ({
    createPullRequestMergeDetailsResolver:
      mockGithubMerge.createPullRequestMergeDetailsResolver,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({ getById: vi.fn(async () => ({ id: "company-1" })) }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          status: "idle",
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
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: true })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({ getById: vi.fn(async () => null) }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingOption: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => mockIssueReferencesSvc,
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
const stageId = "44444444-4444-4444-8444-444444444444";
const participantId = "77777777-7777-4777-8777-777777777777";
const reviewedHead = "9e0e5288875f46460e711ca233c3a88506ea2ecf";
const otherHead = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";

const reviewerActor = {
  type: "agent",
  agentId: reviewerAgentId,
  companyId: "company-1",
  runId: "55555555-5555-4555-8555-555555555555",
} as unknown as {
  type: "agent";
  agentId: string;
  companyId: string;
  runId: string;
};

const pr = (number: number) => ({
  host: "github.com" as const,
  owner: "Spark-Mojo",
  repo: "paperclip",
  number,
});

function reviewPolicy() {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        id: stageId,
        type: "review",
        approvalsNeeded: 1,
        participants: [
          { id: participantId, type: "agent" as const, agentId: reviewerAgentId },
        ],
      },
    ],
  };
}

/**
 * A card parked in a review stage awaiting the active reviewer's decision.
 * `description` is the pre-transaction binding surface.
 */
function reviewStageIssue(overrides: Record<string, unknown> = {}) {
  const policy = normalizeIssueExecutionPolicy(reviewPolicy());
  return {
    id: issueId,
    companyId: "company-1",
    identifier: "PAP-1002",
    title: "Premerge stage approval",
    description: "PR https://github.com/Spark-Mojo/paperclip/pull/1202",
    status: "in_review",
    reviewPolicy: "anyone",
    assigneeAgentId: reviewerAgentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    executionPolicy: policy,
    executionState: {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: reviewerAgentId },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 1,
      approvals: [],
    },
    ...overrides,
  };
}

async function createApp(actor: unknown) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as never, {} as never));
  app.use(errorHandler);
  return app;
}

describe("PATCH stage approval — canonical PR set rechecked under the lock", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/issue-done-gate.js");
    vi.doUnmock("../services/github-pull-request-merge.js");
    registerModuleMocks();
    vi.clearAllMocks();
    insertedDecisionRows.length = 0;
    mockIssueDoneGateService.handles.length = 0;
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.addComment.mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999", body: "Reviewed the current head." });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueReferencesSvc.listIssueReferenceSummary.mockResolvedValue({
      outbound: [],
      inbound: [],
    });
    mockTx.select.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async () => ({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));
    mockIssueDoneGateService.listBoundPullRequests.mockResolvedValue([pr(1202)]);
    mockGithubMerge.createPullRequestMergeDetailsResolver.mockImplementation(
      () => async () => ({ state: "open", headRef: null, headSha: reviewedHead }),
    );
  });

  function expectNothingDurable() {
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(insertedDecisionRows).toEqual([]);
  }

  const claim = [
    { owner: "Spark-Mojo", repo: "paperclip", number: 1202, headSha: reviewedHead },
  ];

  it("refuses when the bound set changed to a DIFFERENT same-size set under the lock", async () => {
    const preTx = reviewStageIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    // The locked issue ROW is byte-identical to the pre-transaction read, so a
    // row-only comparison passes. The binding surface moved: the claim names
    // #1202 but the card now binds #1301 alone — one PR in, one PR out, so
    // the set SIZE is unchanged and only set equality can catch it.
    mockIssueService.getByIdForUpdate.mockResolvedValue({ ...preTx });
    mockIssueDoneGateService.listBoundPullRequests.mockImplementation(
      async (issue: { description?: string | null }, handle?: unknown) =>
        handle === mockTx ? [pr(1301)] : [pr(1202)],
    );
    mockIssueService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({ ...preTx, ...patch }),
    );

    const res = await request(await createApp(reviewerActor))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "## Review: APPROVED\n\nReviewed the current head.",
        reviewedPullRequests: claim,
      });

    expect(res.status).toBe(409);
    expect(mockIssueDoneGateService.handles).toContain(mockTx);
    expectNothingDurable();
  }, 60_000);

  it("refuses when the bound set GREW under the lock", async () => {
    const preTx = reviewStageIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    mockIssueService.getByIdForUpdate.mockResolvedValue({ ...preTx });
    mockIssueDoneGateService.listBoundPullRequests.mockImplementation(
      async (issue: { description?: string | null }, handle?: unknown) =>
        handle === mockTx ? [pr(1202), pr(1203)] : [pr(1202)],
    );
    mockIssueService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({ ...preTx, ...patch }),
    );

    const res = await request(await createApp(reviewerActor))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "## Review: APPROVED\n\nReviewed the current head.",
        reviewedPullRequests: claim,
      });

    expect(res.status).toBe(409);
    expectNothingDurable();
  }, 60_000);

  it("refuses when the card DESCRIPTION changed under the lock and rebinds the set", async () => {
    const preTx = reviewStageIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    // A concurrent writer edited the description, which is itself a binding
    // surface: the locked row now names a different PR set than the one the
    // claim was verified against.
    const locked = {
      ...preTx,
      description: "PR https://github.com/Spark-Mojo/paperclip/pull/1301",
    };
    mockIssueService.getByIdForUpdate.mockResolvedValue(locked);
    mockIssueDoneGateService.listBoundPullRequests.mockImplementation(
      async (issue: { description?: string | null }, handle?: unknown) =>
        handle === mockTx ? [pr(1301)] : [pr(1202)],
    );
    mockIssueService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({ ...preTx, ...patch }),
    );

    const res = await request(await createApp(reviewerActor))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "## Review: APPROVED\n\nReviewed the current head.",
        reviewedPullRequests: claim,
      });

    expect(res.status).toBe(409);
    expectNothingDurable();
  }, 60_000);

  it("refuses when the locked bound set is re-read with a head the claim never named", async () => {
    const preTx = reviewStageIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    mockIssueService.getByIdForUpdate.mockResolvedValue({ ...preTx });
    // The set is unchanged, so set equality passes; the recheck's live head
    // read must still refuse the approval the pre-transaction read accepted.
    let txReads = 0;
    mockIssueDoneGateService.listBoundPullRequests.mockImplementation(
      async (issue: { description?: string | null }, handle?: unknown) => {
        if (handle === mockTx) txReads += 1;
        return [pr(1202)];
      },
    );
    let detailReads = 0;
    mockGithubMerge.createPullRequestMergeDetailsResolver.mockImplementation(
      () => async () => ({ state: "open", headRef: null, headSha: ++detailReads > 3 ? otherHead : reviewedHead }),
    );
    mockIssueService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({ ...preTx, ...patch }),
    );

    const res = await request(await createApp(reviewerActor))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "## Review: APPROVED\n\nReviewed the current head.",
        // The claim names the head the reviewer read, so the PRE-transaction
        // verification is satisfied by the fixture above only if the resolver
        // is stable; the first read returns the reviewed head.
        reviewedPullRequests: claim,
      });

    expect(res.status).toBe(409);
    expect(txReads).toBeGreaterThan(0);
    expectNothingDurable();
  }, 60_000);

  it("allows the approval when the locked bound set and heads are unchanged", async () => {
    const preTx = reviewStageIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    mockIssueService.getByIdForUpdate.mockResolvedValue({ ...preTx });
    mockIssueService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({ ...preTx, ...patch }),
    );

    const res = await request(await createApp(reviewerActor))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "## Review: APPROVED\n\nReviewed the current head.",
        reviewedPullRequests: claim,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The recheck ran on the transaction handle, not the outer connection.
    expect(mockIssueDoneGateService.handles).toContain(mockTx);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    expect(insertedDecisionRows).toHaveLength(1);
    expect(insertedDecisionRows[0]!.row).toMatchObject({ stageId, outcome: "approved" });
  }, 60_000);
});
