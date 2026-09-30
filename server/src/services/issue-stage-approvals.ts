import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type {
  IssueExecutionPolicy,
  IssueExecutionStageApproval,
  IssueStageApprovalPullRequest,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import {
  APPROVAL_COMMENT_SCAN_LIMIT,
  APPROVAL_WORK_PRODUCT_SCAN_LIMIT,
  issueDoneGateService,
  type BoundPullRequestScanBudget,
} from "./issue-done-gate.js";
import type {
  GitHubPullRequestReference,
  PullRequestMergeDetails,
} from "./github-pull-request-merge.js";
import {
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";

export const STAGE_APPROVAL_STALE_HEAD_CODE = "issue_stage_approval_stale_pull_request_head";
export const STAGE_APPROVAL_INCOMPLETE_SET_CODE = "issue_stage_approval_incomplete_pull_request_set";
export const STAGE_APPROVAL_AMBIGUOUS_CODE = "issue_stage_approval_pull_request_state_unknown";
export const STAGE_APPROVAL_POLICY_CHANGED_CODE = "issue_stage_approval_policy_changed";
export const STAGE_APPROVAL_REVIEWER_CHANGED_CODE = "issue_stage_approval_reviewer_not_participant";
export const STAGE_APPROVAL_MISSING_CODE = "issue_stage_approval_missing_required_stage";
/**
 * SPA-9396 — the binding surface exceeded the approval path's scan budget, so
 * the engine could not PROVE the bound set. Deliberately distinct from
 * `verification_failed`: nothing is wrong with the review, the card is simply
 * too large to verify, and re-reviewing it will not help.
 */
export const STAGE_APPROVAL_SCAN_BUDGET_CODE = "issue_stage_approval_scan_budget_exceeded";
/** A head SHA that is not a full lowercase-canonical 40-hex object id. */
export const STAGE_APPROVAL_AMBIGUOUS_SHA_CODE = "issue_stage_approval_ambiguous_pull_request_head_sha";

/** The approval path's own budget — the done-gate's limits stay its own. */
export const WORK_PRODUCT_SCAN_LIMIT_APPROVAL = APPROVAL_WORK_PRODUCT_SCAN_LIMIT;
export const COMMENT_SCAN_LIMIT_APPROVAL = APPROVAL_COMMENT_SCAN_LIMIT;

/** A full git object id: exactly 40 lowercase hex characters. */
const CANONICAL_SHA_PATTERN = /^[0-9a-f]{40}$/;

function referenceKey(reference: { owner: string; repo: string; number: number }): string {
  return `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
}

function formatList(values: readonly string[]): string {
  return values.join(", ");
}

/**
 * SPA-9396: lowercase-canonicalize a head SHA, or REFUSE it as ambiguous. A
 * short/prefixed SHA is a supply-chain hole, not a shorthand — SHA-1 prefixes
 * collide, so a 7-hex "reviewed head" can name thousands of commits and would
 * be accepted by a plain string comparison against a live read.
 */
function canonicalHeadSha(
  headSha: string | null | undefined,
  context: { reference: GitHubPullRequestReference; claimed?: string | null; stageId?: string },
): string {
  const canonical = typeof headSha === "string" ? headSha.trim().toLowerCase() : "";
  if (CANONICAL_SHA_PATTERN.test(canonical)) return canonical;
  throw conflict(
    `Issue cannot be marked done from this approval: the pull request head for ${referenceKey(context.reference)} is not a full 40-character commit sha, so the reviewed head cannot be identified unambiguously. Read the current head from GitHub and approve the full sha.`,
    {
      code: STAGE_APPROVAL_AMBIGUOUS_SHA_CODE,
      pullRequests: [
        {
          ...context.reference,
          ...(context.claimed != null ? { reviewedHeadSha: context.claimed } : {}),
          ...(context.stageId ? { stageId: context.stageId } : {}),
          headSha: headSha ?? null,
        },
      ],
    },
  );
}

function normalizeClaim(claim: readonly IssueStageApprovalPullRequest[]) {
  const entries = new Map<string, IssueStageApprovalPullRequest>();
  const duplicates: string[] = [];
  for (const entry of claim) {
    const key = referenceKey(entry);
    if (entries.has(key)) {
      duplicates.push(key);
      continue;
    }
    entries.set(key, {
      owner: entry.owner,
      repo: entry.repo,
      number: entry.number,
      headSha: entry.headSha.toLowerCase(),
    });
  }
  return { entries, duplicates };
}

export function issueExecutionPolicyFingerprint(
  policy: IssueExecutionPolicy | null,
): string | null {
  if (!policy) return null;
  const canonical = {
    mode: policy.mode,
    stages: policy.stages.map((stage) => ({
      id: stage.id,
      type: stage.type,
      approvalsNeeded: stage.approvalsNeeded,
      participants: stage.participants.map((participant) => ({
        type: participant.type,
        agentId: participant.agentId ?? null,
        userId: participant.userId ?? null,
      })),
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type StageApprovalPullRequestReader = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeDetails>;

/**
 * SPA-9396: the binding-surface reader, told WHICH handle to read on. The
 * approval path passes the transaction it is holding, so the "recheck under the
 * lock" runs in the same snapshot as the write it guards; the pre-transaction
 * verification read passes nothing and lands on the outer connection.
 */
export type ScanBudgetSeam = (
  issue: { id: string; companyId: string; description?: string | null },
  handle: Db,
) => Promise<GitHubPullRequestReference[]>;

export type IssueStageApprovalServiceOptions = {
  resolvePullRequestDetails?: StageApprovalPullRequestReader;
  listBoundPullRequests?: (
    issue: { id: string; companyId: string; description?: string | null },
  ) => Promise<GitHubPullRequestReference[]>;
  /**
   * SPA-9396 — transaction handle. When the service is constructed INSIDE a
   * `db.transaction`, pass the `tx` here: every bound-set read then executes on
   * that transaction, so it sees the snapshot the approval write commits
   * against instead of a concurrent, unrelated one. `tx ?? db` is the read
   * handle; the GitHub resolver always uses the outer `db` (it is a
   * credentials/ETag provider, not part of the guard's snapshot).
   */
  tx?: Db;
  /**
   * SPA-9396 — the fail-closed scan budget for the bound set. Defaults to the
   * real production binding surface, which reads `limit + 1` and throws
   * `STAGE_APPROVAL_SCAN_BUDGET_CODE` the moment the extra row proves the set
   * is truncated.
   */
  scanBudgetSeam?: ScanBudgetSeam;
};

export type VerifiedStageApproval = {
  pullRequests: IssueStageApprovalPullRequest[];
};

function ambiguousRead(reference: GitHubPullRequestReference) {
  return conflict(
    `Issue cannot be marked done from this approval: the pull request head ${referenceKey(reference)} could not be read from GitHub, so the reviewed head cannot be verified. Re-try once GitHub is reachable, then approve again.`,
    { code: STAGE_APPROVAL_AMBIGUOUS_CODE, pullRequests: [referenceKey(reference)] },
  );
}

function staleHead(input: {
  reference: GitHubPullRequestReference;
  claimed: string;
  current: string;
}) {
  return conflict(
    `Issue cannot be marked done from this approval: the pull request head moved since it was reviewed. ${referenceKey(input.reference)} is now ${input.current}, not the reviewed ${input.claimed}. Review the current head and approve again.`,
    {
      code: STAGE_APPROVAL_STALE_HEAD_CODE,
      pullRequests: [
        {
          ...input.reference,
          reviewedHeadSha: input.claimed,
          currentHeadSha: input.current,
        },
      ],
    },
  );
}

function incompleteSet(input: { missing: string[]; unexpected: string[]; duplicates?: string[] }) {
  const parts: string[] = [];
  if (input.missing.length > 0) parts.push(`not reviewed: ${formatList(input.missing)}`);
  if (input.unexpected.length > 0) {
    parts.push(`not bound to this card: ${formatList(input.unexpected)}`);
  }
  if (input.duplicates?.length) {
    parts.push(`named more than once: ${formatList(input.duplicates)}`);
  }
  return conflict(
    `Issue cannot be marked done from this approval: a stage approval must cover every pull request bound to this card (${parts.join("; ")}). Approve the complete, current set of bound pull request heads.`,
    {
      code: STAGE_APPROVAL_INCOMPLETE_SET_CODE,
      missing: input.missing,
      unexpected: input.unexpected,
      ...(input.duplicates?.length ? { duplicates: input.duplicates } : {}),
    },
  );
}

function policyChanged(expected: string | null, actual: string | null) {
  return conflict(
    "Issue cannot be marked done from this approval: this card's execution policy changed after the stage approval was authorized; re-read the policy and approve again.",
    {
      code: STAGE_APPROVAL_POLICY_CHANGED_CODE,
      authorizedPolicyFingerprint: expected,
      currentPolicyFingerprint: actual,
    },
  );
}

function reviewerChanged(details: unknown) {
  return conflict(
    "This card's stage participant or execution state changed after the stage approval was authorized; re-read the card and approve again.",
    details,
  );
}

function parsePolicy(value: unknown): IssueExecutionPolicy | null {
  if (value == null) return null;
  try {
    return normalizeIssueExecutionPolicy(value);
  } catch {
    return null;
  }
}

/**
 * SPA-9396: the bound set is capped (an authority surface is a DoS vector), but
 * a cap that SILENTLY truncates lets two different truncated sets compare equal
 * and the set-equality guard pass on a set nobody fully read. So the read asks
 * for one row past the cap, and this refusal fires the moment that sentinel
 * comes back.
 *
 * Distinct from `verification_failed` on purpose: nothing is wrong with the
 * review and re-approving will not help. The card's binding surface has to
 * shrink (or the engine has to be given a bigger budget) before an approval
 * over it can be proven.
 */
export function scanBudgetRefusal(
  surface: "work_products" | "comments",
  limit: number,
): never {
  const subject = surface === "work_products" ? "pull request work products" : "comments";
  throw conflict(
    `Issue cannot be marked done from this approval: this card binds more than the ${limit}-${surface === "work_products" ? "work product" : "comment"} scan budget allows (${subject}), so the engine could not prove the complete set of pull requests bound to this card. Stage approval is refused rather than decided on a partial set. Archive or split the card's history so the binding surface fits the budget, then approve again.`,
    { code: STAGE_APPROVAL_SCAN_BUDGET_CODE, surface, budget: limit },
  );
}

export function issueStageApprovalService(db: Db, opts: IssueStageApprovalServiceOptions = {}) {
  const resolveDetails: StageApprovalPullRequestReader =
    opts.resolvePullRequestDetails ??
    (async (companyId, reference) => {
      const { createPullRequestMergeDetailsResolver } = await import(
        "./github-pull-request-merge.js"
      );
      return createPullRequestMergeDetailsResolver(db)(companyId, reference);
    });

  // SPA-9396: the bound set is always read on the transaction handle when one
  // was supplied, so an in-transaction recheck is snapshot-coherent with the
  // write it guards. The done-gate is built on that same handle, never on the
  // outer connection.
  const readHandle = opts.tx ?? db;
  const budget: BoundPullRequestScanBudget = {
    workProductLimit: WORK_PRODUCT_SCAN_LIMIT_APPROVAL,
    commentLimit: COMMENT_SCAN_LIMIT_APPROVAL,
    onTruncated: scanBudgetRefusal,
  };
  const scanBound: ScanBudgetSeam =
    opts.scanBudgetSeam ??
    ((issue, handle) => issueDoneGateService(handle, { seam: budget }).listBoundPullRequests(issue));

  async function readBound(issue: {
    id: string;
    companyId: string;
    description?: string | null;
  }) {
    if (opts.listBoundPullRequests) return opts.listBoundPullRequests(issue);
    return scanBound(issue, readHandle);
  }

  async function resolveReviewable(companyId: string, references: GitHubPullRequestReference[]) {
    const reviewable = new Map<string, GitHubPullRequestReference>();
    const nonPullRequests: string[] = [];
    for (const reference of references) {
      const details = await resolveDetails(companyId, reference);
      if (details.notAPullRequest) {
        nonPullRequests.push(referenceKey(reference));
        continue;
      }
      reviewable.set(referenceKey(reference), reference);
    }
    return { reviewable, nonPullRequests };
  }

  async function verifyReviewedPullRequests(input: {
    issue: { id: string; companyId: string; description?: string | null };
    claim: readonly IssueStageApprovalPullRequest[] | null | undefined;
  }): Promise<VerifiedStageApproval> {
    if (!input.claim || input.claim.length === 0) {
      throw conflict(
        "Issue cannot be marked done from this approval: a pull-request-backed card requires reviewedPullRequests evidence naming each bound pull request head. Review the current bound pull request heads and approve again.",
        { code: STAGE_APPROVAL_INCOMPLETE_SET_CODE, missing: [], unexpected: [] },
      );
    }

    const { entries: claim, duplicates } = normalizeClaim(input.claim);
    const bound = await readBound(input.issue);
    const { reviewable, nonPullRequests } = await resolveReviewable(
      input.issue.companyId,
      bound,
    );

    if (duplicates.length > 0) {
      throw incompleteSet({ missing: [], unexpected: [], duplicates: [...new Set(duplicates)] });
    }

    const claimNamesNonPullRequest = [...claim.keys()].filter((key) =>
      nonPullRequests.includes(key),
    );
    if (claimNamesNonPullRequest.length > 0) {
      throw incompleteSet({ missing: [], unexpected: claimNamesNonPullRequest });
    }

    const missing = [...reviewable.keys()].filter((key) => !claim.has(key));
    const unexpected = [...claim.keys()].filter((key) => !reviewable.has(key));
    if (missing.length > 0 || unexpected.length > 0) {
      throw incompleteSet({ missing, unexpected });
    }

    const verified: IssueStageApprovalPullRequest[] = [];
    for (const [key, entry] of claim) {
      const reference = reviewable.get(key)!;
      const details = await resolveDetails(input.issue.companyId, reference);
      if (details.state === "unknown" || !details.headSha) {
        throw ambiguousRead(reference);
      }
      // SPA-9396: both sides must be full object ids before they are compared.
      // The claim is refused on a prefix, and the live read is refused on a
      // prefix, so a stale head can never hide behind an abbreviated sha.
      const currentHeadSha = canonicalHeadSha(details.headSha, { reference });
      const reviewedHeadSha = canonicalHeadSha(entry.headSha, {
        reference,
        claimed: entry.headSha,
      });
      if (currentHeadSha !== reviewedHeadSha) {
        throw staleHead({
          reference,
          claimed: reviewedHeadSha,
          current: currentHeadSha,
        });
      }
      verified.push({
        owner: reference.owner,
        repo: reference.repo,
        number: reference.number,
        headSha: currentHeadSha,
      });
    }

    return { pullRequests: verified };
  }

  async function hasBoundPullRequests(issue: {
    id: string;
    companyId: string;
    description?: string | null;
  }): Promise<boolean> {
    const bound = await readBound(issue);
    if (bound.length === 0) return false;
    const { reviewable } = await resolveReviewable(issue.companyId, bound);
    return reviewable.size > 0;
  }

  async function evaluateStageApprovalGate(input: {
    issue: {
      id: string;
      companyId: string;
      description?: string | null;
      executionPolicy?: unknown;
      executionState?: unknown;
    };
  }): Promise<{ outcome: "allow" } | { outcome: "refuse"; reason: string; details: unknown }> {
    const policy = parsePolicy(input.issue.executionPolicy);
    if (!policy || policy.stages.length === 0) return { outcome: "allow" };

    const state = parseIssueExecutionState(input.issue.executionState);
    const approvals = state?.approvals ?? [];
    const approvalsByStage = new Map<string, IssueExecutionStageApproval>();
    for (const stage of policy.stages) {
      const live = liveStageApproval(approvals, stage.id);
      if (live) approvalsByStage.set(stage.id, live);
    }

    const bound = await readBound(input.issue);
    const reviewable = new Set<string>();
    if (bound.length > 0) {
      const resolved = await resolveReviewable(input.issue.companyId, bound);
      for (const key of resolved.reviewable.keys()) reviewable.add(key);
    }

    const approvalsBindingPullRequests = approvals.some(
      (approval) => approval.pullRequests.length > 0,
    );
    if (reviewable.size === 0 && !approvalsBindingPullRequests) {
      return { outcome: "allow" };
    }

    const currentFingerprint = issueExecutionPolicyFingerprint(policy);
    const missing: string[] = [];
    const nonParticipants: string[] = [];

    // The policy fingerprint is checked FIRST and across every stage before any
    // per-stage verdict is produced. A policy edited after an approval was
    // authorized (participants, stage set, order) is a larger violation than
    // any single stage's evidence, and it also invalidates the participant set
    // the reviewer would be judged against — checking participation first would
    // report the policy change as a reviewer problem and mask the real drift.
    for (const stage of policy.stages) {
      const approval = liveStageApproval(approvals, stage.id);
      if (!approval) continue;
      if (approval.policyFingerprint !== currentFingerprint) {
        return {
          outcome: "refuse",
          reason: "this card's execution policy changed after the stage approval was authorized; re-read the policy and approve again",
          details: {
            code: STAGE_APPROVAL_POLICY_CHANGED_CODE,
            authorizedPolicyFingerprint: approval.policyFingerprint,
            currentPolicyFingerprint: currentFingerprint,
          },
        };
      }
    }

    for (const stage of policy.stages) {
      const approval = approvalsByStage.get(stage.id);
      if (!approval || approval.stageType !== stage.type) {
        missing.push(stage.id);
        continue;
      }
      // A reviewer who is not a participant of THIS stage is not missing
      // evidence — it is a record that cannot have been produced by a
      // legitimate review, so it refuses under its own code rather than
      // asking for a re-approval that would land in the same state.
      if (!stageHasReviewer(stage, approval)) {
        nonParticipants.push(stage.id);
        continue;
      }
    }
    if (nonParticipants.length > 0) {
      return {
        outcome: "refuse",
        reason: "every stage approval on this card must be recorded by a participant of that stage",
        details: { code: STAGE_APPROVAL_REVIEWER_CHANGED_CODE, stages: nonParticipants },
      };
    }
    // A stage whose every recorded approval has been superseded has NO live
    // approval. That is distinct from a stage never approved: the record
    // existed and was deliberately voided, so treating it as an advisory
    // "missing" refusal would let a caller ignore the refusal and close on a
    // voided decision. Fail closed with a thrown conflict instead.
    const voidedOnlyStages = policy.stages
      .filter((stage) => {
        if (approvalsByStage.has(stage.id)) return false;
        return approvals.some(
          (approval) => approval.stageId === stage.id && approval.supersededAt,
        );
      })
      .map((stage) => stage.id);
    if (voidedOnlyStages.length > 0) {
      throw conflict(
        "Issue cannot be marked done from this approval: a required stage's approval was superseded and no live approval remains for it. Record a fresh approval for that stage before closing.",
        { code: STAGE_APPROVAL_MISSING_CODE, stages: voidedOnlyStages },
      );
    }
    if (missing.length > 0) {
      return {
        outcome: "refuse",
        reason: "every stage this policy requires must carry an approval by a participant of that stage before the card can close",
        details: { code: STAGE_APPROVAL_MISSING_CODE, stages: missing },
      };
    }

    const boundKeys = new Set(reviewable);
    const mismatched: Array<Record<string, unknown>> = [];
    const staleHeads: Array<Record<string, unknown>> = [];
    for (const stage of policy.stages) {
      const approval = approvalsByStage.get(stage.id)!;
      const approvedKeys = new Set(approval.pullRequests.map((pr) => referenceKey(pr)));
      for (const key of boundKeys) {
        if (!approvedKeys.has(key)) {
          mismatched.push({ stageId: stage.id, pullRequest: key, reason: "not_bound_at_approval" });
        }
      }
      for (const key of approvedKeys) {
        if (!boundKeys.has(key)) {
          mismatched.push({ stageId: stage.id, pullRequest: key, reason: "no_longer_bound" });
        }
      }
      if (mismatched.length > 0) break;
      for (const key of [...approvedKeys].sort()) {
        const reference = bound.find((candidate) => referenceKey(candidate) === key)!;
        const details = await resolveDetails(input.issue.companyId, reference);
        if (details.state === "unknown" || !details.headSha) {
          throw ambiguousRead(reference);
        }
        const approved = approval.pullRequests.find((pr) => referenceKey(pr) === key)!;
        // SPA-9396: a recorded or live head that is not a full 40-hex object id
        // is refused outright — an approval carrying a prefix cannot be shown to
        // have covered the head the card is closing on.
        const approvedHeadSha = canonicalHeadSha(approved.headSha, {
          reference,
          claimed: approved.headSha,
          stageId: stage.id,
        });
        const currentHeadSha = canonicalHeadSha(details.headSha, {
          reference,
          stageId: stage.id,
        });
        if (currentHeadSha !== approvedHeadSha) {
          staleHeads.push({
            stageId: stage.id,
            pullRequest: key,
            reason: "head_moved",
            approvedHeadSha,
            currentHeadSha,
          });
        }
      }
      if (staleHeads.length > 0) break;
    }

    if (mismatched.length > 0) {
      return {
        outcome: "refuse",
        reason: "the pull request set bound to this card changed since it was approved; every stage needs a fresh approval of the current set",
        details: { code: STAGE_APPROVAL_INCOMPLETE_SET_CODE, pullRequests: mismatched },
      };
    }
    if (staleHeads.length > 0) {
      return {
        outcome: "refuse",
        reason: "the pull request heads changed since they were approved; every stage needs a fresh approval of the current head",
        details: { code: STAGE_APPROVAL_STALE_HEAD_CODE, pullRequests: staleHeads },
      };
    }

    return { outcome: "allow" };
  }

  return { verifyReviewedPullRequests, hasBoundPullRequests, evaluateStageApprovalGate, readBound };
}

/**
 * SPA-9396 — the live approval for a stage: the last recorded entry for that
 * stage that has not been superseded. Later array position wins any tie on
 * timestamp, so the result is deterministic and never reads a clock.
 *
 * A superseded approval is never live again, so a voided record cannot be
 * resurrected as current review evidence.
 */
export function liveStageApproval(
  approvals: readonly IssueExecutionStageApproval[] | null | undefined,
  stageId: string,
): IssueExecutionStageApproval | null {
  let live: IssueExecutionStageApproval | null = null;
  for (const approval of approvals ?? []) {
    if (approval.stageId !== stageId || approval.supersededAt) continue;
    live = approval;
  }
  return live;
}

function stageHasReviewer(
  stage: { participants: Array<{ type: "agent" | "user"; agentId?: string | null; userId?: string | null }> },
  approval: { reviewerAgentId: string | null; reviewerUserId: string | null },
): boolean {
  return stage.participants.some((participant) =>
    participant.type === "agent"
      ? Boolean(participant.agentId) && participant.agentId === approval.reviewerAgentId
      : Boolean(participant.userId) && participant.userId === approval.reviewerUserId,
  );
}

export { policyChanged, reviewerChanged };
