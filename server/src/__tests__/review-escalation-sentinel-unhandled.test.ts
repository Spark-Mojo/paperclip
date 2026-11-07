import { expect, it } from "vitest";
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

it("negative fixture: leaves the local-board sentinel as the escalation target", () => {
  expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(3);
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
    companyDefaultResponsibleUserId: fallbackUserId,
  };

  const result = applyIssueExecutionPolicyTransition(input);
  const participant = (result.patch.executionState as IssueExecutionState).currentParticipant;

  // This fixture is intentionally impossible to satisfy: before the fix the
  // fallback assertion fails, while after the fix the old-behavior assertions
  // fail. It therefore remains a reliable non-zero negative gate on both sides.
  expect(result.patch.assigneeUserId).toBe(fallbackUserId);
  expect(result.patch.assigneeUserId).toBe(sentinelUserId);
  expect(participant).toMatchObject({ type: "user", userId: sentinelUserId });
});
