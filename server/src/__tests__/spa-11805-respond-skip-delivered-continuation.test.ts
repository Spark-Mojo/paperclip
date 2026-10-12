/**
 * SPA-11805 scope (b):
 *
 *   B1 — `/respond` must not arm a `wake_assignee` continuation when the
 *        delivery service just delivered the answer into a live run.
 *   B2 — a pending continuation wake for the same interaction, armed before
 *        delivery landed, must be cancelled once delivery lands, while
 *        claimed/running rows (a live run) and other issues' rows survive.
 *
 * The two halves need different harnesses: B1 is a route decision, B2 is a SQL
 * side effect inside the real delivery service. The route half runs against the
 * mocked service (as `issue-thread-interaction-routes.test.ts` does); the
 * service half runs against embedded Postgres.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  issueComments,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";

// ---------------------------------------------------------------------------
// B1 — route-level skip
// ---------------------------------------------------------------------------

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
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

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  cancelRun: vi.fn(async () => null),
}));
const mockQuestionResponseDeliveries = vi.hoisted(() => ({
  deliver: vi.fn(),
  sweepPending: vi.fn(),
}));
const mockRunAttribution = vi.hoisted(() => ({
  value: {
    companyId: "company-1",
    agentId: "22222222-2222-4222-8222-222222222222",
    responsibleUserId: null,
  } as Record<string, unknown> | null,
}));
const mockAccessDecide = vi.hoisted(() =>
  vi.fn(async (input: { action?: string }) => ({
    allowed: true,
    action: input.action,
    reason: "allow_explicit_grant",
    explanation: "Allowed by test grant.",
  })),
);
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockReviewTransition = vi.hoisted(() => ({
  value: null as null | Record<string, unknown>,
}));
const mockDbSelectWhere = vi.hoisted(() =>
  vi.fn(() => ({
    then: (
      onFulfilled: (rows: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve(
        mockRunAttribution.value ? [mockRunAttribution.value] : [],
      ).then(onFulfilled, onRejected),
    orderBy: () => ({
      limit: () =>
        Promise.resolve(
          mockReviewTransition.value ? [mockReviewTransition.value] : [],
        ),
    }),
  })),
);
const mockDbSelectFrom = vi.hoisted(() =>
  vi.fn(() => ({ where: mockDbSelectWhere })),
);
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDbTransaction = vi.hoisted(() =>
  vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback({
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () => {
            if (Object.keys(selection).includes("count")) {
              return { then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: 0 }]) };
            }
            const run = mockRunAttribution.value;
            return {
              for: () => ({
                then: (resolve: (rows: unknown[]) => unknown) =>
                  resolve(
                    run
                      ? [
                          {
                            id: run.runId ?? null,
                            companyId: run.companyId ?? null,
                            agentId: run.agentId ?? null,
                            responsibleUserId: run.responsibleUserId ?? null,
                            contextSnapshot: { issueId: ISSUE_ID },
                          },
                        ]
                      : [],
                  ),
              }),
            };
          },
        }),
      }),
      insert: () => ({ values: async () => undefined }),
    }),
  ),
);
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: mockDbTransaction,
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
  trackInteractionCreated: vi.fn(),
  trackInteractionResolved: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({
    track: vi.fn(),
    trackDynamic: vi.fn(),
  })),
}));

vi.mock("../services/task-watchdog-scope.js", () => ({
  TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
  resolveTaskWatchdogMutationScope: vi.fn(async () => ({ kind: "none" })),
  taskWatchdogScopeAllowsIssueMutation: vi.fn(async (_db, scope) => scope),
}));

vi.mock("../services/trust-preset-resolver.js", () => ({
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH: 100,
  resolveCoreTrustPreset: vi.fn(() => ({ kind: "standard" })),
}));

function registerModuleMocks() {
  vi.doMock("../services/question-response-delivery.js", () => ({
    questionResponseDeliveryService: () => mockQuestionResponseDeliveries,
  }));
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({ getById: vi.fn(async () => ({ id: "company-1" })) }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: mockAccessDecide,
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => ({
        id: CREATED_AGENT_ID,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
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
    issueThreadInteractionService: () => mockInteractionService,
    taskWatchdogService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      upsertForIssue: vi.fn(),
      disableForIssue: vi.fn(async () => null),
      revalidateMutationScope: vi.fn(async (scope: unknown) => ({ allowed: true, scope })),
    }),
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

function boardIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "SPA-11805",
    title: "Continuation skip",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function answeredInteraction() {
  return {
    id: "interaction-2",
    companyId: "company-1",
    issueId: ISSUE_ID,
    kind: "ask_user_questions",
    status: "answered",
    continuationPolicy: "wake_assignee",
    idempotencyKey: null,
    sourceCommentId: "comment-2",
    sourceRunId: RUN_2,
    payload: {
      version: 1,
      questions: [
        {
          id: "scope",
          prompt: "Scope?",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        },
      ],
    },
    result: { version: 1, answers: [{ questionId: "scope", optionIds: ["phase-1"] }] },
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-20T12:06:00.000Z",
    resolvedAt: "2026-04-20T12:06:00.000Z",
  };
}

async function createRouteApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("SPA-11805 B1: /respond skips the continuation wake after a delivered answer", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockRunAttribution.value = {
      companyId: "company-1",
      agentId: CREATED_AGENT_ID,
      responsibleUserId: null,
    };
    mockQuestionResponseDeliveries.deliver.mockResolvedValue(null);
    mockAccessDecide.mockImplementation(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));
    mockIssueService.getById.mockResolvedValue(boardIssue());
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockInteractionService.listForIssue.mockResolvedValue([]);
    mockInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
    mockInteractionService.expirePendingInteractionsForTerminalIssue.mockResolvedValue([]);
    mockInteractionService.getForIssue.mockResolvedValue(answeredInteraction());
    mockInteractionService.answerQuestions.mockResolvedValue(answeredInteraction());
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockReviewTransition.value = null;
    await Promise.all([
      vi.importActual("../routes/issues.js"),
      vi.importActual("../middleware/index.js"),
    ]);
  }, 60_000);

  const respond = async () => {
    const app = await createRouteApp();
    return request(app)
      .post(`/api/issues/${ISSUE_ID}/interactions/interaction-2/respond`)
      .send({ answers: [{ questionId: "scope", optionIds: ["phase-1"] }] });
  };

  it("skips the continuation wake when the answer steered into a live run", async () => {
    mockQuestionResponseDeliveries.deliver.mockResolvedValue({
      deliveryId: "delivery-1",
      status: "delivered",
      mode: "steered",
      targetRunId: RUN_2,
      targetTurnId: "turn-1",
      duplicate: false,
    });

    const res = await respond();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockQuestionResponseDeliveries.deliver).toHaveBeenCalledWith("interaction-2");
    // The answer is already in the live run: no second wake for it.
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("skips the continuation wake when the answer coalesced into a queued successor run", async () => {
    mockQuestionResponseDeliveries.deliver.mockResolvedValue({
      deliveryId: "delivery-1",
      status: "delivered",
      mode: "coalesced",
      targetRunId: RUN_2,
      targetTurnId: null,
      duplicate: false,
    });

    const res = await respond();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  // POSITIVE control: the skip is conditional on delivery having landed. A
  // pending patch-style delivery (or a suppressed/failed delivery that returns
  // null) must still wake the assignee, which is the SPA-11242 behaviour.
  it("still queues the continuation wake when delivery did not land", async () => {
    mockQuestionResponseDeliveries.deliver.mockResolvedValue(null);

    const res = await respond();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        idempotencyKey: "interaction:interaction-2:answered",
        payload: expect.objectContaining({
          interactionId: "interaction-2",
          interactionStatus: "answered",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// B2 — delivery-side cancel, against real SQL
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres(
  "SPA-11805 B2: a delivered answer cancels the pending continuation wake",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa11805-b2-");
      db = createDb(tempDb.connectionString);
    }, 30_000);

    afterEach(async () => {
      await db.delete(issueQuestionResponseDeliveries);
      await db.delete(issueThreadInteractions);
      await db.delete(issueComments);
      await db.delete(activityLog);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(issues);
      await db.delete(goals);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    async function seedSteerableQuestion() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const goalId = randomUUID();
      const issueId = randomUUID();
      const sourceRunId = randomUUID();
      const successorRunId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "B2 cancel",
        issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Runner",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Test",
        level: "task",
        status: "active",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        title: "Deliver answers",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      await db.insert(heartbeatRuns).values({
        id: sourceRunId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "succeeded",
        runtimeMode: "native",
        driverKind: "codex",
        contextSnapshot: { issueId },
        finishedAt: new Date(),
      });
      await db.insert(heartbeatRuns).values({
        id: successorRunId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "running",
        runtimeMode: "native",
        driverKind: "codex",
        contextSnapshot: { issueId },
        startedAt: new Date(),
      });
      const interactionSvc = issueThreadInteractionService(db);
      const interaction = await interactionSvc.create(
        { id: issueId, companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          sourceRunId,
          payload: {
            version: 1,
            title: "Server choices",
            questions: [
              {
                id: "runtime",
                prompt: "Which runtime?",
                selectionMode: "single",
                required: true,
                options: [
                  { id: "node", label: "Node.js" },
                  { id: "bun", label: "Bun" },
                ],
              },
            ],
            questionSet: {
              schema: "paperclip.question_set.v1",
              title: "Server choices",
              questions: [
                {
                  id: "runtime",
                  header: "Runtime",
                  prompt: "Which runtime?",
                  required: true,
                  answerMode: "single_select",
                  options: [
                    { id: "node", label: "Node.js" },
                    { id: "bun", label: "Bun" },
                  ],
                },
              ],
            },
          },
        },
        { agentId, runId: sourceRunId },
      );
      const answered = await interactionSvc.answerQuestions(
        { id: issueId, companyId, status: "in_progress" },
        interaction.id,
        { answers: [{ questionId: "runtime", optionIds: ["node"] }] },
        { userId: "board-user" },
      );
      return { companyId, agentId, issueId, sourceRunId, successorRunId, interaction: answered };
    }

    async function readWake(id: string) {
      return db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, id))
        .then((rows) => rows[0] ?? null);
    }

    it("cancels a pending wake_assignee continuation and spares live and foreign rows", async () => {
      const seeded = await seedSteerableQuestion();

      // The route-shaped continuation wake for THIS interaction, armed before
      // delivery landed (the interleaving the advisor flagged).
      const pending = await db
        .insert(agentWakeupRequests)
        .values({
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: {
            issueId: seeded.issueId,
            interactionId: seeded.interaction.id,
            interactionStatus: "answered",
            mutation: "interaction",
          },
          idempotencyKey: `interaction:${seeded.interaction.id}:answered`,
          status: "queued",
        })
        .returning()
        .then((rows) => rows[0]!);
      // Delivery-service-shaped wake for the same interaction.
      const serviceWake = await db
        .insert(agentWakeupRequests)
        .values({
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId: seeded.issueId, interactionId: seeded.interaction.id },
          idempotencyKey: `question-response:${seeded.interaction.id}`,
          status: "deferred_issue_execution",
        })
        .returning()
        .then((rows) => rows[0]!);
      // A DIFFERENT interaction's pending wake must survive.
      const foreign = await db
        .insert(agentWakeupRequests)
        .values({
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId: seeded.issueId, interactionId: "interaction-other" },
          idempotencyKey: "interaction:interaction-other:answered",
          status: "queued",
        })
        .returning()
        .then((rows) => rows[0]!);
      // A claimed row for THIS interaction belongs to a live run: B2 must not
      // kill it.
      const claimedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: claimedRunId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "automation",
        status: "running",
        runtimeMode: "native",
        driverKind: "codex",
        contextSnapshot: { issueId: seeded.issueId },
        startedAt: new Date(),
      });
      const claimed = await db
        .insert(agentWakeupRequests)
        .values({
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId: seeded.issueId, interactionId: seeded.interaction.id },
          idempotencyKey: `question-response:${seeded.interaction.id}:claimed`,
          status: "claimed",
          runId: claimedRunId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const service = questionResponseDeliveryService(db, {
        heartbeat: { wakeup: vi.fn() } as never,
        steer: vi.fn().mockResolvedValue({ turnId: "turn-b2" }),
      });
      const outcome = await service.deliver(seeded.interaction.id);

      expect(outcome).toMatchObject({ status: "delivered", mode: "steered" });

      expect(await readWake(pending.id)).toMatchObject({
        status: "cancelled",
        error: "question_response_delivered",
      });
      expect(await readWake(serviceWake.id)).toMatchObject({
        status: "cancelled",
        error: "question_response_delivered",
      });
      // POSITIVE controls: live work and other interactions survive.
      expect(await readWake(claimed.id)).toMatchObject({ status: "claimed" });
      expect(await readWake(foreign.id)).toMatchObject({ status: "queued" });
    });

    it("leaves pending wakes alone when delivery did not land", async () => {
      const seeded = await seedSteerableQuestion();
      const pending = await db
        .insert(agentWakeupRequests)
        .values({
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId: seeded.issueId, interactionId: seeded.interaction.id },
          idempotencyKey: `interaction:${seeded.interaction.id}:answered`,
          status: "queued",
        })
        .returning()
        .then((rows) => rows[0]!);

      // No steer seam: delivery falls back to a wake, and that path must leave
      // the pre-armed continuation wake untouched (it is the wake the fallback
      // path itself relies on).
      const fallbackRunId = randomUUID();
      const wakeup = vi.fn(async () =>
        db
          .insert(heartbeatRuns)
          .values({
            id: fallbackRunId,
            companyId: seeded.companyId,
            agentId: seeded.agentId,
            invocationSource: "automation",
            status: "queued",
            runtimeMode: "legacy",
            driverKind: "codex",
            contextSnapshot: { issueId: seeded.issueId },
          })
          .returning()
          .then((rows) => rows[0]!),
      );
      const service = questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
      });
      const outcome = await service.deliver(seeded.interaction.id);

      expect(outcome).toMatchObject({
        status: "fallback_queued",
        mode: "wake_fallback",
      });
      expect(await readWake(pending.id)).toMatchObject({ status: "queued" });
    });
  },
);
