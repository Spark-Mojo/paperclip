import express from "express";
import { vi } from "vitest";

// Fixtures: single source for the seat-summons suite (allow + route import these).
export const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
export const UNRELATED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
export const CREATED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
export const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const RUN_1 = "d1111111-1111-4111-8111-111111111111";
export const RUN_2 = "d2222222-2222-4222-8222-222222222222";
export const RUN_3 = "d3333333-3333-4333-8333-333333333333";

// NOTE (vitest architecture, not style): vi.hoisted instances and vi.mock
// registrations are scoped to the test file whose registry runs them, so allow +
// route MUST declare their own copies of the mock objects and pass them in via
// SummonsHarnessMocks. Only the logic below is shared (defined once, here);
// importing mock *objects* across test files would bind the wrong registry.
type MockFn = ReturnType<typeof vi.fn>;
export interface SummonsHarnessMocks {
  issueService: { getById: MockFn; listReviewAttention: MockFn };
  interactionService: {
    listForIssue: MockFn; getForIssue: MockFn; acceptInteraction: MockFn; rejectInteraction: MockFn;
    expireRequestConfirmationsSupersededByHistoricalComments: MockFn; expirePendingInteractionsForTerminalIssue: MockFn;
  };
  agentCompany: { value: string };
  questionDeliveries: { deliver: MockFn };
  requestNativeCancel: MockFn;
  resolveWatchdogScope: MockFn;
  resolveTrustPreset: MockFn;
  runAttribution: { value: Record<string, unknown> | null };
  heartbeatService: { wakeup: MockFn; cancelRun: MockFn };
  accessDecide: MockFn;
  logActivity: MockFn;
  reviewTransition: { value: null | { actorType: string; actorId: string; details: Record<string, unknown> } };
  dbSelect: MockFn;
  dbSelectFrom: MockFn;
  dbSelectWhere: MockFn;
  crossIssueInfluence: { sourceIssueId: string | null; priorCount: number; inserted: Array<Record<string, unknown>> };
  db: { select: MockFn; transaction: MockFn };
}
export function registerModuleMocks(m: SummonsHarnessMocks) {
  vi.doMock("../services/question-response-delivery.js", () => ({
    questionResponseDeliveryService: () => m.questionDeliveries,
  }));
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({ getById: vi.fn(async () => ({ id: "company-1" })) }),
    accessService: () => ({ canUser: vi.fn(async () => true), decide: m.accessDecide, hasPermission: vi.fn(async () => true) }),
    agentService: () => ({
      getById: vi.fn(async () => ({ id: CREATED_AGENT_ID, companyId: m.agentCompany.value, permissions: null })),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({ ambiguous: false, agent: { id: raw } })),
    }),
    clampIssueListLimit: (value: number) => value,
    companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
    ISSUE_LIST_DEFAULT_LIMIT: 500, ISSUE_LIST_MAX_LIMIT: 1000,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}), executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}), heartbeatService: () => m.heartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({ id: "instance-settings-1", general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" } })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined, syncDocument: async () => undefined, syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null), listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => m.issueService,
    issueThreadInteractionService: () => m.interactionService,
    taskWatchdogService: () => ({
      getActiveForIssue: vi.fn(async () => null), upsertForIssue: vi.fn(), disableForIssue: vi.fn(async () => null),
      revalidateMutationScope: vi.fn(async (scope: unknown) => ({ allowed: true, scope })),
    }),
    logActivity: m.logActivity, projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}
export function createIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID, companyId: "company-1", status: "in_progress", workMode: "standard", priority: "medium",
    projectId: null, goalId: null, parentId: null, assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null,
    createdByUserId: "local-board", identifier: "PAP-1714", title: "Persist interactions",
    executionPolicy: null, executionState: null, hiddenAt: null, ...overrides,
  };
}
export function loadAppModules() {
  return Promise.all([import("../routes/issues.js"), import("../middleware/index.js")]);
}
export async function createSummonsApp(m: SummonsHarnessMocks, actor: Record<string, unknown> = {
  type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false,
}, routeOptions: Record<string, unknown> = {}) {
  if (actor.type === "agent") {
    m.runAttribution.value = {
      runId: actor.runId, companyId: actor.companyId ?? "company-1",
      agentId: actor.agentId, responsibleUserId: actor.onBehalfOfUserId ?? null,
    };
  }
  const [{ issueRoutes }, { errorHandler }] = await loadAppModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", issueRoutes(m.db as any, {} as any, routeOptions));
  app.use(errorHandler);
  return app;
}
export function summonsInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: "interaction-summons", kind: "sable-seat-summons", status: "pending",
    createdByAgentId: CREATED_AGENT_ID, createdByUserId: null, sourceRunId: RUN_1,
    requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
    continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Take the seat?" }, ...overrides,
  };
}
export async function setupSummonsHarness(m: SummonsHarnessMocks) {
  vi.resetModules();
  vi.doUnmock("../routes/issues.js"); vi.doUnmock("../routes/authz.js"); vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../services/index.js");
  registerModuleMocks(m);
  vi.resetAllMocks();
  m.runAttribution.value = { companyId: "company-1", agentId: CREATED_AGENT_ID, responsibleUserId: null };
  m.agentCompany.value = "company-1";
  m.questionDeliveries.deliver.mockResolvedValue(null);
  m.requestNativeCancel.mockResolvedValue(null);
  m.resolveWatchdogScope.mockResolvedValue({ kind: "none" });
  m.resolveTrustPreset.mockReturnValue({ kind: "standard" });
  m.accessDecide.mockImplementation(async (input: { action?: string }) => ({
    allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "Allowed by test grant.",
  }));
  m.issueService.getById.mockResolvedValue(createIssue());
  m.issueService.listReviewAttention.mockResolvedValue(new Map());
  m.interactionService.listForIssue.mockResolvedValue([]);
  m.interactionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
  m.interactionService.expirePendingInteractionsForTerminalIssue.mockResolvedValue([]);
  m.interactionService.acceptInteraction.mockResolvedValue({
    interaction: {
      id: "interaction-summons", companyId: "company-1", issueId: ISSUE_ID, kind: "sable-seat-summons",
      status: "accepted", continuationPolicy: "none", requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone", payload: { version: 1, prompt: "Take the seat?" },
      result: { version: 1, outcome: "accepted" },
    },
    createdIssues: [],
  });
  m.dbSelect.mockImplementation(() => ({ from: m.dbSelectFrom }));
  m.dbSelectFrom.mockImplementation(() => ({ where: m.dbSelectWhere }));
  m.dbSelectWhere.mockImplementation(() => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(m.runAttribution.value ? [m.runAttribution.value] : []).then(onFulfilled, onRejected),
    orderBy: () => ({ limit: () => Promise.resolve(m.reviewTransition.value ? [m.reviewTransition.value] : []) }),
  }));
  m.reviewTransition.value = null;
  m.crossIssueInfluence.sourceIssueId = ISSUE_ID;
  m.crossIssueInfluence.priorCount = 0;
  m.crossIssueInfluence.inserted.length = 0;
  await loadAppModules();
}
