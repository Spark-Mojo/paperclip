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

type TransitionInput = Parameters<typeof applyIssueExecutionPolicyTransition>[0];
type InputWithCompanyDefault = TransitionInput & {
  companyDefaultResponsibleUserId?: string | null;
};

// Complements review-escalation-sentinel-fallback.test.ts (which drives the
// full three-round loop): these are single-transition cases for an issue whose
// historical responsible user is the board sentinel, with different
// company-default inputs.
function finalRoundResult(companyDefaultResponsibleUserId: string | null | undefined) {
  const policy = normalizeIssueExecutionPolicy({
    stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
  })!;
  const stageId = policy.stages[0].id;
  const input: InputWithCompanyDefault = {
    issue: {
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      assigneeUserId: null,
      responsibleUserId: sentinelUserId,
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
        changesRequestedCount: 2,
      },
    },
    policy,
    requestedStatus: "in_progress",
    requestedAssigneePatch: {},
    actor: { agentId: reviewerAgentId },
    commentBody: "Final agent review round",
    companyDefaultResponsibleUserId,
  };
  const result = applyIssueExecutionPolicyTransition(input);
  return { result, participant: (result.patch.executionState as IssueExecutionState).currentParticipant };
}

describe("final review round on an issue whose responsible user is the local-board sentinel", () => {
  it("assigns the validated company fallback and never leaks local-board into the escalation", () => {
    expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(3);
    const { result, participant } = finalRoundResult(fallbackUserId);

    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.patch.assigneeUserId).toBe(fallbackUserId);
    expect(participant).toMatchObject({ type: "user", userId: fallbackUserId });
    expect(result.patch.assigneeUserId).not.toBe(sentinelUserId);
    expect(participant?.userId).not.toBe(sentinelUserId);
  });

  it.each([
    ["the sentinel itself", sentinelUserId],
    ["a padded sentinel", ` ${sentinelUserId} `],
    ["null", null],
    ["undefined", undefined],
  ])("never assigns the sentinel when the company default is %s", (_label, companyDefault) => {
    const { result, participant } = finalRoundResult(companyDefault);

    expect(result.patch.assigneeUserId).not.toBe(sentinelUserId);
    expect(participant?.userId).not.toBe(sentinelUserId);
    // No human target is available, so the stage hands back to the implementer
    // (pre-existing behavior) instead of stalling on the sentinel.
    expect(result.patch.assigneeAgentId).toBe(implementerAgentId);
    expect(participant?.type).not.toBe("user");
  });
});
