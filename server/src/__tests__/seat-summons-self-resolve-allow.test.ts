import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSIGNEE_AGENT_ID,
  createSummonsApp,
  CREATED_AGENT_ID,
  ISSUE_ID,
  RUN_1,
  RUN_2,
  RUN_3,
  setupSummonsHarness,
  type SummonsHarnessMocks,
  summonsInteraction,
  UNRELATED_AGENT_ID,
} from "./seat-summons-harness.js";

// Per-file mock registry: vi.hoisted/vi.mock are scoped to this file's module
// registry, so these declarations are local. The shared register/create/setup
// logic above is imported and operates on this bundle (passed as `mocks`).
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn(), listReviewAttention: vi.fn(), addComment: vi.fn() }));
const mockInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(), getForIssue: vi.fn(), create: vi.fn(), acceptInteraction: vi.fn(),
  acceptSuggestedTasks: vi.fn(), rejectInteraction: vi.fn(), rejectSuggestedTasks: vi.fn(),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(),
  expirePendingInteractionsForTerminalIssue: vi.fn(), answerQuestions: vi.fn(),
  submitItemVerdicts: vi.fn(), cancelQuestions: vi.fn(), skipInteraction: vi.fn(),
  withdrawInteraction: vi.fn(), recordSecretProposalExecutionResult: vi.fn(),
}));
const mockAgentCompany = vi.hoisted(() => ({ value: "company-1" }));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn(async () => undefined), cancelRun: vi.fn(async () => null) }));
const mockRequestNativeQuestionRunCancellation = vi.hoisted(() => vi.fn(async () => null as string | null));
vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  requestNativeQuestionRunCancellation: mockRequestNativeQuestionRunCancellation,
  validateNativeQuestionResponseInput: vi.fn(),
}));
const mockQuestionResponseDeliveries = vi.hoisted(() => ({ deliver: vi.fn(async () => null) }));
const mockResolveTaskWatchdogMutationScope = vi.hoisted(() => vi.fn(async () => ({ kind: "none" })));
const mockResolveCoreTrustPreset = vi.hoisted(() => vi.fn(() => ({ kind: "standard" })));
const mockRunAttribution = vi.hoisted(() => ({
  value: { companyId: "company-1", agentId: "22222222-2222-4222-8222-222222222222", responsibleUserId: null } as Record<string, unknown> | null,
}));
const mockAccessDecide = vi.hoisted(() => vi.fn(async (input: { action?: string }) => ({
  allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "Allowed by test grant.",
})));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockReviewTransition = vi.hoisted(() => ({
  value: null as null | { actorType: string; actorId: string; details: Record<string, unknown> },
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ companyId: "company-1", agentId: CREATED_AGENT_ID, contextSnapshot: null }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockCrossIssueInfluence = vi.hoisted(() => ({
  sourceIssueId: null as string | null, priorCount: 0, inserted: [] as Array<Record<string, unknown>>,
}));
const mockDbTransaction = vi.hoisted(() => vi.fn(async (callback: (tx: unknown) => unknown) => callback({
  select: (selection: Record<string, unknown>) => ({
    from: () => ({
      where: () => {
        if (Object.keys(selection).includes("count")) {
          return { then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: mockCrossIssueInfluence.priorCount }]) };
        }
        const run = mockRunAttribution.value;
        return {
          for: () => ({
            then: (resolve: (rows: unknown[]) => unknown) => resolve(run ? [{
              id: run.runId ?? null, companyId: run.companyId ?? null, agentId: run.agentId ?? null,
              responsibleUserId: run.responsibleUserId ?? null,
              contextSnapshot: { issueId: mockCrossIssueInfluence.sourceIssueId },
            }] : []),
          }),
        };
      },
    }),
  }),
  insert: () => ({
    values: async (value: Record<string, unknown>) => {
      mockCrossIssueInfluence.inserted.push(value);
      if (value.action === "issue.cross_issue_influence_observed") mockCrossIssueInfluence.priorCount += 1;
    },
  }),
})));
const mockDb = vi.hoisted(() => ({ select: mockDbSelect, transaction: mockDbTransaction }));
vi.mock("@paperclipai/shared/telemetry", () => ({ trackAgentTaskCompleted: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: vi.fn(() => ({ track: vi.fn() })) }));
vi.mock("../services/task-watchdog-scope.js", () => ({
  TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
  resolveTaskWatchdogMutationScope: mockResolveTaskWatchdogMutationScope,
  taskWatchdogScopeAllowsIssueMutation: vi.fn(async (_db, scope) => scope),
}));
vi.mock("../services/trust-preset-resolver.js", () => ({
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH: 100, resolveCoreTrustPreset: mockResolveCoreTrustPreset,
}));

const mocks: SummonsHarnessMocks = {
  issueService: mockIssueService, interactionService: mockInteractionService, agentCompany: mockAgentCompany,
  questionDeliveries: mockQuestionResponseDeliveries, requestNativeCancel: mockRequestNativeQuestionRunCancellation,
  resolveWatchdogScope: mockResolveTaskWatchdogMutationScope, resolveTrustPreset: mockResolveCoreTrustPreset,
  runAttribution: mockRunAttribution, accessDecide: mockAccessDecide, logActivity: mockLogActivity,
  reviewTransition: mockReviewTransition, dbSelect: mockDbSelect, dbSelectFrom: mockDbSelectFrom,
  dbSelectWhere: mockDbSelectWhere, crossIssueInfluence: mockCrossIssueInfluence, db: mockDb,
  heartbeatService: mockHeartbeatService,
};

describe.sequential("seat-summons self-resolve allow + non-summons (SPA-13735)", () => {
  beforeEach(() => setupSummonsHarness(mocks), 60_000);

  it("lets a third-party agent resolve a seat summons without the self-resolve refusal", async () => {
    mocks.interactionService.getForIssue.mockResolvedValueOnce(summonsInteraction({
      prAuthorActorId: ASSIGNEE_AGENT_ID, prAuthorActorType: "agent", createdByAgentId: CREATED_AGENT_ID,
    }));
    const app = await createSummonsApp(mocks, { type: "agent", agentId: UNRELATED_AGENT_ID, companyId: "company-1", runId: RUN_3 });
    const res = await request(app).post(`/api/issues/${ISSUE_ID}/interactions/interaction-summons/accept`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.interactionService.acceptInteraction).toHaveBeenCalledWith(
      expect.anything(), "interaction-summons", {},
      expect.objectContaining({ agentId: UNRELATED_AGENT_ID, runId: RUN_3 }),
    );
  });

  it("leaves the non-summons resolve path unchanged", async () => {
    mocks.interactionService.getForIssue.mockResolvedValueOnce({
      id: "interaction-confirmation", kind: "request_confirmation", status: "pending",
      createdByAgentId: CREATED_AGENT_ID, sourceRunId: RUN_1,
      requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
      payload: { version: 1, prompt: "Approve this review?" },
    });
    const app = await createSummonsApp(mocks, { type: "agent", agentId: ASSIGNEE_AGENT_ID, companyId: "company-1", runId: RUN_2 });
    const res = await request(app).post(`/api/issues/${ISSUE_ID}/interactions/interaction-confirmation/accept`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.interactionService.acceptInteraction).toHaveBeenCalled();
  });
});
