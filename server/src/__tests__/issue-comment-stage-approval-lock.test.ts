/**
 * SPA-9396 — comment-path premerge stage approval must recheck the LOCKED
 * issue snapshot and the canonical bound pull-request set before the durable
 * decision (comment + status transition + decision row) commits.
 *
 * The PATCH path already does this (`assertLockedStageApprovalUnchanged` in
 * routes/issues.ts). The comment auto-approval path verified the pull-request
 * set against a PRE-TRANSACTION read and then committed inside
 * `db.transaction` without ever re-reading under a row lock, so a concurrent
 * writer that changed the issue description (which is what the canonical bound
 * PR set is derived from) or the execution policy between those two points
 * could still land a durable approval of a set that no longer exists.
 *
 * Every test here asserts the SAME three durability facts on refusal:
 *   - no comment is inserted,
 *   - no issue update is applied,
 *   - no execution-decision row is inserted.
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
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
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

/** Captured tx.insert(issueExecutionDecisions) rows — the durable decision. */
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

const mockDbSelectWhere = vi.hoisted(() =>
  vi.fn((table?: unknown) => {
    const rows = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        companyId: "company-1",
        agentId: "33333333-3333-4333-8333-333333333333",
        contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        permissions: null,
      },
    ];
    return {
      for: () => ({
        then: (
          onFulfilled: (rows: unknown[]) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(onFulfilled, onRejected),
      }),
      orderBy: () => ({
        for: (strength: string) => {
          lockedBindingTables.push(
            `${(table as Record<symbol, string>)[Symbol.for("drizzle:Name")]}:${strength}`,
          );
          return { then: (on: (rows: unknown[]) => unknown) => on([]) };
        },
      }),
      then: (
        onFulfilled: (rows: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
  }),
);
const mockDbSelectFrom = vi.hoisted(() =>
  vi.fn((table?: unknown) => ({ where: () => mockDbSelectWhere(table) })),
);
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));

/** The binding tables the production lock helper actually locked, in order. */
const lockedBindingTables = vi.hoisted(() => [] as string[]);
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) =>
    callback(mockTx),
  ),
}));

// Bound pull requests are derived from the issue description; the done-gate
// scanner is stubbed so the canonical set is a fixture, not a description regex.
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
    state: "unknown",
    headRef: null,
    headSha: null,
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
      return mockIssueDoneGateService;
    },
    APPROVAL_WORK_PRODUCT_SCAN_LIMIT: 100,
    APPROVAL_COMMENT_SCAN_LIMIT: 200,
  }));

  vi.doMock("../services/github-pull-request-merge.js", () => ({
    createPullRequestMergeDetailsResolver: mockGithubMerge.createPullRequestMergeDetailsResolver,
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
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
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

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor: TestActor) {
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

const boardActor: TestActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reviewerAgentId = "33333333-3333-4333-8333-333333333333";

/** The configured stage participant — the only principal allowed to advance. */
const reviewerActor = {
  type: "agent",
  agentId: reviewerAgentId,
  companyId: "company-1",
  runId: "55555555-5555-4555-8555-555555555555",
} as unknown as TestActor;
const stageId = "44444444-4444-4444-8444-444444444444";
const participantId = "77777777-7777-4777-8777-777777777777";
const reviewedHead = "9e0e5288875f46460e711ca233c3a88506ea2ecf";
const movedHead = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";

const boundPr1202 = { host: "github.com", owner: "Spark-Mojo", repo: "paperclip", number: 1202 };

function reviewPolicy(participants: Array<{ id: string; agentId: string }> = [
  { id: participantId, agentId: reviewerAgentId },
]) {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        id: stageId,
        type: "review",
        approvalsNeeded: 1,
        participants: participants.map((participant) => ({
          id: participant.id,
          type: "agent" as const,
          agentId: participant.agentId,
        })),
      },
    ],
  };
}

/**
 * An issue sitting in a review stage with the board user as the active
 * participant, which is what the comment auto-approval path requires:
 * `in_review` + pending + actor matches `currentParticipant` + approval body.
 */
function inReviewIssue(overrides: Record<string, unknown> = {}) {
  const policy = normalizeIssueExecutionPolicy(reviewPolicy());
  return {
    id: issueId,
    companyId: "company-1",
    identifier: "PAP-1002",
    title: "Premerge stage approval",
    description: "PR #1202",
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

describe("comment-path stage approval — locked snapshot and canonical PR set", () => {
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
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueReferencesSvc.listIssueReferenceSummary.mockResolvedValue({ outbound: [], inbound: [] });
    mockTx.select.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockAccessService.canUser.mockResolvedValue(true);
    lockedBindingTables.length = 0;
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async () => ({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));
    mockIssueDoneGateService.listBoundPullRequests.mockResolvedValue([boundPr1202]);
    mockGithubMerge.createPullRequestMergeDetailsResolver.mockImplementation(() => async () => ({
      state: "open",
      headRef: null,
      headSha: reviewedHead,
      workProductState: "open",
    }));
    mockIssueService.addComment.mockImplementation(
      async (_id: string, body: string) => ({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        issueId,
        companyId: "company-1",
        body,
      }),
    );
  });

  /** The single assertion set every refusal test must satisfy. */
  function expectNothingDurable() {
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(insertedDecisionRows).toEqual([]);
  }

  it("refuses a comment approval when the locked issue carries a different canonical PR set", async () => {
    const preTx = inReviewIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    // The concurrent writer rebinds a SECOND pull request after the comment
    // path already verified the set against `preTx`. The claim still names
    // only #1202, so the canonical set no longer matches what was reviewed.
    mockIssueDoneGateService.listBoundPullRequests.mockImplementation(async (issue: {
      description?: string | null;
    }) =>
      issue.description === "PR #1202 + #1203"
        ? [boundPr1202, { ...boundPr1202, number: 1203 }]
        : [boundPr1202],
    );
    mockIssueService.getByIdForUpdate.mockResolvedValue({
      ...preTx,
      description: "PR #1202 + #1203",
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: { status?: string }) => ({
      ...preTx,
      ...patch,
    }));

    const res = await request(await createApp(reviewerActor))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "## Review: APPROVED\n\nReviewed the current head.",
        reviewedPullRequests: [
          { owner: "Spark-Mojo", repo: "paperclip", number: 1202, headSha: reviewedHead },
        ],
      });

    expect(res.status).toBe(409);
    expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();
    expectNothingDurable();
  }, 60_000);

  it("refuses a comment approval when the locked issue's execution policy changed", async () => {
    const preTx = inReviewIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    // A second participant is added after verification, so the policy
    // fingerprint the approval would be bound to is no longer the live one.
    mockIssueService.getByIdForUpdate.mockResolvedValue({
      ...preTx,
      executionPolicy: normalizeIssueExecutionPolicy(
        reviewPolicy([
          { id: participantId, agentId: reviewerAgentId },
          { id: "88888888-8888-4888-8888-888888888888", agentId: "99999999-9999-4999-8999-999999999999" },
        ]),
      ),
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: { status?: string }) => ({
      ...preTx,
      ...patch,
    }));

    const res = await request(await createApp(reviewerActor))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "## Review: APPROVED\n\nReviewed the current head.",
        reviewedPullRequests: [
          { owner: "Spark-Mojo", repo: "paperclip", number: 1202, headSha: reviewedHead },
        ],
      });

    expect(res.status).toBe(409);
    expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();
    expectNothingDurable();
  }, 60_000);

  it("refuses a comment approval when the locked head moved past the reviewed head", async () => {
    const preTx = inReviewIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    // The PR head advances between the pre-transaction verification and the
    // commit. The claim named the head the reviewer actually read.
    let reads = 0;
    mockGithubMerge.createPullRequestMergeDetailsResolver.mockImplementation(() => async () => {
      reads += 1;
      return {
        state: "open",
        headRef: null,
        headSha: reads <= 2 ? reviewedHead : movedHead,
        workProductState: "open",
      };
    });
    mockIssueService.getByIdForUpdate.mockResolvedValue(preTx);
    mockIssueService.update.mockImplementation(async (_id: string, patch: { status?: string }) => ({
      ...preTx,
      ...patch,
    }));

    const res = await request(await createApp(reviewerActor))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "## Review: APPROVED\n\nReviewed the current head.",
        reviewedPullRequests: [
          { owner: "Spark-Mojo", repo: "paperclip", number: 1202, headSha: reviewedHead },
        ],
      });

    expect(res.status).toBe(409);
    expect(reads).toBeGreaterThan(0);
    expectNothingDurable();
  }, 60_000);

  it("allows a comment approval when the locked snapshot and PR set are unchanged", async () => {
    const preTx = inReviewIssue();
    mockIssueService.getById.mockResolvedValue(preTx);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => preTx);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...preTx,
      ...patch,
    }));

    const res = await request(await createApp(reviewerActor))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "## Review: APPROVED\n\nReviewed the current head.",
        reviewedPullRequests: [
          { owner: "Spark-Mojo", repo: "paperclip", number: 1202, headSha: reviewedHead },
        ],
      });

    expect(res.status).toBe(201);
    expect(mockIssueDoneGateService.handles).toContain(mockTx);
    // SPA-9396: the binding rows are locked on the SAME transaction, after the
    // issue row, so a work-product URL update or a comment soft-delete cannot
    // unbind a PR underneath the approval.
    expect(lockedBindingTables).toEqual([
      "issue_work_products:update",
      "issue_comments:update",
    ]);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(insertedDecisionRows.length).toBe(1);
    // A premerge approval is stage participation, not terminal completion:
    // the approval decision row is durable but the card is not `done`.
    expect(insertedDecisionRows[0]!.row).toMatchObject({ stageId, outcome: "approved" });
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    const [, patch] = mockIssueService.update.mock.calls[0]!;
    expect((patch as { status?: string }).status).not.toBe("done");
  }, 60_000);
});