import { describe, expect, it, vi } from "vitest";
import { createAdmitWakeBehindIssueExecution, createReleaseIssueExecution } from "./use-cases.js";
import type { AdmitWakeBehindIssueExecutionInput } from "./use-cases.js";
import { WakeQueueApplicationError } from "./types.js";
import type {
  DeferredWakeCandidate,
  InvokableAgentSnapshot,
  IssueLockWriter,
  IssueSnapshot,
  PromoteDeferredWakeInput,
  RecoveryEscalationPort,
  RunSnapshot,
  RunSummary,
  TransactionScope,
  WakeAdmissionActiveExecutionRun,
  WakeAdmissionHeartbeatHelpers,
  WakeAdmissionReader,
  WakeAdmissionWriter,
  WakeQueueHost,
  WakeQueueTransaction,
} from "./ports.js";

const RUN: RunSnapshot = {
  id: "run-1",
  companyId: "company-1",
  agentId: "finishing-agent",
  status: "failed",
  runtimeMode: "process",
  errorCode: null,
  responsibleUserId: "user-1",
  contextSnapshot: {},
  configurationIncompletePayload: null,
};

const ISSUE: IssueSnapshot = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "ISSUE-1",
  status: "in_progress",
  assigneeAgentId: "finishing-agent",
  assigneeUserId: null,
  hiddenAt: null,
  originKind: null,
  completedAt: null,
  cancelledAt: null,
  monitorNextCheckAt: null,
  executionState: null,
  responsibleUserId: null,
  parentId: null,
  originId: null,
  originRunId: null,
};

const AGENT: InvokableAgentSnapshot = {
  id: "deferred-agent",
  companyId: "company-1",
  name: "Deferred Agent",
  invokable: true,
};

function wakeCandidate(overrides: Partial<DeferredWakeCandidate> = {}): DeferredWakeCandidate {
  return {
    id: overrides.id ?? "wake-1",
    companyId: "company-1",
    agentId: "deferred-agent",
    reason: "issue_commented",
    source: "automation",
    triggerDetail: null,
    requestedByActorType: "user",
    requestedByActorId: "actor-1",
    payload: {},
    queuedCommentIds: [],
    preservesIndependentContinuation: false,
    deferredContextSeed: {},
    deferredCommentIds: [],
    wakeReason: "issue_commented",
    ...overrides,
  };
}

function runSummary(id: string): RunSummary {
  return {
    id,
    companyId: "company-1",
    agentId: "deferred-agent",
    invocationSource: "automation",
    triggerDetail: null,
    wakeupRequestId: `wakeup-${id}`,
  };
}

function createFakeHost(overrides: Partial<WakeQueueHost> = {}): WakeQueueHost {
  return {
    resolveResponsibleUserId: vi.fn(async () => "user-1"),
    getRoutineEnv: vi.fn(async () => ({ routineId: null, env: null, responsibleUserId: null })),
    resolveSessionBeforeForWakeup: vi.fn(async () => null),
    ...overrides,
  };
}

function createFakeTransaction(overrides: Partial<WakeQueueTransaction> = {}): WakeQueueTransaction {
  return {
    findInvokableAgent: vi.fn(async () => AGENT),
    findNextDeferredWake: vi.fn(async () => null),
    getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: [], containedSelfAuthoredComment: false })),
    cancelDeferredWake: vi.fn(async () => true),
    normalizeDeferredWakeCommentIds: vi.fn(async (input) => wakeCandidate({ id: input.wakeId, queuedCommentIds: input.liveCommentIds })),
    failDeferredWake: vi.fn(async () => true),
    getPauseHoldFacts: vi.fn(async () => ({
      activePauseHold: false,
      treeHoldInteractionWake: false,
      holdId: null,
      rootIssueId: null,
      mode: null,
      reason: null,
      releasePolicy: null,
    })),
    getCommentSelfAuthorship: vi.fn(async () => ({ allSelfAuthored: false, allAuthoredByFinishingRunAgent: false })),
    getDeferredCommentCreatedAt: vi.fn(async () => []),
    isCompletedDelegationMention: vi.fn(async () => false),
    reopenIssue: vi.fn(async () => null),
    claimDeferredWakeForPromotion: vi.fn(async () => true),
    finalizePromotedWake: vi.fn(async (input) => runSummary(input.wakeId)),
    hasExistingExecutionPath: vi.fn(async () => false),
    hasExplicitBlockerPath: vi.fn(async () => false),
    isAutomaticRecoverySuppressedByPauseHold: vi.fn(async () => false),
    isImmediateRecoverySourceBlocked: vi.fn(async () => false),
    queueReviewParticipantRecoveryRun: vi.fn(async () => runSummary("review-recovery")),
    queueImmediateRecoveryRun: vi.fn(async () => runSummary("immediate-recovery")),
    ...overrides,
  };
}

function createFakeIssueLock(host: WakeQueueHost, transaction: WakeQueueTransaction, issue = ISSUE, run = RUN): IssueLockWriter {
  return {
    withIssueExecutionLock: vi.fn(async (_input, fn) => {
      const result = await fn({ primaryIssue: issue, run }, { host, transaction });
      return { ...result, run };
    }),
  };
}

function createFakeRecovery(): RecoveryEscalationPort {
  return {
    escalateStrandedAssignedIssue: vi.fn(async () => {}),
    escalateStrandedRecoveryIssueInPlace: vi.fn(async () => {}),
  };
}

describe("releaseIssueExecution", () => {
  it.each(["closing", "mixed_comments", "explicit_resume", "interaction", "other_source_task", "parent_open"])(
    "checks late completed-delegation mentions without dropping independent input (%s)", async (scenario) => {
      const originalCommentIds = ["closing-comment", "second-comment"];
      const candidate = wakeCandidate({
        reason: "issue_comment_mentioned", wakeReason: "issue_comment_mentioned",
        requestedByActorType: "agent", requestedByActorId: RUN.agentId,
        queuedCommentIds: [originalCommentIds[0]], deferredCommentIds: originalCommentIds,
        preservesIndependentContinuation: scenario === "explicit_resume",
        payload: scenario === "interaction" ? { mutation: "interaction" } : {},
        deferredContextSeed: scenario === "explicit_resume" ? { resumeIntent: true } : {},
      });
      const queue = [candidate];
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
        isCompletedDelegationMention: vi.fn(async () => scenario !== "mixed_comments"),
        getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: [originalCommentIds[0]], containedSelfAuthoredComment: false })),
      });
      const issue = { ...ISSUE, status: scenario === "parent_open" ? "in_progress" : "done" };
      const run = { ...RUN, status: "succeeded", contextSnapshot: { issueId: scenario === "other_source_task" ? "other-issue" : ISSUE.id } };
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction, issue, run), recovery: createFakeRecovery(),
      });
      const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });
      if (scenario === "closing" || scenario === "mixed_comments") {
        expect(transaction.isCompletedDelegationMention).toHaveBeenCalledWith({
          companyId: RUN.companyId, issueId: ISSUE.id, finishingRunId: RUN.id,
          wakeAgentId: AGENT.id, commentIds: originalCommentIds,
        });
      } else {
        expect(transaction.isCompletedDelegationMention).not.toHaveBeenCalled();
      }
      if (scenario === "closing") {
        expect(result.outcome.kind).toBe("released");
        expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(1);
        expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
        expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
      } else {
        expect(result.outcome.kind).toBe("promoted");
        expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves the former owner's queue for handoff adoption while draining the new owner's wake", async () => {
    const stale = wakeCandidate({ agentId: RUN.agentId, queuedCommentIds: ["saved-user-direction"] });
    const current = wakeCandidate({ id: "wake-new-owner", agentId: "new-agent" });
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async (input: { companyId: string; issueId: string; excludedWakeIds?: string[] }) =>
        input.excludedWakeIds?.includes(stale.id) ? current : stale),
      getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: ["saved-user-direction"], containedSelfAuthoredComment: false })),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, assigneeAgentId: "new-agent" }),
      recovery: createFakeRecovery(),
    });
    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });
    expect(result.outcome.kind).toBe("promoted");
    expect(transaction.finalizePromotedWake).toHaveBeenCalledWith(expect.objectContaining({ wakeId: current.id }));
    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
  });

  it.each(["done", "in_progress"])("does not promote a former assignee's saved instruction after handoff (%s)", async (status) => {
    const queuedCommentIds = ["saved-user-direction"];
    const queue = [wakeCandidate({
      agentId: "previous-agent",
      reason: "issue_execution_deferred",
      queuedCommentIds,
      deferredCommentIds: queuedCommentIds,
      deferredContextSeed: { wakeReason: "issue_commented", wakeCommentIds: queuedCommentIds },
    })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: queuedCommentIds, containedSelfAuthoredComment: false })),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status }),
      recovery: createFakeRecovery(),
    });
    await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date(), suppressImmediateRecovery: true });
    expect(transaction.cancelDeferredWake).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-1" }));
    expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
    expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
    expect(transaction.reopenIssue).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: ISSUE.assigneeAgentId!, wakeReason: "issue_commented", preservesIndependentContinuation: false, authorizedFailedChatRetry: false },
    { agentId: "mentioned-agent", wakeReason: "issue_comment_mentioned", preservesIndependentContinuation: false, authorizedFailedChatRetry: false },
    { agentId: "interaction-agent", wakeReason: "issue_commented", preservesIndependentContinuation: true, authorizedFailedChatRetry: false },
    { agentId: "interaction-payload-agent", wakeReason: "issue_commented", preservesIndependentContinuation: false, authorizedFailedChatRetry: false, payload: { mutation: "interaction" } },
    { agentId: "chat-agent", wakeReason: "issue_commented", preservesIndependentContinuation: false, authorizedFailedChatRetry: true },
  ])("preserves the independently authorized $agentId/$wakeReason wake", async (authority) => {
    const queuedCommentIds = ["saved-user-direction"];
    const queue = [wakeCandidate({ ...authority, queuedCommentIds, deferredCommentIds: queuedCommentIds })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: queuedCommentIds, containedSelfAuthoredComment: false })),
    });
    const release = createReleaseIssueExecution({ issueLock: createFakeIssueLock(createFakeHost(), transaction), recovery: createFakeRecovery() });
    expect((await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() })).outcome.kind).toBe("promoted");
    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "preserves failed-chat retry input without reopening only with adapter proof: %s",
    async (authorizedFailedChatRetry) => {
      const queue = [
        wakeCandidate({
          agentId: authorizedFailedChatRetry ? AGENT.id : ISSUE.assigneeAgentId!,
          authorizedFailedChatRetry,
          queuedCommentIds: ["original-comment"],
          deferredCommentIds: ["original-comment"],
          deferredContextSeed: {
            issueId: ISSUE.id,
            wakeCommentIds: ["original-comment"],
            retryOfRunId: "original-failed-run",
            chatFailedRunRetry: { requestId: "exact-request" },
          },
        }),
      ];
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      });
      const host = createFakeHost();
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(host, transaction, {
          ...ISSUE,
          status: "done",
        }),
        recovery: createFakeRecovery(),
      });

      const result = await release({
        companyId: RUN.companyId,
        runId: RUN.id,
        now: new Date(),
      });

      expect(transaction.normalizeDeferredWakeCommentIds).not.toHaveBeenCalled();
      expect(transaction.reopenIssue).not.toHaveBeenCalled();
      if (authorizedFailedChatRetry) {
        expect(transaction.getQueuedCommentLiveness).not.toHaveBeenCalled();
        expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
        expect(transaction.finalizePromotedWake).toHaveBeenCalledWith(
          expect.objectContaining({
            authorizedFailedChatRetry: true,
            contextSnapshot: expect.objectContaining({
              wakeCommentIds: ["original-comment"],
              retryOfRunId: "original-failed-run",
              chatFailedRunRetry: { requestId: "exact-request" },
            }),
          }),
        );
        expect(result.outcome.kind).toBe("promoted");
      } else {
        expect(transaction.getQueuedCommentLiveness).toHaveBeenCalledTimes(1);
        expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(1);
        expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
        expect(result.outcome.kind).toBe("released");
      }
    },
  );

  it.each([false, true])(
    "applies an exact source denial only after independent deferred input: %s",
    async (hasDeferredInput) => {
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () =>
          hasDeferredInput ? wakeCandidate() : null,
        ),
        isImmediateRecoverySourceBlocked: vi.fn(async () => true),
      });
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction),
        recovery: createFakeRecovery(),
      });

      const result = await release({
        companyId: RUN.companyId,
        runId: RUN.id,
        now: new Date(),
      });

      expect(transaction.queueImmediateRecoveryRun).not.toHaveBeenCalled();
      if (hasDeferredInput) {
        expect(transaction.isImmediateRecoverySourceBlocked).not.toHaveBeenCalled();
        expect(result.outcome.kind).toBe("promoted");
      } else {
        expect(transaction.isImmediateRecoverySourceBlocked).toHaveBeenCalledWith({
          companyId: RUN.companyId,
          runId: RUN.id,
        });
        expect(result.outcome.kind).toBe("blocked");
      }
    },
  );

  it("processes the deferred wakes in requestedAt order", async () => {
    const claimOrder: string[] = [];
    const queue = [wakeCandidate({ id: "wake-earliest" }), wakeCandidate({ id: "wake-latest" })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => {
        const next = queue.shift() ?? null;
        if (next) claimOrder.push(next.id);
        return next;
      }),
      // Every wake fails invokability so the loop keeps draining without promoting.
      findInvokableAgent: vi.fn(async () => null),
    });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(claimOrder).toEqual(["wake-earliest", "wake-latest"]);
    expect(transaction.failDeferredWake).toHaveBeenCalledTimes(2);
  });

  it("stops the loop after the first promotion", async () => {
    const findNextDeferredWake = vi.fn(async () => wakeCandidate({ id: "wake-promotes" }));
    const transaction = createFakeTransaction({ findNextDeferredWake });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("promoted");
    expect(findNextDeferredWake).toHaveBeenCalledTimes(1);
  });

  it("continues the loop after a cancel outcome, a fail outcome, and a normalize outcome, then promotes", async () => {
    const queue = [
      // cancel_empty: queued comments, none live, no independent continuation.
      wakeCandidate({ id: "wake-cancel", queuedCommentIds: ["c1"] }),
      // fail_not_invokable: agent lookup misses for this one wake only.
      wakeCandidate({ id: "wake-fail", agentId: "uninvokable-agent" }),
      // normalize: queued comments differ from the live set, then promotes.
      wakeCandidate({ id: "wake-normalize", queuedCommentIds: ["c1", "c2"] }),
    ];
    const findNextDeferredWake = vi.fn(async () => queue.shift() ?? null);
    const findInvokableAgent = vi.fn(async (input: { agentId: string }) =>
      input.agentId === "deferred-agent" ? AGENT : null,
    );
    const getQueuedCommentLiveness = vi.fn(async (input: { queuedCommentIds: string[] }) =>
      input.queuedCommentIds.length === 1
        ? { liveNonSelfCommentIds: [], containedSelfAuthoredComment: false }
        : { liveNonSelfCommentIds: ["c2"], containedSelfAuthoredComment: false },
    );
    const transaction = createFakeTransaction({ findNextDeferredWake, findInvokableAgent, getQueuedCommentLiveness });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction, { ...ISSUE, assigneeAgentId: AGENT.id });
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(1);
    expect(transaction.failDeferredWake).toHaveBeenCalledTimes(1);
    expect(transaction.normalizeDeferredWakeCommentIds).toHaveBeenCalledTimes(1);
    expect(findNextDeferredWake).toHaveBeenCalledTimes(3);
    expect(result.outcome.kind).toBe("promoted");
  });

  it("rejects with deferred_wake_not_advanced when the queue read returns the same wake id twice, instead of looping forever", async () => {
    // queuedCommentIds with no live comments and no independent continuation
    // routes to "cancel_empty", so the drain calls cancelDeferredWake and
    // discards its result, then reads the queue again for the same row.
    const repeatedCandidate = wakeCandidate({ id: "wake-repeat", queuedCommentIds: ["c1"] });
    const findNextDeferredWake = vi.fn(async () => repeatedCandidate);
    const cancelDeferredWake = vi.fn(async () => false);
    const transaction = createFakeTransaction({ findNextDeferredWake, cancelDeferredWake });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await expect(
      releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() }),
    ).rejects.toMatchObject({
      constructor: WakeQueueApplicationError,
      code: "deferred_wake_not_advanced",
    });
    expect(findNextDeferredWake).toHaveBeenCalledTimes(2);
  });

  it("returns the post-commit effects as data without running them", async () => {
    const transaction = createFakeTransaction({ findNextDeferredWake: vi.fn(async () => wakeCandidate()) });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const recovery = createFakeRecovery();
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.postCommitEffects).toEqual([{ kind: "run_queued", run: runSummary("wake-1") }]);
    expect(recovery.escalateStrandedAssignedIssue).not.toHaveBeenCalled();
    expect(recovery.escalateStrandedRecoveryIssueInPlace).not.toHaveBeenCalled();
  });

  it("carries the deferred wake's raw issue, interaction, execution-stage, and accepted-plan context onto the promoted run, and clears only the rendered text projections", async () => {
    const finalizePromotedWake = vi.fn(async (input: PromoteDeferredWakeInput) => runSummary(input.wakeId));
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () =>
        wakeCandidate({
          deferredContextSeed: {
            issueId: ISSUE.id,
            wakeCommentIds: ["comment-1"],
            // A queue-time render from a prior coalesced run. Promotion must
            // not persist this alongside the current (unrelated) comment id.
            paperclipTaskMarkdown: "queue-time markdown",
            paperclipTaskMarkdownCompact: "queue-time compact markdown",
            paperclipWake: { commentId: "comment-1" },
            executionStage: { stage: "review" },
            planReviewInteraction: { acceptedTargetRevision: { revisionId: "revision-1" } },
            acceptedPlanWakeRouting: { targetAgentId: "agent-1" },
          },
        }),
      ),
      finalizePromotedWake,
    });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("promoted");
    expect(finalizePromotedWake).toHaveBeenCalledTimes(1);
    const promotedContextSnapshot = finalizePromotedWake.mock.calls[0]![0].contextSnapshot;
    // The rendered text is cleared; `executeRun` rebuilds it, with proper
    // trust-based redaction, from the current issue and comment rows before
    // the run dispatches.
    expect(promotedContextSnapshot.paperclipTaskMarkdown).toBeUndefined();
    expect(promotedContextSnapshot.paperclipTaskMarkdownCompact).toBeUndefined();
    expect(promotedContextSnapshot.paperclipWake).toBeUndefined();
    // The raw fields that render depends on are not dropped.
    expect(promotedContextSnapshot.issueId).toBe(ISSUE.id);
    expect(promotedContextSnapshot.executionStage).toEqual({ stage: "review" });
    expect(promotedContextSnapshot.planReviewInteraction).toEqual({
      acceptedTargetRevision: { revisionId: "revision-1" },
    });
    expect(promotedContextSnapshot.acceptedPlanWakeRouting).toEqual({ targetAgentId: "agent-1" });
  });

  it.each(["done", "cancelled"])("cancels stale assignee continuations before claiming promotion on %s tasks", async (status) => {
    const queue = [wakeCandidate({ agentId: ISSUE.assigneeAgentId!, requestedByActorType: "agent" })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status }),
      recovery: createFakeRecovery(),
    });

    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

    expect(transaction.cancelDeferredWake).toHaveBeenCalledWith(expect.objectContaining({
      wakeId: "wake-1",
      reason: "Deferred execution wake no longer applies to a terminal task",
    }));
    expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
    expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
    expect(result.outcome.kind).toBe("released");
  });

  // SPA-11798 / GH #1178: this used to assert the reopen unconditionally. A
  // human comment is new information only when it landed AFTER the close; the
  // stale handoff (SPA-175, SPA-10970, SPA-11067) was armed before it. The
  // reopen now survives only for post-close comments — see the pre-close
  // deferred regression block below for the full matrix.
  it("reopens a completed task before promoting its assignee's human follow-up", async () => {
    const closedAt = new Date("2026-10-03T15:28:30.000Z");
    const queue = [wakeCandidate({
      agentId: ISSUE.assigneeAgentId!,
      requestedByActorType: "user",
      deferredCommentIds: ["human-follow-up"],
    })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      getDeferredCommentCreatedAt: vi.fn(async ({ commentIds }: { commentIds: string[] }) =>
        commentIds.map((commentId) => ({ commentId, createdAt: new Date(closedAt.getTime() + 1000) }))),
      reopenIssue: vi.fn(async () => ({ ...ISSUE, status: "todo" })),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status: "done", completedAt: closedAt }),
      recovery: createFakeRecovery(),
    });

    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
    expect(transaction.finalizePromotedWake).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe("promoted");
  });

  // GH #1178 regression guard. Every deferred wake whose comments ALL predate
  // the close is a stale notification for work that already finished; it must
  // not reopen the card. Anything created after the close still reopens.
  describe("pre-close deferred comment does not reopen a terminal task", () => {
    const CLOSED_AT = new Date("2026-10-03T15:28:30.000Z");
    const BEFORE = new Date(CLOSED_AT.getTime() - 22 * 60_000);
    const AFTER = new Date(CLOSED_AT.getTime() + 40_000);

    async function runCase(input: {
      status: "done" | "cancelled";
      commentTimes: Date[];
      actorType?: "user" | "agent";
      wakeReason?: string;
      agentAuthored?: boolean;
      selfAuthored?: boolean;
      authoredByFinishingRunAgent?: boolean;
      resumeIntent?: boolean;
    }) {
      const commentIds = input.commentTimes.map((_, index) => `comment-${index}`);
      const queue = [wakeCandidate({
        agentId: ISSUE.assigneeAgentId!,
        requestedByActorType: input.actorType ?? "user",
        requestedByActorId: input.actorType === "agent" ? "delegating-agent" : "actor-1",
        wakeReason: input.wakeReason ?? "issue_commented",
        queuedCommentIds: commentIds,
        deferredCommentIds: commentIds,
        deferredContextSeed: input.resumeIntent ? { resumeIntent: true } : {},
      })];
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
        getQueuedCommentLiveness: vi.fn(async () => ({
          liveNonSelfCommentIds: commentIds,
          containedSelfAuthoredComment: input.selfAuthored === true,
        })),
        getDeferredCommentCreatedAt: vi.fn(async ({ commentIds }: { commentIds: string[] }) =>
          commentIds.map((commentId, index) => ({ commentId, createdAt: input.commentTimes[index] }))),
        getCommentSelfAuthorship: vi.fn(async () => ({
          allSelfAuthored: input.selfAuthored === true,
          allAuthoredByFinishingRunAgent: input.authoredByFinishingRunAgent === true,
        })),
        reopenIssue: vi.fn(async () => ({ ...ISSUE, status: "todo" })),
      });
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction, {
          ...ISSUE,
          status: input.status,
          completedAt: input.status === "done" ? CLOSED_AT : null,
          cancelledAt: input.status === "cancelled" ? CLOSED_AT : null,
        }),
        recovery: createFakeRecovery(),
      });
      const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });
      return { transaction, result };
    }

    it.each([
      { status: "done" as const, label: "done" },
      { status: "cancelled" as const, label: "cancelled" },
    ])("suppresses a stale user comment that predates the close ($label)", async ({ status }) => {
      const { transaction } = await runCase({ status, commentTimes: [BEFORE] });

      expect(transaction.reopenIssue).not.toHaveBeenCalled();
    });

    it("suppresses a stale board notification exactly at the close instant", async () => {
      const { transaction } = await runCase({ status: "done", commentTimes: [new Date(CLOSED_AT.getTime())] });

      expect(transaction.reopenIssue).not.toHaveBeenCalled();
    });

    it("keeps the reopen for a comment created after the close", async () => {
      const { transaction, result } = await runCase({ status: "done", commentTimes: [AFTER] });

      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
      expect(result.outcome.kind).toBe("promoted");
    });

    it("keeps the reopen for a mixed pre-close and post-close set", async () => {
      const { transaction, result } = await runCase({ status: "done", commentTimes: [BEFORE, AFTER] });

      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
      expect(result.outcome.kind).toBe("promoted");
    });

    it("keeps the reopen for a stale issue_reopened_via_comment posted after the close", async () => {
      const { transaction } = await runCase({
        status: "done",
        commentTimes: [AFTER],
        wakeReason: "issue_reopened_via_comment",
      });

      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
    });

    it("does not suppress the agent resumeIntent clause at the close instant", async () => {
      const { transaction, result } = await runCase({
        status: "done",
        commentTimes: [new Date(CLOSED_AT.getTime())],
        actorType: "agent",
        agentAuthored: true,
        resumeIntent: true,
      });

      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
      expect(result.outcome.kind).toBe("promoted");
    });

    it("keeps a self-authored closing comment from reopening", async () => {
      const { transaction } = await runCase({
        status: "done",
        commentTimes: [AFTER],
        actorType: "agent",
        selfAuthored: true,
      });

      expect(transaction.reopenIssue).not.toHaveBeenCalled();
    });

    // SPA-11805 / GH #1178 residual, first cycle of the reopen loop. The
    // closing receipt is posted AFTER the close by a PRIOR run of the same
    // agent, so `createdByRunId === finishingRunId` is false and the
    // run-keyed `allSelfAuthored` check is inert. Authorship is still the
    // finishing agent's own, which is what makes the receipt a report of
    // finished work rather than new input.
    //
    // The `wakeReason: "issue_reopened_via_comment"` arm is what makes these
    // discriminating: with a plain `issue_commented` reason and an `agent`
    // requester, the reopen expression is false on its own (no branch
    // matches), so the test would pass with or without the new guard and
    // prove nothing. Asserting on the arming path that actually reopens is
    // what makes the negative control fail when the guard is removed.
    it.each(["done", "cancelled"] as const)(
      "suppresses a prior-run closing receipt from the same agent (%s)",
      async (status) => {
        const { transaction } = await runCase({
          status,
          commentTimes: [AFTER],
          actorType: "agent",
          wakeReason: "issue_reopened_via_comment",
          authoredByFinishingRunAgent: true,
        });

        expect(transaction.reopenIssue).not.toHaveBeenCalled();
      },
    );

    // The OTHER arming path: a board user requests the wake (`actorType: "user"`,
    // which satisfies the reopen expression on its own) while the only comment
    // in the wake is the finishing agent's own closing receipt. James's SPA-10460
    // log shows the receipt posted as `agent` and the promotion attributed to
    // `system`, so the requester recorded on a deferred wake is not reliable
    // evidence that a human asked for new work. This pins that arm separately
    // from the `issue_reopened_via_comment` arm above: both must be suppressed,
    // and a fix that only closes one of them leaves the loop alive.
    it.each(["done", "cancelled"] as const)(
      "suppresses a board-requested wake whose only comment is the finishing agent's own receipt (%s)",
      async (status) => {
        const { transaction } = await runCase({
          status,
          commentTimes: [AFTER],
          actorType: "user",
          wakeReason: "issue_commented",
          authoredByFinishingRunAgent: true,
        });

        expect(transaction.reopenIssue).not.toHaveBeenCalled();
      },
    );

    // Guard the over-suppression boundary: authorship by the finishing agent
    // is not a licence to swallow a genuine human reopen of the same card.
    it("keeps a human comment from reopening even when a sibling comment carries agent authorship", async () => {
      const commentIds = ["agent-receipt", "human-follow-up"];
      const queue = [wakeCandidate({
        agentId: ISSUE.assigneeAgentId!,
        requestedByActorType: "user",
        queuedCommentIds: commentIds,
        deferredCommentIds: commentIds,
      })];
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
        getQueuedCommentLiveness: vi.fn(async () => ({
          liveNonSelfCommentIds: commentIds,
          containedSelfAuthoredComment: false,
        })),
        getDeferredCommentCreatedAt: vi.fn(async () => commentIds.map((commentId) => ({
          commentId,
          createdAt: AFTER,
        }))),
        // NOT all authored by the finishing agent: the human comment is not.
        getCommentSelfAuthorship: vi.fn(async () => ({
          allSelfAuthored: false,
          allAuthoredByFinishingRunAgent: false,
        })),
        reopenIssue: vi.fn(async () => ({ ...ISSUE, status: "todo" })),
      });
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction, {
          ...ISSUE, status: "done", completedAt: CLOSED_AT, cancelledAt: null,
        }),
        recovery: createFakeRecovery(),
      });

      const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
      expect(result.outcome.kind).toBe("promoted");
    });

    // Same boundary for the explicit agent-resume clause, which PR #168
    // deliberately exempts at the close instant. A prior-run receipt from the
    // finishing agent carrying `resumeIntent` is still its own closing
    // receipt; it must not be revived by that exemption.
    it("keeps the agent resumeIntent clause inert for the finishing agent's own prior-run receipt", async () => {
      const { transaction } = await runCase({
        status: "done",
        commentTimes: [AFTER],
        actorType: "agent",
        resumeIntent: true,
        authoredByFinishingRunAgent: true,
      });

      expect(transaction.reopenIssue).not.toHaveBeenCalled();
    });

    // Fail-closed guard. A comment the adapter could not read must NOT count
    // as evidence that the wake predates the close: if the caller allowed a
    // short array through, `.every()` would pass vacuously and silently
    // suppress a reopen the guard never actually justified.
    it("keeps the reopen when a comment's creation instant could not be read", async () => {
      const commentIds = ["readable", "unreadable"];
      const queue = [wakeCandidate({
        agentId: ISSUE.assigneeAgentId!,
        requestedByActorType: "user",
        queuedCommentIds: commentIds,
        deferredCommentIds: commentIds,
      })];
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
        getQueuedCommentLiveness: vi.fn(async () => ({
          liveNonSelfCommentIds: commentIds,
          containedSelfAuthoredComment: false,
        })),
        // A short array: only the first comment came back.
        getDeferredCommentCreatedAt: vi.fn(async () => [{ commentId: "readable", createdAt: BEFORE }]),
        reopenIssue: vi.fn(async () => ({ ...ISSUE, status: "todo" })),
      });
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction, {
          ...ISSUE, status: "done", completedAt: CLOSED_AT, cancelledAt: null,
        }),
        recovery: createFakeRecovery(),
      });

      await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
    });

    it("keeps the reopen when a returned creation instant is null", async () => {
      const commentIds = ["unreadable"];
      const queue = [wakeCandidate({
        agentId: ISSUE.assigneeAgentId!,
        requestedByActorType: "user",
        queuedCommentIds: commentIds,
        deferredCommentIds: commentIds,
      })];
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
        getQueuedCommentLiveness: vi.fn(async () => ({
          liveNonSelfCommentIds: commentIds,
          containedSelfAuthoredComment: false,
        })),
        getDeferredCommentCreatedAt: vi.fn(async () => [{ commentId: "unreadable", createdAt: null }]),
        reopenIssue: vi.fn(async () => ({ ...ISSUE, status: "todo" })),
      });
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction, {
          ...ISSUE, status: "done", completedAt: CLOSED_AT, cancelledAt: null,
        }),
        recovery: createFakeRecovery(),
      });

      await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["done_live", "cancelled_live", "done_missing", "done_self", "done_no_resume", "done_untracked_comment"])("handles explicit agent feedback after completion: %s", async (scenario) => {
    const commentIds = ["accepted-agent-feedback"];
    const queue = [wakeCandidate({
      agentId: ISSUE.assigneeAgentId!,
      requestedByActorType: "agent",
      requestedByActorId: "delegating-agent",
      queuedCommentIds: scenario === "done_untracked_comment" ? [] : commentIds,
      deferredCommentIds: commentIds,
      payload: { resumeIntent: scenario !== "done_no_resume", followUpRequested: true },
      deferredContextSeed: { resumeIntent: scenario !== "done_no_resume", followUpRequested: true, wakeCommentIds: commentIds },
    })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      getQueuedCommentLiveness: vi.fn(async () => ({
        liveNonSelfCommentIds: scenario === "done_missing" || scenario === "done_self" ? [] : commentIds,
        containedSelfAuthoredComment: scenario === "done_self",
      })),
      getCommentSelfAuthorship: vi.fn(async () => ({
        allSelfAuthored: scenario === "done_self",
        allAuthoredByFinishingRunAgent: false,
      })),
      reopenIssue: vi.fn(async () => ({ ...ISSUE, status: "todo" })),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status: scenario === "cancelled_live" ? "cancelled" : "done" }),
      recovery: createFakeRecovery(),
    });

    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

    if (scenario === "done_live") {
      expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
      expect(transaction.finalizePromotedWake).toHaveBeenCalledTimes(1);
      expect(result.outcome.kind).toBe("promoted");
    } else {
      expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(1);
      expect(transaction.reopenIssue).not.toHaveBeenCalled();
      expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
      expect(result.outcome.kind).toBe("released");
    }
  });

  it("never reopens the issue when the promotion claim loses the race, and moves on to the next wake", async () => {
    const doneIssue: IssueSnapshot = { ...ISSUE, status: "done" };
    const queue = [
      // Carries a comment that would reopen the done issue, but the
      // promotion claim below loses the race before that reopen can run.
      wakeCandidate({
        id: "wake-lost-race",
        deferredCommentIds: ["c1"],
        requestedByActorType: "user",
      }),
      wakeCandidate({ id: "wake-promotes" }),
    ];
    const findNextDeferredWake = vi.fn(async () => queue.shift() ?? null);
    const claimDeferredWakeForPromotion = vi.fn(async ({ wakeId }: { wakeId: string }) => wakeId !== "wake-lost-race");
    const reopenIssue = vi.fn(async () => null);
    const transaction = createFakeTransaction({ findNextDeferredWake, claimDeferredWakeForPromotion, reopenIssue });
    const host = createFakeHost();
    const issueLock: IssueLockWriter = {
      withIssueExecutionLock: vi.fn(async (_input, fn) => {
        const result = await fn({ primaryIssue: doneIssue, run: RUN }, { host, transaction });
        return { ...result, run: RUN };
      }),
    };
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(reopenIssue).not.toHaveBeenCalled();
    expect(claimDeferredWakeForPromotion).toHaveBeenCalledTimes(2);
    expect(result.outcome.kind).toBe("promoted");
    expect(result.postCommitEffects).toEqual([{ kind: "run_queued", run: runSummary("wake-promotes") }]);
  });

  it("throws WakeQueueApplicationError with code responsible_user_unresolved when the responsible user cannot resolve", async () => {
    const transaction = createFakeTransaction({ findNextDeferredWake: vi.fn(async () => wakeCandidate()) });
    const host = createFakeHost({ resolveResponsibleUserId: vi.fn(async () => null) });
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await expect(
      releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() }),
    ).rejects.toMatchObject({
      constructor: WakeQueueApplicationError,
      code: "responsible_user_unresolved",
    });
  });

  it("resolves the responsible user for an immediate recovery run before queuing it", async () => {
    const resolveResponsibleUserId = vi.fn(
      async (_input: Parameters<WakeQueueHost["resolveResponsibleUserId"]>[0]) => "resolved-user",
    );
    const queueImmediateRecoveryRun = vi.fn(
      async (input: Parameters<WakeQueueTransaction["queueImmediateRecoveryRun"]>[0]) => runSummary("immediate-recovery"),
    );
    const transaction = createFakeTransaction({ queueImmediateRecoveryRun });
    const host = createFakeHost({ resolveResponsibleUserId });
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("queued_recovery");
    expect(resolveResponsibleUserId).toHaveBeenCalledTimes(1);
    const resolveCall = resolveResponsibleUserId.mock.calls[0]![0];
    expect(resolveCall.requestedByActorType).toBe("system");
    expect(resolveCall.requestedByActorId).toBeNull();
    expect(resolveCall.source).toBe("automation");
    expect(resolveCall.triggerDetail).toBe("system");
    expect(resolveCall.existingRunResponsibleUserId).toBe(RUN.responsibleUserId);
    // ISSUE.status is "in_progress", so the stalled-continuation labels apply.
    expect(resolveCall.contextSnapshot).toEqual({
      issueId: ISSUE.id,
      taskId: ISSUE.id,
      wakeReason: "issue_continuation_needed",
      retryReason: "issue_continuation_needed",
      source: "issue.continuation_recovery",
      retryOfRunId: RUN.id,
    });

    expect(queueImmediateRecoveryRun).toHaveBeenCalledTimes(1);
    const queueCall = queueImmediateRecoveryRun.mock.calls[0]![0];
    expect(queueCall.reason).toBe("issue_continuation_needed");
    expect(queueCall.responsibleUserId).toBe("resolved-user");
    expect(queueCall.contextSnapshot).toBe(resolveCall.contextSnapshot);
  });

  it("throws WakeQueueApplicationError with code responsible_user_unresolved for a recovery run, without queuing it", async () => {
    const transaction = createFakeTransaction();
    const host = createFakeHost({ resolveResponsibleUserId: vi.fn(async () => null) });
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await expect(
      releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() }),
    ).rejects.toMatchObject({
      constructor: WakeQueueApplicationError,
      code: "responsible_user_unresolved",
    });
    expect(transaction.queueImmediateRecoveryRun).not.toHaveBeenCalled();
  });

  it("escalates through the recovery port for a blocked outcome, after the transaction resolves", async () => {
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => null),
      hasExistingExecutionPath: vi.fn(async () => false),
      isAutomaticRecoverySuppressedByPauseHold: vi.fn(async () => false),
      // The recovery agent (the finishing run's own agent) is not invokable, which forces "blocked".
      findInvokableAgent: vi.fn(async () => null),
    });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const recovery = createFakeRecovery();
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("blocked");
    expect(result.outcome.kind === "blocked" && result.outcome.noticeKind).toBe("immediate_execution_path");
    expect(recovery.escalateStrandedAssignedIssue).toHaveBeenCalledTimes(1);
  });
});

const ACTIVE_EXECUTION_RUN: WakeAdmissionActiveExecutionRun = {
  id: "active-run-1",
  agentId: "execution-agent",
  status: "running",
  contextSnapshot: { taskKey: "issue-1" },
};

// The scope is opaque to the use case; the fakes below never inspect it.
const SCOPE = {} as TransactionScope;

function admissionInput(
  overrides: Partial<AdmitWakeBehindIssueExecutionInput> = {},
): AdmitWakeBehindIssueExecutionInput {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    agentId: "wake-agent",
    agentNameKey: "codexcoder",
    issueExecutionAgentNameKey: null,
    activeExecutionRun: ACTIVE_EXECUTION_RUN,
    liveRunExecutions: { has: () => true },
    wakeCommentId: null,
    forceFreshSession: false,
    contextSnapshot: { wakeReason: "issue_commented" },
    source: "on_demand",
    triggerDetail: null,
    payload: { issueId: "issue-1" },
    requestedByActorType: "user",
    requestedByActorId: "user-1",
    idempotencyKey: null,
    ...overrides,
  };
}

function createFakeAdmissionReader(overrides: Partial<WakeAdmissionReader> = {}): WakeAdmissionReader {
  return {
    isSameExecutionAgent: vi.fn(async () => true),
    matchesActiveWakeActor: vi.fn(async () => true),
    findExistingDeferredWake: vi.fn(async () => null),
    ...overrides,
  };
}

function createFakeAdmissionWriter(overrides: Partial<WakeAdmissionWriter> = {}): WakeAdmissionWriter {
  return {
    coalesceIntoActiveExecutionRun: vi.fn(async () => ({ id: "merged-run-1" })),
    mergeIntoExistingDeferredWake: vi.fn(async () => {}),
    insertNewDeferredWake: vi.fn(async () => {}),
    ...overrides,
  };
}

// Test doubles for the four heartbeat.ts decision helpers the module
// receives as a port. The defaults mirror the real helpers' behaviour for
// the plain wake in `admissionInput()`: no comment id, no forced fresh
// session, and a live coalesce target when `liveRunExecutions.has` says so.
function createFakeAdmissionHelpers(
  overrides: Partial<WakeAdmissionHeartbeatHelpers> = {},
): WakeAdmissionHeartbeatHelpers {
  return {
    filterZombieCoalesceTarget: vi.fn((target, liveRunExecutions) =>
      target && liveRunExecutions.has(target.id) ? target : null,
    ),
    mergeCoalescedContextSnapshot: vi.fn((existingRaw, incoming) => ({
      ...(existingRaw && typeof existingRaw === "object" ? (existingRaw as Record<string, unknown>) : {}),
      ...incoming,
    })),
    shouldDeferFollowupWakeForSameIssue: vi.fn(() => false),
    shouldQueueFollowupForRunningIssueWake: vi.fn(() => false),
    ...overrides,
  };
}

describe("admitWakeBehindIssueExecution", () => {
  it.each(["running", "queued"])(
    "keeps a dedicated durable continuation separate from a %s execution and an existing deferred wake",
    async (status) => {
      const durableReceipt = {
        id: "dedicated-receipt",
        requestedAt: new Date("2026-09-10T00:00:00Z"),
      };
      const writer = createFakeAdmissionWriter();
      const reader = createFakeAdmissionReader({
        findExistingDeferredWake: vi.fn(async () => ({
          id: "unrelated-deferred-wake",
          payload: {},
          deferredContext: {},
          coalescedCount: 0,
        })),
      });
      const helpers = createFakeAdmissionHelpers();
      const admit = createAdmitWakeBehindIssueExecution({
        reader,
        writer,
        helpers,
      });
      const contextSnapshot = {
        issueId: "issue-1",
        externalChatContinuation: true,
        interactionId: "exact-interaction",
        sourceRunId: "exact-source-run",
      };

      const result = await admit(
        SCOPE,
        admissionInput({
          activeExecutionRun: { ...ACTIVE_EXECUTION_RUN, status },
          allowRunCoalescing: false,
          durableReceipt,
          contextSnapshot,
        }),
      );

      expect(result).toEqual({ kind: "deferred" });
      expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
      expect(reader.findExistingDeferredWake).not.toHaveBeenCalled();
      expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
      expect(writer.insertNewDeferredWake).toHaveBeenCalledExactlyOnceWith(
        SCOPE,
        expect.objectContaining({
          durableReceipt,
          payload: {
            issueId: "issue-1",
            _paperclipWakeContext: contextSnapshot,
          },
        }),
      );
    },
  );

  it("partitions durable admission by the exact actor before considering a deferred merge", async () => {
    const durableReceipt = {
      id: "other-actor-receipt",
      requestedAt: new Date("2026-09-10T00:00:00Z"),
    };
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({
      matchesActiveWakeActor: vi.fn(async () => false),
    });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({
      reader,
      writer,
      helpers,
    });

    const result = await admit(
      SCOPE,
      admissionInput({
        activeExecutionRun: {
          ...ACTIVE_EXECUTION_RUN,
          wakeupRequestId: "active-wake",
        },
        durableReceipt,
        requestedByActorType: "user",
        requestedByActorId: "other-user",
      }),
    );

    expect(result).toEqual({ kind: "deferred" });
    expect(reader.matchesActiveWakeActor).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      {
        companyId: "company-1",
        wakeupRequestId: "active-wake",
        requestedByActorType: "user",
        requestedByActorId: "other-user",
      },
    );
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(reader.findExistingDeferredWake).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      {
        companyId: "company-1",
        agentId: "wake-agent",
        issueId: "issue-1",
        durableActor: { type: "user", id: "other-user" },
      },
    );
    expect(writer.insertNewDeferredWake).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      expect.objectContaining({ durableReceipt }),
    );
  });

  it("retains the durable receipt when the exact actor coalesces into the active execution", async () => {
    const durableReceipt = {
      id: "coalesced-receipt",
      requestedAt: new Date("2026-09-10T00:00:00Z"),
    };
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({
      reader,
      writer,
      helpers,
    });

    const result = await admit(
      SCOPE,
      admissionInput({
        activeExecutionRun: {
          ...ACTIVE_EXECUTION_RUN,
          wakeupRequestId: "active-wake",
        },
        durableReceipt,
      }),
    );

    expect(result).toEqual({ kind: "coalesced", run: { id: "merged-run-1" } });
    expect(reader.matchesActiveWakeActor).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      {
        companyId: "company-1",
        wakeupRequestId: "active-wake",
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      },
    );
    expect(
      writer.coalesceIntoActiveExecutionRun,
    ).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      expect.objectContaining({ durableReceipt }),
    );
    expect(reader.findExistingDeferredWake).not.toHaveBeenCalled();
  });

  it("retains an independent receipt when durable input merges into an existing deferred wake", async () => {
    const durableReceipt = {
      id: "merged-deferred-receipt",
      requestedAt: new Date("2026-09-10T00:00:00Z"),
    };
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({
      isSameExecutionAgent: vi.fn(async () => false),
      findExistingDeferredWake: vi.fn(async () => ({
        id: "existing-deferred-wake",
        runId: "existing-deferred-run",
        payload: { issueId: "issue-1", preserved: true },
        deferredContext: { preservedContext: true },
        coalescedCount: 2,
      })),
    });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({
      reader,
      writer,
      helpers,
    });

    const result = await admit(
      SCOPE,
      admissionInput({
        durableReceipt,
        reason: "question_response",
        idempotencyKey: "exact-receipt-key",
      }),
    );

    expect(result).toEqual({ kind: "deferred" });
    expect(
      writer.mergeIntoExistingDeferredWake,
    ).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      expect.objectContaining({
        existingDeferredWakeId: "existing-deferred-wake",
        nextCoalescedCount: 3,
        mergedPayload: {
          issueId: "issue-1",
          preserved: true,
          _paperclipWakeContext: {
            preservedContext: true,
            wakeReason: "issue_commented",
          },
        },
        coalescedReceipt: {
          ...durableReceipt,
          agentId: "wake-agent",
          source: "on_demand",
          triggerDetail: null,
          reason: "question_response",
          payload: {
            issueId: "issue-1",
            coalescedIntoWakeupRequestId: "existing-deferred-wake",
          },
          requestedByActorType: "user",
          requestedByActorId: "user-1",
          idempotencyKey: "exact-receipt-key",
          runId: "existing-deferred-run",
        },
      }),
    );
    expect(writer.insertNewDeferredWake).not.toHaveBeenCalled();
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
  });

  it("gives manual input its own run boundary even when the active receipt has the same requester", async () => {
    const writer = createFakeAdmissionWriter();
    const admit = createAdmitWakeBehindIssueExecution({
      reader: createFakeAdmissionReader(), writer, helpers: createFakeAdmissionHelpers(),
    });
    expect(await admit(SCOPE, admissionInput({ payload: { issueId: "issue-1", manualUserWake: true } })))
      .toEqual({ kind: "deferred" });
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary non-durable coalescing independent of durable actor lookup", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({
      matchesActiveWakeActor: vi.fn(async () => false),
    });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({
      reader,
      writer,
      helpers,
    });

    expect(await admit(SCOPE, admissionInput())).toEqual({
      kind: "coalesced",
      run: { id: "merged-run-1" },
    });
    expect(reader.matchesActiveWakeActor).not.toHaveBeenCalled();
    expect(writer.coalesceIntoActiveExecutionRun).toHaveBeenCalledTimes(1);
  });

  it("returns the coalesce outcome and calls the writer one time when the same agent's run absorbs the wake", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput());

    expect(result).toEqual({ kind: "coalesced", run: { id: "merged-run-1" } });
    expect(writer.coalesceIntoActiveExecutionRun).toHaveBeenCalledTimes(1);
    expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).not.toHaveBeenCalled();
  });

  it("never reads for an existing deferred wake on the coalesce path", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput());

    expect(result.kind).toBe("coalesced");
    expect(reader.findExistingDeferredWake).not.toHaveBeenCalled();
  });

  it("merges into the existing deferred wake when the policy returns a merge target", async () => {
    const mergeIntoExistingDeferredWake = vi.fn(
      async (_scope: TransactionScope, _input: Parameters<WakeAdmissionWriter["mergeIntoExistingDeferredWake"]>[1]) => {},
    );
    const writer = createFakeAdmissionWriter({ mergeIntoExistingDeferredWake });
    const reader = createFakeAdmissionReader({
      isSameExecutionAgent: vi.fn(async () => false),
      findExistingDeferredWake: vi.fn(async () => ({
        id: "deferred-1",
        payload: { issueId: "issue-1", foo: "bar" },
        deferredContext: { wakeReason: "issue_commented" },
        coalescedCount: 2,
      })),
    });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput());

    expect(result).toEqual({ kind: "deferred" });
    expect(mergeIntoExistingDeferredWake).toHaveBeenCalledTimes(1);
    const call = mergeIntoExistingDeferredWake.mock.calls[0]![1];
    expect(call.existingDeferredWakeId).toBe("deferred-1");
    expect(call.nextCoalescedCount).toBe(3);
    expect(call.mergedPayload.foo).toBe("bar");
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).not.toHaveBeenCalled();
  });

  it("inserts a new deferred wake when a different agent holds the lock and none is queued yet", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({ isSameExecutionAgent: vi.fn(async () => false) });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput());

    expect(result).toEqual({ kind: "deferred" });
    expect(writer.insertNewDeferredWake).toHaveBeenCalledTimes(1);
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
  });

  it("proceeds, and never reads for an existing deferred wake, when the zombie-run filter leaves no live coalesce target", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput({ liveRunExecutions: { has: () => false } }));

    expect(result).toEqual({ kind: "proceed" });
    expect(reader.findExistingDeferredWake).not.toHaveBeenCalled();
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).not.toHaveBeenCalled();
  });
});
