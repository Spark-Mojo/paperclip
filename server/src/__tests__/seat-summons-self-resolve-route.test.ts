import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  instanceSettings,
  issueRelations,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import type { CreateIssueThreadInteraction } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  evaluateSeatSummonsResolve,
  getSeatSummonsAuthor,
  isSeatSummonsHydratedInteraction,
} from "../services/seat-summons-self-resolve-guard.js";
import {
  ASSIGNEE_AGENT_ID,
  createSummonsApp,
  CREATED_AGENT_ID,
  ISSUE_ID,
  RUN_1,
  setupSummonsHarness,
  type SummonsHarnessMocks,
  summonsInteraction,
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

describe.sequential("seat-summons self-resolve route wiring (SPA-13735)", () => {
  beforeEach(() => setupSummonsHarness(mocks), 60_000);

  it("refuses creator self-resolve of a seat summons via the reject route with creator_self_resolve_refused", async () => {
    mocks.interactionService.getForIssue.mockResolvedValueOnce(summonsInteraction({
      prAuthorActorId: ASSIGNEE_AGENT_ID, prAuthorActorType: "agent", createdByAgentId: CREATED_AGENT_ID,
    }));
    const app = await createSummonsApp(mocks, { type: "agent", agentId: CREATED_AGENT_ID, companyId: "company-1", runId: RUN_1 });
    const res = await request(app).post(`/api/issues/${ISSUE_ID}/interactions/interaction-summons/reject`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({ code: "creator_self_resolve_refused" });
    // The shared authorization helper runs before the reject mutation too:
    // proves the self-resolve guard covers accept + reject, not just accept.
    expect(mocks.interactionService.rejectInteraction).not.toHaveBeenCalled();
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.thread_interaction_seat_summons_self_resolve_refused",
        details: expect.objectContaining({ interactionId: "interaction-summons", code: "creator_self_resolve_refused" }),
      }),
    );
  });
});

// Persistence proof (SPA-13735 d15/d16/d18): the request_confirmation zod
// schema now carries additive OPTIONAL `tags` / `prAuthorActorId` /
// `prAuthorActorType`, and the server derives the author pair at create time
// (client-supplied values are ignored/overwritten). This test proves the NEW
// behavior through interactionService.create -> getForIssue at service level
// (full-route with real DB is infeasible — the vi.mock registry above is
// file-scoped; the mock test above already pins 403 + audit).
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("seat-summons persistence gap (SPA-13735 d12)", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seat-summons-gap-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(workspaceOperations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("round-trips tags plus server-derived author, and the guard refuses self-resolve", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const authorAgentId = randomUUID();
    // Distinct from the server-derived author: the create path stamps author
    // == actor, so the author!=creator evaluator branch takes creator from
    // here (pure-function input, not a row).
    const creatorAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({ id: goalId, companyId, title: "Summons gap", level: "task", status: "active" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Seat summons parent",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(agents).values({
      id: authorAgentId,
      companyId,
      name: "SeatAuthor",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Take the seat?",
          tags: ["seat-summons", "sable-seat"],
          // FORGED: server must ignore/overwrite with the actor below.
          prAuthorActorId: "forged-attacker-id",
          prAuthorActorType: "agent",
        },
      } as unknown as CreateIssueThreadInteraction,
      { agentId: authorAgentId },
    );

    const hydrated = await interactionsSvc.getForIssue({ id: issueId, companyId }, created.id);
    expect(hydrated.kind).toBe("request_confirmation");
    if (hydrated.kind !== "request_confirmation") throw new Error("expected request_confirmation");
    // Tags + server-derived author survive the real pipeline.
    expect(hydrated.payload).toMatchObject({ version: 1, prompt: "Take the seat?" });
    expect(hydrated.payload.tags).toEqual(["seat-summons", "sable-seat"]);
    expect(hydrated.payload.prAuthorActorId).toBe(authorAgentId);
    expect(hydrated.payload.prAuthorActorId).not.toBe("forged-attacker-id");
    expect(hydrated.payload.prAuthorActorType).toBe("agent");
    expect(isSeatSummonsHydratedInteraction(hydrated)).toBe(true);
    expect(getSeatSummonsAuthor(hydrated)).toEqual({
      prAuthorActorId: authorAgentId,
      prAuthorActorType: "agent",
    });

    const base = {
      isSummons: true,
      prAuthorActorId: authorAgentId,
      prAuthorActorType: "agent",
      creatorAgentId,
      creatorUserId: null,
    } as const;
    // Resolver IS the PR author -> author self-resolve refused.
    expect(
      evaluateSeatSummonsResolve({ ...base, resolverActorId: authorAgentId, resolverActorType: "agent" }),
    ).toMatchObject({ allowed: false, code: "author_actor_self_resolve_refused" });
    // Resolver IS the creator (not the author) -> creator self-resolve refused.
    expect(
      evaluateSeatSummonsResolve({ ...base, resolverActorId: creatorAgentId, resolverActorType: "agent" }),
    ).toMatchObject({ allowed: false, code: "creator_self_resolve_refused" });
    // Third party (neither author nor creator) -> allow.
    expect(
      evaluateSeatSummonsResolve({ ...base, resolverActorId: randomUUID(), resolverActorType: "agent" }),
    ).toMatchObject({ allowed: true, code: "allow" });
  });
});
