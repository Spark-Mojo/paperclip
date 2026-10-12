import { describe, expect, it } from "vitest";
import {
  isCheckoutHoldRejection,
  shouldAutoCheckoutIssueForWake,
} from "../services/heartbeat.ts";
import { HttpError } from "../errors.ts";

// SPA-11807: auto-checkout passes `blocked` in expectedStatuses, so it can now
  // meet the new interaction hold (422). That must degrade to "did not claim
  // execution", exactly like a 409 conflict — not crash the whole run.
describe("isCheckoutHoldRejection", () => {
  it("treats a checkout hold as a non-claimable outcome", () => {
    expect(
      isCheckoutHoldRejection(
        new HttpError(422, "Issue is blocked on an unanswered interaction"),
      ),
    ).toBe(true);
    expect(
      isCheckoutHoldRejection(new HttpError(422, "Issue is blocked by unresolved blockers")),
    ).toBe(true);
  });

  it.each([409, 500])("does not swallow a %s failure", (status) => {
    expect(isCheckoutHoldRejection(new HttpError(status, "boom"))).toBe(false);
  });

  it("does not swallow a non-HttpError failure", () => {
    expect(isCheckoutHoldRejection(new Error("kaboom"))).toBe(false);
  });
});

describe("shouldAutoCheckoutIssueForWake", () => {
  it("auto-checks out an assigned todo issue for an actionable wake", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_assigned" },
      issueStatus: "todo",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(true);
  });

  it("leaves an idle review issue in review without an actionable wake", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: {},
      issueStatus: "in_review",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(false);
  });

  it("does not auto-checkout pending execution-review state even if the row status is todo", () => {
    const reviewerAgentId = "11111111-1111-4111-8111-111111111111";
    const coderAgentId = "22222222-2222-4222-8222-222222222222";
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_recovery_action_restored" },
      issueStatus: "todo",
      issueAssigneeAgentId: reviewerAgentId,
      issueExecutionState: {
        status: "pending",
        currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      isDependencyReady: true,
      agentId: reviewerAgentId,
    })).toBe(false);
  });
});
