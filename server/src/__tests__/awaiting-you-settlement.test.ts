import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FILER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_2 = "d2222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  listReviewAttention: vi.fn(),
  addComment: vi.fn(),
}));

const mockInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  getForIssue: vi.fn(),
  create: vi.fn(),
  acceptInteraction: vi.fn(),
  acceptSuggestedTasks: vi.fn(),
  rejectInteraction: vi.fn(),
  rejectSuggestedTasks: vi.fn(),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(),
  expirePendingInteractionsForTerminalIssue: vi.fn(),
  answerQuestions: vi.fn(),
  submitItemVerdicts: vi.fn(),
  cancelQuestions: vi.fn(),
  skipInteraction: vi.fn(),
  withdrawInteraction: vi.fn(),
  recordSecretProposalExecutionResult: vi.fn(),
}));

const mockAgentCompany = vi.hoisted(() => ({ value: "company-1" }));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  cancelRun: vi.fn(async () => null),
}));
const mockRequestNativeQuestionRunCancellation = vi.hoisted(() =>
  vi.fn(async () => null as string | null),
);

vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  requestNativeQuestionRunCancellation: mockRequestNativeQuestionRunCancellation,
  validateNativeQuestionResponseInput: vi.fn(),
}));
const mockQuestionResponseDeliveries = vi.hoisted(() => ({
  deliver: vi.fn(async () => null),
}));
const mockResolveTaskWatchdogMutationScope = vi.hoisted(() => vi.fn(async () => ({ kind: "none" })));
const mockResolveCoreTrustPreset = vi.hoisted(() => vi.fn(() => ({ kind: "standard" })));
const mockRunAttribution = vi.hoisted(() => ({
  value: {
    companyId: "company-1",
    agentId: "22222222-2222-4222-8222-222222222222",
    responsibleUserId: null,
  } as Record<string, unknown> | null,
}));
const mockAccessDecide = vi.hoisted(() => vi.fn(async (input: { action?: string }) => ({
  allowed: true,
  action: input.action,
  reason: "allow_explicit_grant",
  explanation: "Allowed by test grant.",
})));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDbTransaction = vi.hoisted(() => vi.fn(async (callback: (tx: unknown) => unknown) => callback({})));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: mockDbTransaction,
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/task-watchdog-scope.js", () => ({
  TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
  resolveTaskWatchdogMutationScope: mockResolveTaskWatchdogMutationScope,
  taskWatchdogScopeAllowsIssueMutation: vi.fn(async (_db: unknown, scope: unknown) => scope),
}));

vi.mock("../services/trust-preset-resolver.js", () => ({
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH: 100,
  resolveCoreTrustPreset: mockResolveCoreTrustPreset,
}));

function registerModuleMocks() {
  vi.doMock("../services/question-response-delivery.js", () => ({
    questionResponseDeliveryService: () => mockQuestionResponseDeliveries,
  }));
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: mockAccessDecide,
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => ({ id: FILER_AGENT_ID, companyId: mockAgentCompany.value, permissions: null })),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
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
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }),
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
    issueThreadInteractionService: () => mockInteractionService,
    taskWatchdogService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      upsertForIssue: vi.fn(),
      disableForIssue: vi.fn(async () => null),
      revalidateMutationScope: vi.fn(async (scope: unknown) => ({ allowed: true, scope })),
    }),
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function createIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "todo",
    workMode: "standard",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-1714",
    title: "Awaiting-you settlement",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function answeredInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: "interaction-2",
    companyId: "company-1",
    issueId: ISSUE_ID,
    kind: "ask_user_questions",
    status: "answered",
    continuationPolicy: "wake_assignee",
    createdByAgentId: FILER_AGENT_ID,
    idempotencyKey: null,
    sourceCommentId: "comment-2",
    sourceRunId: RUN_2,
    payload: {
      version: 1,
      questions: [{
        id: "scope",
        prompt: "Scope?",
        selectionMode: "single",
        options: [{ id: "phase-1", label: "Phase 1" }],
      }],
    },
    result: {
      version: 1,
      answers: [{ questionId: "scope", optionIds: ["phase-1"] }],
    },
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-20T12:06:00.000Z",
    resolvedAt: "2026-04-20T12:06:00.000Z",
    ...overrides,
  };
}

function loadAppModules() {
  return Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}, routeOptions: Record<string, unknown> = {}) {
  const [{ issueRoutes }, { errorHandler }] = await loadAppModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any, routeOptions));
  app.use(errorHandler);
  return app;
}

describe.sequential("awaiting-you settlement", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockAgentCompany.value = "company-1";
    mockQuestionResponseDeliveries.deliver.mockResolvedValue(null);
    mockRequestNativeQuestionRunCancellation.mockResolvedValue(null);
    mockResolveTaskWatchdogMutationScope.mockResolvedValue({ kind: "none" });
    mockResolveCoreTrustPreset.mockReturnValue({ kind: "standard" });
    mockAccessDecide.mockImplementation(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockInteractionService.getForIssue.mockResolvedValue({
      id: "interaction-2",
      kind: "ask_user_questions",
      status: "pending",
      createdByAgentId: "22222222-2222-4222-8222-222222222222",
      sourceRunId: RUN_2,
      requestedResolverPolicy: "board_or_agents",
      effectiveResolverPolicy: "board_or_agents",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, questions: [] },
    });
    mockInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
    mockInteractionService.expirePendingInteractionsForTerminalIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onFulfilled, onRejected),
    }));
    await loadAppModules();
  }, 60_000);

  it("respond resolution wakes the filing agent on a user-owned card", async () => {
    mockIssueService.getById.mockResolvedValue(createIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      status: "todo",
    }));
    mockInteractionService.answerQuestions.mockResolvedValue(answeredInteraction());

    const app = await createApp();
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/interactions/interaction-2/respond`)
      .send({ answers: [{ questionId: "scope", optionIds: ["phase-1"] }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockInteractionService.answerQuestions).toHaveBeenCalled();
    expect(mockQuestionResponseDeliveries.deliver).toHaveBeenCalledWith("interaction-2");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      FILER_AGENT_ID,
      expect.objectContaining({
        payload: expect.objectContaining({
          issueId: ISSUE_ID,
          interactionId: "interaction-2",
          interactionStatus: "answered",
        }),
      }),
    );
  }, 10_000);

  it("respond resolution with stripped continuationPolicy and no filer produces no wake (negative)", async () => {
    mockIssueService.getById.mockResolvedValue(createIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      status: "todo",
    }));
    mockInteractionService.answerQuestions.mockResolvedValue(answeredInteraction({
      continuationPolicy: "none",
      createdByAgentId: null,
    }));

    const app = await createApp();
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/interactions/interaction-2/respond`)
      .send({ answers: [{ questionId: "scope", optionIds: ["phase-1"] }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockQuestionResponseDeliveries.deliver).toHaveBeenCalledWith("interaction-2");
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  }, 10_000);
});
