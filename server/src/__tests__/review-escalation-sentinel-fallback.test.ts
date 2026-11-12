import { describe, expect, it } from "vitest";
import type { IssueExecutionState } from "@paperclipai/shared";
import {
  applyIssueExecutionPolicyTransition,
  DEFAULT_MAX_REVIEW_ROUNDS,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

const implementerAgentId = "11111111-1111-4111-8111-111111111111";
const reviewerAgentId = "22222222-2222-4222-8222-222222222222";
const sentinelUserId = "local-board";
const fallbackUserId = "user-real-human-0001";
const assignedHumanUserId = "user-real-human-0002";

type TransitionInput = Parameters<typeof applyIssueExecutionPolicyTransition>[0];
type Issue = TransitionInput["issue"];
type InputWithCompanyDefault = TransitionInput & {
  companyDefaultResponsibleUserId?: string | null;
};

function runAgentReviewRounds(responsibleUserId: string) {
  const policy = normalizeIssueExecutionPolicy({
    stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
  })!;
  const stageId = policy.stages[0].id;
  let issue: Issue = {
    status: "in_review",
    assigneeAgentId: reviewerAgentId,
    assigneeUserId: null,
    responsibleUserId,
    executionPolicy: policy,
    executionState: {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: implementerAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
      changesRequestedCount: 0,
    },
  };

  let finalResult: ReturnType<typeof applyIssueExecutionPolicyTransition> | null = null;
  for (let round = 1; round <= 3; round += 1) {
    const reviewInput: InputWithCompanyDefault = {
      issue,
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
      commentBody: `Agent feedback round ${round}`,
      companyDefaultResponsibleUserId: fallbackUserId,
    };
    finalResult = applyIssueExecutionPolicyTransition(reviewInput);
    issue = { ...issue, ...finalResult.patch } as Issue;

    if (round < 3) {
      expect(finalResult.patch.assigneeAgentId).toBe(implementerAgentId);
      expect(finalResult.patch.assigneeUserId).toBeNull();
      const participant = (finalResult.patch.executionState as IssueExecutionState).currentParticipant;
      expect(participant).toMatchObject({ type: "agent", userId: null });
      expect(participant?.type).not.toBe("user");

      const resubmitInput: InputWithCompanyDefault = {
        issue,
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: implementerAgentId },
        commentBody: `Implemented feedback round ${round}`,
        companyDefaultResponsibleUserId: fallbackUserId,
      };
      const resubmission = applyIssueExecutionPolicyTransition(resubmitInput);
      issue = { ...issue, ...resubmission.patch } as Issue;
    }
  }

  return finalResult!;
}

function escalatedParticipant(result: ReturnType<typeof applyIssueExecutionPolicyTransition>) {
  return (result.patch.executionState as IssueExecutionState).currentParticipant;
}

describe("review escalation sentinel fallback", () => {
  it("uses the configured company default after three agent changes-requested rounds", () => {
    expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(3);
    const result = runAgentReviewRounds(sentinelUserId);

    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.patch.assigneeUserId).toBe(fallbackUserId);
    expect(escalatedParticipant(result)).toMatchObject({ type: "user", userId: fallbackUserId });
    expect(result.patch.assigneeUserId).not.toBe(sentinelUserId);
    expect(escalatedParticipant(result)?.userId).not.toBe(sentinelUserId);
  });

  it("preserves a legitimately assigned human as the escalation target", () => {
    expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(3);
    const result = runAgentReviewRounds(assignedHumanUserId);

    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.patch.assigneeUserId).toBe(assignedHumanUserId);
    expect(escalatedParticipant(result)).toMatchObject({ type: "user", userId: assignedHumanUserId });
    expect(result.patch.assigneeUserId).not.toBe(fallbackUserId);
  });
});
