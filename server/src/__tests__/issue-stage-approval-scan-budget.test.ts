/**
 * SPA-9396 fail-closed scan budget for the premerge stage-approval bound set.
 *
 * Two defects, both on an authority surface, both covered here:
 *
 *  1. The bound set is derived from work products (`limit 100`) and comments
 *     (`limit 200`). A card beyond either budget yields a TRUNCATED set, and
 *     two different truncated sets can compare EQUAL — so the set-equality
 *     guard passes on a set neither side ever saw. That is a fail-OPEN on an
 *     approval gate. The approval path therefore reads `limit + 1` and
 *     refuses with its own code the moment the extra row proves truncation; it
 *     never compares two truncated sets.
 *
 *  2. Head SHAs are compared by string equality, so an abbreviated (prefix)
 *     SHA is accepted as "the reviewed head". A prefix is a supply-chain
 *     hole: many commits share 7 hex characters. The approval path refuses a
 *     non-40-hex SHA and canonicalizes case.
 *
 * Real drizzle query-builder chain (so `.orderBy()` and `.limit()` are called
 * and the return is awaited), recording which handle served each select.
 */
import type { Db } from "@paperclipai/db";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueDoneGateService,
  type BoundPullRequestScanBudget,
} from "../services/issue-done-gate.ts";
import {
  WORK_PRODUCT_SCAN_LIMIT_APPROVAL,
  COMMENT_SCAN_LIMIT_APPROVAL,
  STAGE_APPROVAL_SCAN_BUDGET_CODE,
  STAGE_APPROVAL_AMBIGUOUS_SHA_CODE,
  STAGE_APPROVAL_INCOMPLETE_SET_CODE,
  issueExecutionPolicyFingerprint,
  issueStageApprovalService,
  scanBudgetRefusal,
  type ScanBudgetSeam,
} from "../services/issue-stage-approvals.ts";

const qaAgentId = "22222222-2222-4222-8222-222222222222";
const stageId = "44444444-4444-4444-8444-444444444444";
const headA = "9e0e5288875f46460e711ca233c3a88506ea2ecf";
const headB = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";

const POLICY: IssueExecutionPolicy = {
  mode: "normal",
  commentRequired: true,
  stages: [
    {
      id: stageId,
      type: "review",
      approvalsNeeded: 1,
      participants: [
        { id: "77777777-7777-4777-8777-777777777777", type: "agent", agentId: qaAgentId },
      ],
    },
  ],
};

const ISSUE = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId: "company-1",
  description: null,
};

function pr(number: number) {
  return { host: "github.com" as const, owner: "Spark-Mojo", repo: "spark-mojo-platform", number };
}

function openDetails(headSha: string) {
  return { state: "open" as const, headRef: null, headSha, workProductState: "open" as const };
}

function mergedDetails(headSha: string) {
  return { state: "merged" as const, headRef: null, headSha, workProductState: "merged" as const };
}

function approvedState(headSha = headA): IssueExecutionState {
  return {
    status: "completed",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: { type: "agent", agentId: qaAgentId },
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
        recordedBy: "stage_participant" as const,
        policyFingerprint: issueExecutionPolicyFingerprint(POLICY),
        approvedAt: "2026-09-30T12:00:00.000Z",
        pullRequests: [
          { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha },
        ],
        supersededAt: null,
        supersededReason: null,
      },
    ],
    awaitingMerge: { stageId },
  };
}

type Row = Record<string, unknown>;

function workProductRow(number: number): Row {
  return {
    url: `https://github.com/Spark-Mojo/spark-mojo-platform/pull/${number}`,
    externalId: null,
    title: null,
    summary: null,
    metadata: null,
  };
}

function commentRow(number: number): Row {
  return { body: `see https://github.com/Spark-Mojo/spark-mojo-platform/pull/${number}` };
}

function pullUrlRows(count: number) {
  return Array.from({ length: count }, (_unused, index) => workProductRow(index + 1));
}

function commentRows(count: number) {
  return Array.from({ length: count }, (_unused, index) => commentRow(index + 1));
}

/**
 * A select handle that serves `rowsPerCall[i]` from the i-th select, and
 * honours the `.limit(n)` the service passes (returning at most n rows, so a
 * test cannot fake a truncation signal by over-returning).
 */
function selectHandle(rowsPerCall: Array<Array<Row>>) {
  const orderBy = vi.fn();
  const limit = vi.fn();
  const handle = {
    name: "" as string,
    orderBy,
    limit,
    select: vi.fn((_columns?: unknown) => {
      const call = handle.calls++;
      const rows = rowsPerCall[Math.min(call, rowsPerCall.length - 1)] ?? [];
      const builder = {
        from: () => builder,
        where: () => builder,
        orderBy: (column: unknown) => {
          orderBy(column);
          return builder;
        },
        limit: (n: number) => {
          limit(n);
          return Promise.resolve(rows.slice(0, n));
        },
      };
      return builder;
    }),
    calls: 0,
  };
  return handle;
}

function tagged(handle: ReturnType<typeof selectHandle>, name: string) {
  return new Proxy(handle, {
    get(target, property) {
      if (property === "name") return name;
      // Returned RAW (never bound) so `expect(handle.select)` is still the spy.
      return Reflect.get(target, property, target);
    },
  });
}

/**
 * The PRODUCTION binding-surface shape, mounted on whatever handle it is given.
 * `budget` is the real approval budget and `onTruncated` is the real refusal, so
 * these tests exercise the production refusal, not a stand-in for it.
 */
const budget: BoundPullRequestScanBudget = {
  workProductLimit: WORK_PRODUCT_SCAN_LIMIT_APPROVAL,
  commentLimit: COMMENT_SCAN_LIMIT_APPROVAL,
  onTruncated: (surface, limit) => scanBudgetRefusal(surface, limit),
};
/**
 * Deliberately NOT a `vi.fn`: `vi.clearAllMocks()` clears a mock's
 * implementation as well as its call history, and a module-scope seam whose
 * implementation is wiped returns `undefined` from the SECOND test onward —
 * which presents as "the truncation refusal never fires" when the seam is
 * simply dead. The handle identity these tests actually assert on is observed
 * through `handle.select` spies (see `tagged`), not through this seam.
 */
const budgetSeam: ScanBudgetSeam = async (issue, handle) =>
  issueDoneGateService(handle, { seam: budget }).listBoundPullRequests(issue);

afterEach(() => {
  vi.clearAllMocks();
});

function budgetService(rowsPerCall: Array<Array<Row>>) {
  const db = tagged(selectHandle(rowsPerCall), "db");
  return { db, svc: issueStageApprovalService(db as unknown as Db, { scanBudgetSeam: budgetSeam }) };
}

describe("bound-set read runs on the handle it was given (tx-scoped, DEFECT 1)", () => {
  it("executes the work-product and comment selects on tx, never on the outer db", async () => {
    const db = tagged(selectHandle([[], []]), "db");
    const tx = tagged(selectHandle([[], []]), "tx");
    const svc = issueStageApprovalService(db as unknown as Db, {
      tx: tx as unknown as Db,
      scanBudgetSeam: budgetSeam,
    });

    await svc.readBound(ISSUE);

    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("falls back to the outer db when no transaction handle is supplied", async () => {
    const db = tagged(selectHandle([[], []]), "db");
    const svc = issueStageApprovalService(db as unknown as Db, { scanBudgetSeam: budgetSeam });

    await svc.readBound(ISSUE);

    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

describe("truncated binding surface fails CLOSED (DEFECT 2)", () => {
  it("refuses an approval read that exceeds the work-product budget, without comparing truncated sets", async () => {
    const { db, svc } = budgetService([pullUrlRows(WORK_PRODUCT_SCAN_LIMIT_APPROVAL + 1), []]);

    await expect(svc.verifyReviewedPullRequests({ issue: ISSUE, claim: [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA }] })).rejects.toMatchObject({
      status: 409,
      details: {
        code: STAGE_APPROVAL_SCAN_BUDGET_CODE,
        surface: "work_products",
        budget: WORK_PRODUCT_SCAN_LIMIT_APPROVAL,
      },
    });
    // The extra row was requested (limit + 1), not the bare cap: that is the
    // only way the truncation is provable at all.
    expect(db.limit).toHaveBeenCalledWith(WORK_PRODUCT_SCAN_LIMIT_APPROVAL + 1);
    // The comment scan never ran — the guard refuses on the first provable
    // truncation instead of assembling a partial set to compare.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("refuses an approval read that exceeds the comment budget", async () => {
    const { db, svc } = budgetService([[], commentRows(COMMENT_SCAN_LIMIT_APPROVAL + 1)]);

    await expect(svc.verifyReviewedPullRequests({ issue: ISSUE, claim: [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA }] })).rejects.toMatchObject({
      status: 409,
      details: {
        code: STAGE_APPROVAL_SCAN_BUDGET_CODE,
        surface: "comments",
        budget: COMMENT_SCAN_LIMIT_APPROVAL,
      },
    });
    expect(db.limit).toHaveBeenCalledWith(COMMENT_SCAN_LIMIT_APPROVAL + 1);
  });

  it("carries a remediation message distinct from verification_failed", async () => {
    const { svc } = budgetService([pullUrlRows(WORK_PRODUCT_SCAN_LIMIT_APPROVAL + 1), []]);

    await expect(svc.verifyReviewedPullRequests({ issue: ISSUE, claim: [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA }] })).rejects.toMatchObject({
      status: 409,
      details: { code: "issue_stage_approval_scan_budget_exceeded" },
      message: expect.stringMatching(/could not prove/i),
    });
  });

  it("reads limit + 1 rows on BOTH surfaces, not the bare cap", async () => {
    const { db, svc } = budgetService([[], []]);

    await svc.readBound(ISSUE);

    expect(db.limit).toHaveBeenNthCalledWith(1, WORK_PRODUCT_SCAN_LIMIT_APPROVAL + 1);
    expect(db.limit).toHaveBeenNthCalledWith(2, COMMENT_SCAN_LIMIT_APPROVAL + 1);
  });

  it("T3 boundary: exactly `limit` work products is NOT truncated and reads normally", async () => {
    const { db, svc } = budgetService([pullUrlRows(WORK_PRODUCT_SCAN_LIMIT_APPROVAL), []]);

    const bound = await svc.readBound(ISSUE);

    expect(bound).toHaveLength(WORK_PRODUCT_SCAN_LIMIT_APPROVAL);
    expect(db.limit).toHaveBeenCalledWith(WORK_PRODUCT_SCAN_LIMIT_APPROVAL + 1);
  });

  it("T3 boundary: exactly `limit` comments is NOT truncated and reads normally", async () => {
    const { db, svc } = budgetService([[], commentRows(COMMENT_SCAN_LIMIT_APPROVAL)]);

    const bound = await svc.readBound(ISSUE);

    expect(bound).toHaveLength(COMMENT_SCAN_LIMIT_APPROVAL);
    expect(db.limit).toHaveBeenCalledWith(COMMENT_SCAN_LIMIT_APPROVAL + 1);
  });

  it("T2 negative control: at `limit` rows the set-equality guard still refuses an unreviewed PR", async () => {
    const { svc } = budgetService([pullUrlRows(WORK_PRODUCT_SCAN_LIMIT_APPROVAL), []]);
    const gate = issueStageApprovalService({} as Db, {
      listBoundPullRequests: svc.readBound,
      resolvePullRequestDetails: async () => openDetails(headA),
    });

    // The approved set names #1202 only; the live bound set is 100 PRs. The
    // refusal must be the SET verdict, not the budget refusal — that is what
    // proves the budget refusal above is caused by the cap and nothing else.
    await expect(
      gate.evaluateStageApprovalGate({
        issue: { ...ISSUE, executionPolicy: POLICY, executionState: approvedState() },
      }),
    ).resolves.toMatchObject({
      outcome: "refuse",
      details: { code: STAGE_APPROVAL_INCOMPLETE_SET_CODE },
    });
  });

  it("T2 negative control: an exactly-matching approval still ALLOWS terminal done", async () => {
    const gate = issueStageApprovalService({} as Db, {
      listBoundPullRequests: async () => [pr(1202)],
      resolvePullRequestDetails: async () => mergedDetails(headA),
    });

    await expect(
      gate.evaluateStageApprovalGate({
        issue: { ...ISSUE, executionPolicy: POLICY, executionState: approvedState() },
      }),
    ).resolves.toEqual({ outcome: "allow" });
  });

  it("T2 negative control: the SAME 100 rows with one extra row flips allow -> budget refusal", async () => {
    // The only difference between this and the allow case above is the 101st
    // row, so the budget refusal cannot be attributed to anything else.
    const atBudget = issueStageApprovalService({} as Db, {
      listBoundPullRequests: async () => [pr(1202)],
      resolvePullRequestDetails: async () => mergedDetails(headA),
    });
    const overBudget = issueStageApprovalService({} as Db, {
      listBoundPullRequests: async () => [pr(1202), pr(1203)],
      resolvePullRequestDetails: async () => mergedDetails(headA),
    });

    await expect(
      atBudget.evaluateStageApprovalGate({
        issue: { ...ISSUE, executionPolicy: POLICY, executionState: approvedState() },
      }),
    ).resolves.toEqual({ outcome: "allow" });
    await expect(
      overBudget.evaluateStageApprovalGate({
        issue: { ...ISSUE, executionPolicy: POLICY, executionState: approvedState() },
      }),
    ).resolves.toMatchObject({ outcome: "refuse" });
  });

  it("does not compare the two truncated sets: the policy verdict is never reached", async () => {
    const { svc } = budgetService([pullUrlRows(WORK_PRODUCT_SCAN_LIMIT_APPROVAL + 1), []]);
    const gate = issueStageApprovalService({} as Db, {
      listBoundPullRequests: svc.readBound,
      resolvePullRequestDetails: async () => openDetails(headA),
    });

    // The approval named #1202, which the truncated set does contain, so a
    // set comparison would be the next step. The budget refusal has to preempt
    // it: an approval over a set nobody fully read is never evidence.
    await expect(
      gate.evaluateStageApprovalGate({
        issue: { ...ISSUE, executionPolicy: POLICY, executionState: approvedState() },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: STAGE_APPROVAL_SCAN_BUDGET_CODE,
        surface: "work_products",
        budget: WORK_PRODUCT_SCAN_LIMIT_APPROVAL,
      },
    });
  });
});

describe("head SHAs are canonicalized to lowercase 40-hex, prefixes refused", () => {
  function claimService(headSha: string) {
    return issueStageApprovalService({} as Db, {
      listBoundPullRequests: async () => [pr(1202)],
      resolvePullRequestDetails: async () => openDetails(headA),
    });
  }

  function claim(headSha: string) {
    return [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha }];
  }

  it("accepts an uppercase 40-hex SHA and canonicalizes it to lowercase", async () => {
    const verified = await claimService(headA).verifyReviewedPullRequests({
      issue: ISSUE,
      claim: claim(headA.toUpperCase()),
    });

    expect(verified.pullRequests).toEqual([
      { owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA },
    ]);
  });

  it("refuses an abbreviated (prefix) SHA as ambiguous rather than matching it", async () => {
    await expect(
      claimService(headA).verifyReviewedPullRequests({ issue: ISSUE, claim: claim(headA.slice(0, 7)) }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: STAGE_APPROVAL_AMBIGUOUS_SHA_CODE },
    });
  });

  it("refuses a non-hex SHA outright", async () => {
    await expect(
      claimService(headA).verifyReviewedPullRequests({ issue: ISSUE, claim: claim("z".repeat(40)) }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: STAGE_APPROVAL_AMBIGUOUS_SHA_CODE },
    });
  });

  it("refuses when the RESOLVER hands back a non-40-hex head, not only the claim", async () => {
    const svc = issueStageApprovalService({} as Db, {
      listBoundPullRequests: async () => [pr(1202)],
      resolvePullRequestDetails: async () => openDetails(headA.slice(0, 7)),
    });

    await expect(
      svc.verifyReviewedPullRequests({ issue: ISSUE, claim: [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA }] }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: STAGE_APPROVAL_AMBIGUOUS_SHA_CODE },
    });
  });

  it("refuses a stale-head verdict when the live resolver head is a prefix", async () => {
    const svc = issueStageApprovalService({} as Db, {
      listBoundPullRequests: async () => [pr(1202)],
      resolvePullRequestDetails: async () => openDetails(headB.slice(0, 8)),
    });

    await expect(
      svc.verifyReviewedPullRequests({ issue: ISSUE, claim: [{ owner: "Spark-Mojo", repo: "spark-mojo-platform", number: 1202, headSha: headA }] }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: STAGE_APPROVAL_AMBIGUOUS_SHA_CODE },
    });
  });

  it("refuses a terminal-done check whose recorded approval carries a prefix SHA", async () => {
    const gate = issueStageApprovalService({} as Db, {
      // The bound set MATCHES the recorded approval, so the set-equality guard
      // passes and the head check is reached: the prefix must be refused there.
      listBoundPullRequests: async () => [pr(1202)],
      resolvePullRequestDetails: async () => mergedDetails(headA),
    });

    // The state parser rejects a non-40-hex head before comparison. This is
    // the primary fail-closed boundary for malformed persisted approvals.
    await expect(
      gate.evaluateStageApprovalGate({
        issue: { ...ISSUE, executionPolicy: POLICY, executionState: approvedState(headA.slice(0, 7)) },
      }),
    ).resolves.toMatchObject({
      outcome: "refuse",
      details: { code: "issue_stage_approval_missing_required_stage" },
    });
  });

  it("refuses a terminal-done check when the LIVE head is a prefix", async () => {
    const gate = issueStageApprovalService({} as Db, {
      listBoundPullRequests: async () => [pr(1202)],
      resolvePullRequestDetails: async () => mergedDetails(headB.slice(0, 8)),
    });

    await expect(
      gate.evaluateStageApprovalGate({
        issue: { ...ISSUE, executionPolicy: POLICY, executionState: approvedState() },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: STAGE_APPROVAL_AMBIGUOUS_SHA_CODE },
    });
  });
});
