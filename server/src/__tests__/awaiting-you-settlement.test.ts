import express from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DECISION_INTERACTION_KINDS,
  readRequiresManualAction,
  settleSettledAwaitingYouIssues,
} from "../services/awaiting-you-settlement.js";

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

describeEmbeddedPostgres("awaiting-you settlement sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-awaiting-you-settlement-",
    );
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function answeredQuestionInteraction(filerId: string | null) {
    return {
      id: randomUUID(),
      kind: "ask_user_questions",
      status: "answered",
      payload: {
        version: 1,
        title: "Scope?",
        questions: [
          {
            id: "scope",
            prompt: "Scope?",
            selectionMode: "single",
            options: [{ id: "phase-1", label: "Phase 1" }],
          },
        ],
      },
      result: {
        version: 1,
        answers: [{ questionId: "scope", optionIds: ["phase-1"] }],
      },
      createdByAgentId: filerId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
      createdAt: new Date(),
    };
  }

  async function seedCompany(prefixSeed: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Settlement",
      issuePrefix: `S${prefixSeed.replace(/-/g, "").slice(0, 6).toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, status = "idle") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Filer",
      status,
    });
    return agentId;
  }

  async function seedUserOwnedCard(
    companyId: string,
    filerId: string | null,
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Awaiting you card",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByAgentId: filerId,
    });
    return issueId;
  }

  /**
   * SPA-11924: a decision interaction in an arbitrary resolution state.
   * `answered` is the affirmative baseline; `expired`/`withdrawn`/`cancelled`
   * are administrative (nobody answered) and must never close a card.
   */
  function resolvedInteraction(
    filerId: string | null,
    status: string,
    result?: Record<string, unknown>,
  ) {
    const base = answeredQuestionInteraction(filerId);
    return {
      ...base,
      status,
      ...(result === undefined ? {} : { result }),
    };
  }

  /** An accepted `request_confirmation` — the affirmative work receipt. */
  function acceptedInteraction(filerId: string | null) {
    const base = answeredQuestionInteraction(filerId);
    return {
      ...base,
      kind: "request_confirmation",
      status: "accepted",
      result: { version: 1, outcome: "accepted" },
    };
  }

  function makeDeps(lists: Map<string, ReturnType<typeof answeredQuestionInteraction>[]>) {
    const comments: { issueId: string; body: string }[] = [];
    const wakeups: { agentId: string; opts: Record<string, unknown> }[] = [];
    const unblocked: string[] = [];
    // SPA-11924: the settlement arm must hand the auto-unblock wake a provenance
    // mutation, so the recorded call keeps its second argument too.
    const unblockCalls: { blockerIssueId: string; opts?: Record<string, unknown> }[] = [];
    return {
      comments,
      wakeups,
      unblocked,
      unblockCalls,
      deps: {
        issuesSvc: {
          update: async (id: string, data: { assigneeAgentId?: string | null; assigneeUserId?: string | null; status?: string }) =>
            db.update(issues).set(data).where(eq(issues.id, id)),
          addComment: async (issueId: string, body: string) => {
            comments.push({ issueId, body });
            return null;
          },
        },
        listInteractionsForIssue: async (issueId: string) =>
          lists.get(issueId) ?? [],
        enqueueWakeupFn: async (agentId: string, opts: Record<string, unknown>) => {
          wakeups.push({ agentId, opts });
          return null;
        },
        unblockDependentsFn: async (
          blockerIssueId: string,
          opts?: Record<string, unknown>,
        ) => {
          unblocked.push(blockerIssueId);
          unblockCalls.push({ blockerIssueId, opts });
          return null;
        },
      },
    };
  }

  it("hands a fully-answered card back to its live filing agent", async () => {
    const companyId = await seedCompany(randomUUID());
    // SPA-11924: `idle` is the status a healthy, not-currently-running filer
    // actually holds. The old default of "active" was a value no write path in
    // the engine ever stored, so it proved nothing about production.
    const filerId = await seedAgent(companyId, "idle");
    const issueId = await seedUserOwnedCard(companyId, filerId);
    // Negative: a second candidate with a still-pending decision must be skipped.
    const pendingIssueId = await seedUserOwnedCard(companyId, filerId);
    const lists = new Map([
      [issueId, [answeredQuestionInteraction(filerId)]],
      [pendingIssueId, [{ ...answeredQuestionInteraction(filerId), status: "pending" }]],
    ]);
    const { comments, wakeups, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 2, handedBack: 1, autoClosed: 0, keptOpen: 0, failed: 0 });
    expect(result.issueIds).toEqual([issueId]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ assigneeAgentId: filerId, assigneeUserId: null });
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({ agentId: filerId });
    expect(comments.some((c) => c.issueId === issueId)).toBe(true);
    expect(unblocked).toEqual([]);
    const [pending] = await db.select().from(issues).where(eq(issues.id, pendingIssueId));
    expect(pending).toMatchObject({ assigneeAgentId: null, assigneeUserId: "local-board" });
  }, 90_000);

  it("auto-closes an accepted card with no live filer and wakes dependents", async () => {
    const companyId = await seedCompany(randomUUID());
    const issueId = await seedUserOwnedCard(companyId, null);
    // Negative: a card with no decision interactions at all must be skipped.
    const emptyIssueId = await seedUserOwnedCard(companyId, null);
    const lists = new Map([
      [issueId, [acceptedInteraction(null)]],
      [emptyIssueId, []],
    ]);
    const { comments, wakeups, unblocked, unblockCalls, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 2, handedBack: 0, autoClosed: 1, keptOpen: 0, failed: 0 });
    expect(result.issueIds).toEqual([issueId]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("done");
    expect(unblocked).toEqual([issueId]);
    // SPA-11924: the settlement arm must stamp provenance on the wake, so a
    // reader can tell "blocker settled unexecuted" from "blocker completed".
    expect(unblockCalls).toHaveLength(1);
    expect(unblockCalls[0]?.blockerIssueId).toBe(issueId);
    expect(JSON.stringify(unblockCalls[0])).toContain("blocker_settled_unexecuted");
    expect(wakeups).toEqual([]);
    expect(comments.some((c) => c.issueId === issueId)).toBe(true);
    const [empty] = await db.select().from(issues).where(eq(issues.id, emptyIssueId));
    expect(empty?.status).toBe("todo");
  }, 90_000);

  it("hands back to an idle filer and to a running filer", async () => {
    // SPA-11924 regression: the hand-back arm used to require status "active",
    // a value the engine never writes, so it was dead code and every answered
    // user-owned card was auto-closed instead.
    const companyId = await seedCompany(randomUUID());
    const idleFilerId = await seedAgent(companyId, "idle");
    const runningFilerId = await seedAgent(companyId, "running");
    const idleIssueId = await seedUserOwnedCard(companyId, idleFilerId);
    const runningIssueId = await seedUserOwnedCard(companyId, runningFilerId);
    const lists = new Map([
      [idleIssueId, [answeredQuestionInteraction(idleFilerId)]],
      [runningIssueId, [answeredQuestionInteraction(runningFilerId)]],
    ]);
    const { wakeups, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 2, handedBack: 2, autoClosed: 0, keptOpen: 0, failed: 0 });
    expect(wakeups.map((w) => w.agentId).sort()).toEqual([idleFilerId, runningFilerId].sort());
    expect(unblocked).toEqual([]);
    const [idleIssue] = await db.select().from(issues).where(eq(issues.id, idleIssueId));
    expect(idleIssue).toMatchObject({ assigneeAgentId: idleFilerId, assigneeUserId: null });
    const [runningIssue] = await db.select().from(issues).where(eq(issues.id, runningIssueId));
    expect(runningIssue).toMatchObject({ assigneeAgentId: runningFilerId, assigneeUserId: null });
  }, 90_000);

  it("does not hand back to a paused filer and does not close without a receipt", async () => {
    // SPA-11924: `paused` is assignable but NOT invokable. Handing the card to
    // a paused agent while clearing the human owner would strand it with
    // nobody, so paused must take neither arm.
    const companyId = await seedCompany(randomUUID());
    const pausedFilerId = await seedAgent(companyId, "paused");
    const issueId = await seedUserOwnedCard(companyId, pausedFilerId);
    const lists = new Map([[issueId, [answeredQuestionInteraction(pausedFilerId)]]]);
    const { comments, wakeups, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 1, handedBack: 0, autoClosed: 0, failed: 0 });
    expect(result.unprovenIssueIds).toEqual([issueId]);
    expect(wakeups).toEqual([]);
    expect(unblocked).toEqual([]);
    expect(comments).toEqual([]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "local-board" });
  }, 90_000);

  it("does not settle an expired-only card (the SPA-11439 PHI go-live shape)", async () => {
    // `expired` means nobody ever answered. Settling on it closes a PHI go-live
    // sign-off that no human ever granted.
    const companyId = await seedCompany(randomUUID());
    const filerId = await seedAgent(companyId, "running");
    const issueId = await seedUserOwnedCard(companyId, filerId);
    const expired = resolvedInteraction(filerId, "expired", {
      version: 1,
      outcome: "expired",
      reason: "no human response",
    });
    const lists = new Map([[issueId, [expired]]]);
    const { comments, wakeups, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 1, handedBack: 0, autoClosed: 0, keptOpen: 0, failed: 0 });
    expect(result.issueIds).toEqual([]);
    expect(result.unprovenIssueIds).toEqual([]);
    expect(wakeups).toEqual([]);
    expect(unblocked).toEqual([]);
    expect(comments).toEqual([]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "local-board" });
  }, 90_000);

  it("withholds auto-close when there is no accepted work receipt", async () => {
    // SPA-11924: `answered` releases the human owner but is not evidence the
    // work happened. `rejected` means the work should NOT have proceeded, so
    // `done` would misrepresent the deliverable. Neither may close.
    const companyId = await seedCompany(randomUUID());
    const answeredIssueId = await seedUserOwnedCard(companyId, null);
    const rejectedIssueId = await seedUserOwnedCard(companyId, null);
    const lists = new Map([
      [answeredIssueId, [answeredQuestionInteraction(null)]],
      [rejectedIssueId, [resolvedInteraction(null, "rejected")]],
    ]);
    const { comments, wakeups, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 2, handedBack: 0, autoClosed: 0, failed: 0 });
    expect(result.issueIds).toEqual([]);
    expect(result.unprovenIssueIds.sort()).toEqual([answeredIssueId, rejectedIssueId].sort());
    // No card comment and no dependent release: the blocker is not resolved.
    expect(comments).toEqual([]);
    expect(unblocked).toEqual([]);
    expect(wakeups).toEqual([]);
    const [answered] = await db.select().from(issues).where(eq(issues.id, answeredIssueId));
    expect(answered?.status).toBe("todo");
    const [rejected] = await db.select().from(issues).where(eq(issues.id, rejectedIssueId));
    expect(rejected?.status).toBe("todo");
  }, 90_000);

  it("does not close on a withdrawn or cancelled interaction", async () => {
    // Both mean the filing agent gave up; nobody decided anything.
    const companyId = await seedCompany(randomUUID());
    const withdrawnIssueId = await seedUserOwnedCard(companyId, null);
    const cancelledIssueId = await seedUserOwnedCard(companyId, null);
    const lists = new Map([
      [withdrawnIssueId, [resolvedInteraction(null, "withdrawn")]],
      [cancelledIssueId, [resolvedInteraction(null, "cancelled")]],
    ]);
    const { comments, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 2, handedBack: 0, autoClosed: 0, keptOpen: 0, failed: 0 });
    expect(result.issueIds).toEqual([]);
    expect(comments).toEqual([]);
    expect(unblocked).toEqual([]);
    const [withdrawn] = await db.select().from(issues).where(eq(issues.id, withdrawnIssueId));
    expect(withdrawn?.status).toBe("todo");
    const [cancelled] = await db.select().from(issues).where(eq(issues.id, cancelledIssueId));
    expect(cancelled?.status).toBe("todo");
  }, 90_000);

  it("does not treat an accepted row whose result outcome disagrees as a receipt", async () => {
    // Fail-closed cross-check: the transport status is "accepted" but the
    // recorded outcome says otherwise, so the row is not a close receipt.
    const companyId = await seedCompany(randomUUID());
    const issueId = await seedUserOwnedCard(companyId, null);
    const bogus = resolvedInteraction(null, "accepted", {
      version: 1,
      outcome: "expired",
      reason: "superseded by a newer request",
    });
    const lists = new Map([[issueId, [bogus]]]);
    const { comments, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 1, handedBack: 0, autoClosed: 0, failed: 0 });
    expect(result.unprovenIssueIds).toEqual([issueId]);
    expect(unblocked).toEqual([]);
    expect(comments).toEqual([]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");
  }, 90_000);

  it("hands back a mixed expired+answered card to a live filer instead of closing it", async () => {
    // The SPA-10394 shape: 5 interactions, 3 already expired, filer running.
    const companyId = await seedCompany(randomUUID());
    const filerId = await seedAgent(companyId, "running");
    const issueId = await seedUserOwnedCard(companyId, filerId);
    const expired = resolvedInteraction(filerId, "expired", {
      version: 1,
      outcome: "expired",
      reason: "no human response",
    });
    const lists = new Map([[issueId, [expired, expired, expired, answeredQuestionInteraction(filerId)]]]);
    const { wakeups, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 1, handedBack: 1, autoClosed: 0, failed: 0 });
    expect(result.issueIds).toEqual([issueId]);
    expect(wakeups.map((w) => w.agentId)).toEqual([filerId]);
    expect(unblocked).toEqual([]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ assigneeAgentId: filerId, assigneeUserId: null });
  }, 90_000);

  it("keeps a manual-action card open", async () => {
    // Unit-level negatives: only an exact `true` keeps a card open.
    expect(DECISION_INTERACTION_KINDS).toContain("ask_user_questions");
    expect(readRequiresManualAction({ requiresManualAction: true })).toBe(true);
    expect(readRequiresManualAction({ requiresManualAction: 1 })).toBe(false);
    expect(readRequiresManualAction({ requiresManualAction: "true" })).toBe(false);
    expect(readRequiresManualAction(null)).toBe(false);

    const companyId = await seedCompany(randomUUID());
    const filerId = await seedAgent(companyId, "idle");
    const issueId = await seedUserOwnedCard(companyId, filerId);
    const manual = {
      ...answeredQuestionInteraction(filerId),
      payload: {
        version: 1,
        title: "Deploy?",
        requiresManualAction: true,
        questions: [
          {
            id: "scope",
            prompt: "Scope?",
            selectionMode: "single",
            options: [{ id: "phase-1", label: "Phase 1" }],
          },
        ],
      },
    };
    const lists = new Map([[issueId, [manual]]]);
    const { comments, wakeups, unblocked, deps } = makeDeps(lists);

    const result = await settleSettledAwaitingYouIssues(db, deps as never);

    expect(result).toMatchObject({ scanned: 1, handedBack: 0, autoClosed: 0, keptOpen: 1, failed: 0 });
    expect(result.issueIds).toEqual([]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "local-board" });
    expect(wakeups).toEqual([]);
    expect(unblocked).toEqual([]);
    expect(comments).toEqual([]);
  }, 90_000);

  it("settles once the manual-action flag is cleared", async () => {
    const companyId = await seedCompany(randomUUID());
    const filerId = await seedAgent(companyId, "idle");
    const issueId = await seedUserOwnedCard(companyId, filerId);
    const base = answeredQuestionInteraction(filerId);
    const manual = {
      ...base,
      payload: {
        ...(base.payload as Record<string, unknown>),
        requiresManualAction: true,
      },
    };
    const lists = new Map([[issueId, [manual]]]);
    const { deps } = makeDeps(lists);

    const first = await settleSettledAwaitingYouIssues(db, deps as never);
    expect(first).toMatchObject({ scanned: 1, keptOpen: 1, handedBack: 0, autoClosed: 0 });

    // The filer clears the flag (e.g. finishes the credential/prod step);
    // the next sweep settles the card.
    lists.set(issueId, [answeredQuestionInteraction(filerId)]);
    const second = await settleSettledAwaitingYouIssues(db, deps as never);
    expect(second).toMatchObject({ scanned: 1, handedBack: 1, keptOpen: 0 });
    expect(second.issueIds).toEqual([issueId]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ assigneeAgentId: filerId, assigneeUserId: null });
  }, 90_000);
});
