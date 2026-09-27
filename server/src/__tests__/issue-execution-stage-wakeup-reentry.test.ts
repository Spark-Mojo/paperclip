import { describe, expect, it } from "vitest";
import { buildExecutionStageWakeup } from "../routes/issues.ts";
import type { IssueExecutionState } from "@paperclipai/shared";

const reviewerAgentId = "22222222-2222-4222-8222-222222222222";
const executorAgentId = "11111111-1111-4111-8111-111111111111";
const stageId = "stage-1";

function pendingState(opts: {
  participantAgentId: string;
  lastDecisionId: string | null;
  lastDecisionOutcome?: IssueExecutionState["lastDecisionOutcome"];
}): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: opts.participantAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: executorAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: opts.lastDecisionId,
    lastDecisionOutcome: opts.lastDecisionOutcome ?? null,
    monitor: null,
  };
}

function changesRequestedState(opts: {
  returnAssigneeAgentId: string;
  lastDecisionId: string | null;
}): IssueExecutionState {
  return {
    status: "changes_requested",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: null,
    returnAssignee: { type: "agent", agentId: opts.returnAssigneeAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: opts.lastDecisionId,
    lastDecisionOutcome: "changes_requested",
    monitor: null,
  };
}

describe("buildExecutionStageWakeup (SPA-9001)", () => {
  it("returns null when nextState is null", () => {
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: null,
      nextState: null,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: reviewerAgentId,
    });
    expect(result).toBeNull();
  });

  it("returns null when nextState is pending but stageId, participant, AND lastDecisionId are all unchanged (no spurious wake)", () => {
    const state = pendingState({
      participantAgentId: reviewerAgentId,
      lastDecisionId: "decision-1",
    });
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: state,
      nextState: state,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: reviewerAgentId,
    });
    expect(result).toBeNull();
  });

  it("wakes the reviewer when re-entering the same review stage with the same reviewer but a fresh lastDecisionId (SPA-9001)", () => {
    const previous = pendingState({
      participantAgentId: reviewerAgentId,
      lastDecisionId: "decision-old",
    });
    const next = pendingState({
      participantAgentId: reviewerAgentId,
      lastDecisionId: "decision-new",
    });
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: previous,
      nextState: next,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: executorAgentId,
    });
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe(reviewerAgentId);
    expect(result!.wakeup.reason).toBe("execution_review_requested");
    expect(result!.wakeup.contextSnapshot).toMatchObject({
      issueId: "issue-1",
      wakeReason: "execution_review_requested",
      source: "issue.execution_stage",
    });
  });

  it("still wakes the reviewer when the stageId changes (unchanged path)", () => {
    const previous = pendingState({
      participantAgentId: reviewerAgentId,
      lastDecisionId: "decision-1",
    });
    const next: IssueExecutionState = {
      ...pendingState({
        participantAgentId: reviewerAgentId,
        lastDecisionId: "decision-1",
      }),
      currentStageId: "stage-2",
    };
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: previous,
      nextState: next,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: executorAgentId,
    });
    expect(result?.wakeup.reason).toBe("execution_review_requested");
  });

  it("still wakes the reviewer when the participant changes (unchanged path)", () => {
    const previous = pendingState({
      participantAgentId: reviewerAgentId,
      lastDecisionId: "decision-1",
    });
    const next = pendingState({
      participantAgentId: "44444444-4444-4444-8444-444444444444",
      lastDecisionId: "decision-1",
    });
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: previous,
      nextState: next,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: executorAgentId,
    });
    expect(result?.agentId).toBe("44444444-4444-4444-8444-444444444444");
    expect(result?.wakeup.reason).toBe("execution_review_requested");
  });

  it("still wakes the reviewer when leaving changes_requested (unchanged path, becameChangesRequested path)", () => {
    const previous = changesRequestedState({
      returnAssigneeAgentId: executorAgentId,
      lastDecisionId: "decision-changes",
    });
    const next = pendingState({
      participantAgentId: reviewerAgentId,
      lastDecisionId: "decision-resubmit",
    });
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: previous,
      nextState: next,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: executorAgentId,
    });
    expect(result?.wakeup.reason).toBe("execution_review_requested");
    expect(result?.agentId).toBe(reviewerAgentId);
  });

  it("wakes the executor when becoming changes_requested (unchanged path)", () => {
    const previous = pendingState({
      participantAgentId: reviewerAgentId,
      lastDecisionId: null,
    });
    const next = changesRequestedState({
      returnAssigneeAgentId: executorAgentId,
      lastDecisionId: "decision-changes",
    });
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: previous,
      nextState: next,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: reviewerAgentId,
    });
    expect(result?.wakeup.reason).toBe("execution_changes_requested");
    expect(result?.agentId).toBe(executorAgentId);
  });

  it("uses execution_approval_requested when the re-entered approval stage has an agent participant", () => {
    const approverAgentId = "55555555-5555-4555-8555-555555555555";
    const previous: IssueExecutionState = {
      ...pendingState({
        participantAgentId: approverAgentId,
        lastDecisionId: "decision-old",
      }),
      currentStageType: "approval",
    };
    const next: IssueExecutionState = {
      ...previous,
      lastDecisionId: "decision-new",
    };
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: previous,
      nextState: next,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: executorAgentId,
    });
    expect(result?.wakeup.reason).toBe("execution_approval_requested");
  });

  it("returns null when the participant type is user (approval stages don't wake through this function)", () => {
    const previous: IssueExecutionState = {
      ...pendingState({
        participantAgentId: reviewerAgentId,
        lastDecisionId: "decision-old",
      }),
      currentStageType: "approval",
      currentParticipant: { type: "user", userId: "approver-user", agentId: null },
    };
    const next: IssueExecutionState = {
      ...previous,
      lastDecisionId: "decision-new",
    };
    const result = buildExecutionStageWakeup({
      issueId: "issue-1",
      previousState: previous,
      nextState: next,
      interruptedRunId: null,
      requestedByActorType: "agent",
      requestedByActorId: executorAgentId,
    });
    expect(result).toBeNull();
  });
});