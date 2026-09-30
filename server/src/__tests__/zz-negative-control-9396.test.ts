import type { Db } from "@paperclipai/db";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition } from "../services/issue-execution-policy.ts";
import { issueStageApprovalService } from "../services/issue-stage-approvals.ts";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoAgentId = "33333333-3333-4333-8333-333333333333";
const stageId = "44444444-4444-4444-8444-444444444444";
const headA = "9e0e5288875f46460e711ca233c3a88506ea2ecf";
const headB = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";

const policy: IssueExecutionPolicy = {
  mode: "normal",
  commentRequired: true,
  stages: [
    {
      id: stageId,
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: "p1", type: "agent", agentId: qaAgentId }],
    },
  ],
};

const pullRequests = [
  { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA },
];

function completedAwaitingMerge(): IssueExecutionState {
  return {
    status: "completed",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: { type: "agent", agentId: coderAgentId },
    reviewRequest: null,
    completedStageIds: [stageId],
    lastDecisionId: null,
    lastDecisionOutcome: "approved",
    changesRequestedCount: 0,
    approvals: [
      {
        stageId,
        stageType: "review",
        reviewerAgentId: qaAgentId,
        reviewerUserId: null,
        recordedBy: "stage_participant",
        policyFingerprint: null,
        approvedAt: "2026-09-30T12:00:00.000Z",
        pullRequests,
        supersededAt: null,
        supersededReason: null,
      },
    ],
    awaitingMerge: { stageId },
  };
}

function attempt(actorAgentId: string | null, headSha: string) {
  return applyIssueExecutionPolicyTransition({
    issue: {
      status: "todo",
      assigneeAgentId: coderAgentId,
      executionPolicy: policy,
      executionState: completedAwaitingMerge(),
    },
    policy,
    previousPolicy: policy,
    requestedStatus: "done",
    requestedAssigneePatch: {},
    actor: { agentId: actorAgentId, userId: null },
    commentBody: "Re-reviewed it myself.",
    approvalPullRequests: [
      { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha },
    ],
    approvalRecordedAt: new Date("2026-09-30T14:00:00.000Z"),
  });
}

describe("negative control — an unauthorized fresh-review claim must never become a close", () => {
  it("throws for a non-participant agent instead of returning a silent no-op patch", () => {
    let thrown: unknown = null;
    let returned: unknown = null;
    try {
      returned = attempt(coderAgentId, headB);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as { message: string }).message).toMatch(/Only the active reviewer/);
    expect(returned).toBeNull();
  });

  it("throws for a null actor rather than recording an unattributed approval", () => {
    expect(() => attempt(null, headB)).toThrow(/Only the active reviewer/);
  });

  it("throws for a different agent that is a participant of no stage here", () => {
    expect(() => attempt(ctoAgentId, headB)).toThrow(/Only the active reviewer/);
  });

  it("still permits the actual stage participant to refresh the moved head", () => {
    const result = attempt(qaAgentId, headB);
    const state = result.patch.executionState as IssueExecutionState;
    expect(result.decision?.outcome).toBe("approved");
    expect(state.approvals).toHaveLength(2);
    expect(state.approvals![0]!.supersededReason).toBe("fresh_review");
    expect(state.approvals![1]!.pullRequests[0]!.headSha).toBe(headB);
  });

  it("leaves the plain completed-state no-op untouched when no fresh claim is made", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "todo",
        assigneeAgentId: coderAgentId,
        executionPolicy: policy,
        executionState: completedAwaitingMerge(),
      },
      policy,
      previousPolicy: policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: "Close after merge",
    });
    expect(result.decision).toBeUndefined();
    expect(result.patch.executionState).toBeUndefined();
  });

  it("does not weaken the stage-approval gate service surface", () => {
    const svc = issueStageApprovalService({} as Db);
    expect(typeof svc.evaluateStageApprovalGate).toBe("function");
    expect(typeof svc.verifyReviewedPullRequests).toBe("function");
    expect(typeof svc.hasBoundPullRequests).toBe("function");
  });
});
