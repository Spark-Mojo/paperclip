import type { Db } from "@paperclipai/db";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";
import {
  issueExecutionPolicyFingerprint,
  issueStageApprovalService,
  liveStageApproval,
  STAGE_APPROVAL_AMBIGUOUS_CODE,
  STAGE_APPROVAL_INCOMPLETE_SET_CODE,
  STAGE_APPROVAL_MISSING_CODE,
  STAGE_APPROVAL_POLICY_CHANGED_CODE,
  STAGE_APPROVAL_REVIEWER_CHANGED_CODE,
  STAGE_APPROVAL_STALE_HEAD_CODE,
} from "../services/issue-stage-approvals.ts";
import type {
  GitHubPullRequestReference,
  PullRequestMergeDetails,
} from "../services/github-pull-request-merge.ts";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoAgentId = "33333333-3333-4333-8333-333333333333";
const ctoUserId = "cto-user";
const participantA = "77777777-7777-4777-8777-777777777777";
const participantB = "88888888-8888-4888-8888-888888888888";
const stageId = "44444444-4444-4444-8444-444444444444";
const secondStageId = "55555555-5555-4555-8555-555555555555";

const headA = "9e0e5288875f46460e711ca233c3a88506ea2ecf";
const headB = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";

function policyOf(stages: IssueExecutionPolicy["stages"]): IssueExecutionPolicy {
  return { mode: "normal", commentRequired: true, stages };
}

function reviewPolicy(): IssueExecutionPolicy {
  return policyOf([
    {
      id: stageId,
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: participantA, type: "agent", agentId: qaAgentId }],
    },
  ]);
}

function pendingOn(policy: IssueExecutionPolicy): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: policy.stages[0]!.id,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: qaAgentId },
    returnAssignee: { type: "agent", agentId: coderAgentId },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: "changes_requested",
    changesRequestedCount: 1,
  };
}

function pr(number: number): GitHubPullRequestReference {
  return { host: "github.com", owner: "Spark-Mojo", repo: "spark-mojo-platform", number };
}

function openDetails(headSha: string): PullRequestMergeDetails {
  return { state: "open", headRef: null, headSha, workProductState: "open" };
}

function service(input: {
  bound: GitHubPullRequestReference[];
  details: (reference: GitHubPullRequestReference) => PullRequestMergeDetails;
}) {
  return issueStageApprovalService({} as Db, {
    listBoundPullRequests: async () => input.bound,
    resolvePullRequestDetails: async (_companyId, reference) =>
      input.details(reference),
  });
}

function issueWith(
  policy: IssueExecutionPolicy | null,
  state: IssueExecutionState | null,
): { id: string; companyId: string; description: string | null; executionPolicy: unknown; executionState: unknown } {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    companyId: "company-1",
    description: null,
    executionPolicy: policy,
    executionState: state,
  };
}

/** Approve the final stage against `headSha`, returning the persisted state. */
function approvePremerge(
  policy: IssueExecutionPolicy,
  headSha: string,
  actorAgentId = qaAgentId,
): IssueExecutionState {
  const result = applyIssueExecutionPolicyTransition({
    issue: {
      status: "in_review",
      assigneeAgentId: qaAgentId,
      executionPolicy: policy,
      executionState: pendingOn(policy),
    },
    policy,
    requestedStatus: "done",
    requestedAssigneePatch: {},
    actor: { agentId: actorAgentId },
    commentBody: "Approved the reviewed head.",
    approvalPullRequests: [
      { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha },
    ],
    approvalRecordedAt: new Date("2026-09-30T12:00:00.000Z"),
  });
  expect(result.decision?.outcome).toBe("approved");
  return result.patch.executionState as IssueExecutionState;
}

describe("stage approval — recorded, durable, head-bound and policy-bound", () => {
  it("records a premerge approval without terminal completion", () => {
    const policy = reviewPolicy();
    const state = approvePremerge(policy, headA);
    expect(state.status).toBe("completed");
    expect(state.awaitingMerge).toEqual({ stageId });
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals![0]).toMatchObject({
      stageId,
      reviewerAgentId: qaAgentId,
      reviewerUserId: null,
      recordedBy: "stage_participant",
      policyFingerprint: issueExecutionPolicyFingerprint(policy),
      approvedAt: "2026-09-30T12:00:00.000Z",
      pullRequests: [
        { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA },
      ],
      supersededAt: null,
    });
  });

  it("refuses a premerge approval claimed for a stale head", async () => {
    const policy = reviewPolicy();
    const svc = service({ bound: [pr(1202)], details: () => openDetails(headB) });
    await expect(
      svc.verifyReviewedPullRequests({
        issue: issueWith(policy, null),
        claim: [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA }],
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: STAGE_APPROVAL_STALE_HEAD_CODE } });
  });

  it("refuses an ambiguous pull-request read (fail closed)", async () => {
    const policy = reviewPolicy();
    const svc = service({
      bound: [pr(1202)],
      details: () => ({ state: "unknown", headRef: null, headSha: null }),
    });
    await expect(
      svc.verifyReviewedPullRequests({
        issue: issueWith(policy, null),
        claim: [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA }],
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: STAGE_APPROVAL_AMBIGUOUS_CODE } });
  });

  it("refuses a claim that omits a bound pull request (same-size and subset alike)", async () => {
    const policy = reviewPolicy();
    const svc = service({
      bound: [pr(1202), pr(1203)],
      details: () => openDetails(headA),
    });
    await expect(
      svc.verifyReviewedPullRequests({
        issue: issueWith(policy, null),
        claim: [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA }],
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: STAGE_APPROVAL_INCOMPLETE_SET_CODE,
        missing: ["spark-mojo/spark-mojo-platform#1203"],
      },
    });
  });

  it("refuses a claim naming a pull request that is not bound to the card", async () => {
    const policy = reviewPolicy();
    const svc = service({ bound: [pr(1202)], details: () => openDetails(headA) });
    await expect(
      svc.verifyReviewedPullRequests({
        issue: issueWith(policy, null),
        claim: [
          { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA },
          { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 9999, headSha: headA },
        ],
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: STAGE_APPROVAL_INCOMPLETE_SET_CODE,
        unexpected: ["spark-mojo/spark-mojo-platform#9999"],
      },
    });
  });

  it("allows a terminal done once the recorded approval is unchanged and the head is merged", async () => {
    const policy = reviewPolicy();
    const state = approvePremerge(policy, headA);
    const svc = service({
      bound: [pr(1202)],
      details: () => ({ state: "merged", headRef: null, headSha: headA, workProductState: "merged" }),
    });
    await expect(
      svc.evaluateStageApprovalGate({ issue: issueWith(policy, state) }),
    ).resolves.toEqual({ outcome: "allow" });
  });

  it("refuses terminal done after the approved head moved (fail closed on stale head)", async () => {
    const policy = reviewPolicy();
    const state = approvePremerge(policy, headA);
    const svc = service({ bound: [pr(1202)], details: () => openDetails(headB) });
    await expect(
      svc.evaluateStageApprovalGate({ issue: issueWith(policy, state) }),
    ).resolves.toMatchObject({
      outcome: "refuse",
      details: { code: STAGE_APPROVAL_STALE_HEAD_CODE },
    });
  });

  it("refuses terminal done after a new pull request became bound (set equality, not subset)", async () => {
    const policy = reviewPolicy();
    const state = approvePremerge(policy, headA);
    const svc = service({
      bound: [pr(1202), pr(1203)],
      details: () => ({ state: "merged", headRef: null, headSha: headA, workProductState: "merged" }),
    });
    await expect(
      svc.evaluateStageApprovalGate({ issue: issueWith(policy, state) }),
    ).resolves.toMatchObject({
      outcome: "refuse",
      details: { code: STAGE_APPROVAL_INCOMPLETE_SET_CODE },
    });
  });

  it("refuses terminal done after the execution policy changed (fingerprint bound)", async () => {
    const policy = reviewPolicy();
    const state = approvePremerge(policy, headA);
    // `approvalsNeeded` is a schema literal of 1, so the drift that matters
    // here is the participant set: an approval taken under a policy naming a
    // different reviewer is not evidence under the current one.
    const changedPolicy = normalizeIssueExecutionPolicy({
      ...policy,
      stages: [
        {
          ...policy.stages[0]!,
          participants: [{ id: participantB, type: "agent", agentId: ctoAgentId }],
        },
      ],
    });
    const svc = service({
      bound: [pr(1202)],
      details: () => ({ state: "merged", headRef: null, headSha: headA, workProductState: "merged" }),
    });
    await expect(
      svc.evaluateStageApprovalGate({ issue: issueWith(changedPolicy, state) }),
    ).resolves.toMatchObject({
      outcome: "refuse",
      details: {
        code: STAGE_APPROVAL_POLICY_CHANGED_CODE,
        authorizedPolicyFingerprint: issueExecutionPolicyFingerprint(policy),
        currentPolicyFingerprint: issueExecutionPolicyFingerprint(changedPolicy),
      },
    });
  });

  it("refuses terminal done when the required stage set itself changed after approval", async () => {
    const policy = policyOf([
      { id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: participantA, type: "agent", agentId: qaAgentId }] },
      { id: secondStageId, type: "approval", approvalsNeeded: 1, participants: [{ id: participantB, type: "user", userId: ctoUserId }] },
    ]);
    const state = approvePremerge(policy, headA);
    // The policy was edited after the approval was authorized — the approval
    // is bound to the two-stage revision, so it is not evidence under the
    // one-stage policy in force now. This must fail closed on the binding,
    // not be read as "stage two is merely unapproved".
    const onlyFirstStage = reviewPolicy();
    const svc = service({
      bound: [pr(1202)],
      details: () => ({ state: "merged", headRef: null, headSha: headA, workProductState: "merged" }),
    });
    await expect(
      svc.evaluateStageApprovalGate({ issue: issueWith(onlyFirstStage, state) }),
    ).resolves.toMatchObject({
      outcome: "refuse",
      details: {
        code: STAGE_APPROVAL_POLICY_CHANGED_CODE,
        authorizedPolicyFingerprint: issueExecutionPolicyFingerprint(policy),
        currentPolicyFingerprint: issueExecutionPolicyFingerprint(onlyFirstStage),
      },
    });
  });

  it("refuses terminal done when a required stage carries no approval at all", async () => {
    const policy = policyOf([
      { id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: participantA, type: "agent", agentId: qaAgentId }] },
      { id: secondStageId, type: "approval", approvalsNeeded: 1, participants: [{ id: participantB, type: "user", userId: ctoUserId }] },
    ]);
    const state = approvePremerge(policy, headA);
    // Hold the policy revision fixed so the fingerprint still matches, and
    // drop every approval for the second stage: the gate must then report the
    // genuinely unapproved stage under the missing-stage code.
    const withoutSecondStage: IssueExecutionState = {
      ...state,
      approvals: state.approvals!.filter((approval) => approval.stageId !== secondStageId),
    };
    const svc = service({
      bound: [pr(1202)],
      details: () => ({ state: "merged", headRef: null, headSha: headA, workProductState: "merged" }),
    });
    await expect(
      svc.evaluateStageApprovalGate({ issue: issueWith(policy, withoutSecondStage) }),
    ).resolves.toMatchObject({
      outcome: "refuse",
      details: { code: STAGE_APPROVAL_MISSING_CODE, stages: [secondStageId] },
    });
  });

  it("refuses terminal done when the approval reviewer is not a participant of the stage", async () => {
    const policy = reviewPolicy();
    const state = approvePremerge(policy, headA);
    const tampered: IssueExecutionState = {
      ...state,
      approvals: state.approvals!.map((approval) => ({
        ...approval,
        reviewerAgentId: ctoAgentId,
      })),
    };
    const svc = service({
      bound: [pr(1202)],
      details: () => ({ state: "merged", headRef: null, headSha: headA, workProductState: "merged" }),
    });
    await expect(
      svc.evaluateStageApprovalGate({ issue: issueWith(policy, tampered) }),
    ).resolves.toMatchObject({
      outcome: "refuse",
      details: { code: STAGE_APPROVAL_REVIEWER_CHANGED_CODE },
    });
  });

  it("never resurrects a superseded approval — the stage has no live approval", async () => {
    const policy = reviewPolicy();
    const first = approvePremerge(policy, headA);
    const svc = service({
      bound: [pr(1202)],
      details: () => ({ state: "merged", headRef: null, headSha: headA, workProductState: "merged" }),
    });
    const voided: IssueExecutionState = {
      ...first,
      approvals: first.approvals!.map((approval) => ({
        ...approval,
        supersededAt: "2026-09-30T13:00:00.000Z",
        supersededReason: "fresh_review",
      })),
    };
    await expect(
      svc.evaluateStageApprovalGate({ issue: issueWith(policy, voided) }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: STAGE_APPROVAL_MISSING_CODE, stages: [stageId] },
    });
  });
});

describe("stage approval — append-only history and the fresh-review path", () => {
  it("appends a fresh approval and supersedes the prior one without deleting history", () => {
    const policy = reviewPolicy();
    const first = approvePremerge(policy, headA);
    const refreshed = applyIssueExecutionPolicyTransition({
      issue: {
        status: first.awaitingMerge ? "todo" : "todo",
        assigneeAgentId: coderAgentId,
        executionPolicy: policy,
        executionState: first,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Re-reviewed the moved head.",
      approvalPullRequests: [
        { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headB },
      ],
      approvalRecordedAt: new Date("2026-09-30T14:00:00.000Z"),
    });
    const state = refreshed.patch.executionState as IssueExecutionState;
    expect(state.approvals).toHaveLength(2);
    expect(state.approvals![0]).toMatchObject({
      pullRequests: [{ headSha: headA }],
      supersededAt: "2026-09-30T14:00:00.000Z",
      supersededReason: "fresh_review",
    });
    expect(state.approvals![1]).toMatchObject({
      pullRequests: [{ headSha: headB }],
      supersededAt: null,
    });
    expect(liveStageApproval(state.approvals!, stageId)).toMatchObject({
      pullRequests: [{ headSha: headB }],
    });
  });

  it("re-reviewing a moved head keeps the stage completed — it never restarts implementation", () => {
    const policy = reviewPolicy();
    const first = approvePremerge(policy, headA);
    const refreshed = applyIssueExecutionPolicyTransition({
      issue: {
        status: "todo",
        assigneeAgentId: coderAgentId,
        executionPolicy: policy,
        executionState: first,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Re-reviewed the moved head.",
      approvalPullRequests: [
        { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headB },
      ],
      approvalRecordedAt: new Date("2026-09-30T14:00:00.000Z"),
    });
    const state = refreshed.patch.executionState as IssueExecutionState;
    expect(state.status).toBe("completed");
    expect(state.currentStageId).toBeNull();
    expect(refreshed.patch.status).not.toBe("in_progress");
  });

  it("rejects a fresh review from anyone but a participant of the approved stage", () => {
    const policy = reviewPolicy();
    const first = approvePremerge(policy, headA);
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: {
          status: "todo",
          assigneeAgentId: coderAgentId,
          executionPolicy: policy,
          executionState: first,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Re-reviewed it myself.",
        approvalPullRequests: [
          { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headB },
        ],
        approvalRecordedAt: new Date("2026-09-30T14:00:00.000Z"),
      }),
    ).toThrow(/Only the active reviewer/);
  });

  it("resolves the live approval deterministically when two entries share a timestamp", () => {
    const base = approvePremerge(reviewPolicy(), headA);
    const later = applyIssueExecutionPolicyTransition({
      issue: {
        status: "todo",
        assigneeAgentId: coderAgentId,
        executionPolicy: reviewPolicy(),
        executionState: base,
      },
      policy: reviewPolicy(),
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Second review at the same instant.",
      approvalPullRequests: [
        { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headB },
      ],
      approvalRecordedAt: new Date("2026-09-30T14:00:00.000Z"),
    });
    const state = later.patch.executionState as IssueExecutionState;
    // The later array position wins the tie, deterministically and without
    // reading a clock.
    expect(liveStageApproval(state.approvals!, stageId)).toMatchObject({
      pullRequests: [{ headSha: headB }],
    });
  });
});