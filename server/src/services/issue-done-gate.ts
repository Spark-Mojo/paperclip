import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueComments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { logActivity } from "./activity-log.js";
import {
  createPullRequestMergeDetailsResolver,
  extractGitHubPullRequestReferences,
  setBoundedPullRequestCacheEntry,
  type GitHubPullRequestReference,
  type PullRequestMergeDetails,
} from "./github-pull-request-merge.js";

/**
 * SPA-8957 — card-close DoD gate (immutable rule 12, SPA-8518):
 * a card that names a PR may not reach `done` until that PR's merge is
 * observable on GitHub. Policy-only until now: five cards closed before their
 * PRs merged in one night (SPA-8593/8626/8665/8715/8722) and the review-stage
 * approve path auto-closed SPA-8708/8669/8919 with PRs open and auto-merge
 * never armed. James ruled 2026-09-27: the engine refuses.
 *
 * SPA-9038 (James ruled option 1, 2026-09-27): besides `pull_request` work
 * products, the card's description and comments are also scanned for GitHub
 * PR URLs in Spark-Mojo repos, and each such link is checked exactly like an
 * attached work product. Live gap that prompted it (2026-09-27 22:57Z,
 * engine 15e0c7906): SPA-9036 closed done with PR #1140 open — the PR was
 * only linked in a comment, and agents usually link PRs in comments, so the
 * work-product-only key missed the common case.
 *
 * Detection (fail-closed, but scoped so a foreign mention never wedges us):
 *   - Binding signals are (a) `pull_request` work products on the card
 *     (any repo) and (b) GitHub PR URLs/`owner/repo#N` shorthands found in
 *     the card's description or comments, restricted to Spark-Mojo repos —
 *     our own repos, where "the card's PR is unmerged" is a real DoD fact.
 *     PR mentions of foreign repos are not ours to gate on.
 *   - Deleted comments do not bind; the live card text is the record.
 *   - `state === "merged"` passes. `state === "open"` refuses.
 *     `state === "unknown"` (GitHub unreachable, credentials missing,
 *     resolver absent) refuses — fail-closed on ambiguity.
 *   - A PR that is closed WITHOUT being merged (a refused PR) does NOT block:
 *     a deliberate human close, not an engine decision (James's ruling,
 *     2026-09-27).
 *   - SPA-9323: a reference that is positively identified as NOT a pull
 *     request does NOT block. `owner/repo#N` binds the gate without knowing
 *     whether N is a PR or an ISSUE, and the `/pull/N` read of an ISSUE 404s
 *     into the same `unknown` bucket as a GitHub outage — permanently, because
 *     no merge sha will ever exist and `doneOverride` is board-only. The
 *     resolver discriminates the two on GitHub's `/issues/N` endpoint; only a
 *     positive discrimination relaxes the gate. A 404 on BOTH endpoints
 *     (private repo, cross-account token, typo) stays `unknown` and blocks.
 *   - A card with zero binding references passes untouched — docs,
 *     judgment, audit cards close exactly as before.
 *
 * The refused transition returns 409 with the offending PR list and the two
 * sanctioned escapes: wait for the merge sha on main, or an explicit
 * board override (see `doneOverride` on the PATCH route — agents may never
 * supply it).
 *
 * Verdicts are snapshot-bound: the merge state is read through the same
 * resolver seam (and cache convention) as execution-workspace delivery
 * assessment — a short TTL, never a live re-check on refusal. A reviewer who
 * re-approves within the TTL after the merge lands may see one stale refusal;
 * re-approving is cheap, intentional, and rate-limit friendly. Do not add a
 * "re-check on refuse" path.
 */

export const DONE_GATE_OPEN_PR_REFUSAL = "issue_done_with_unmerged_pull_request";

/**
 * The binding surface is read under a hard cap, because this file is an
 * authority surface and an unbounded scan is a DoS vector. A card past either
 * cap yields a TRUNCATED bound set, which is safe HERE (a missed PR only ever
 * adds a refusal) and UNSAFE for the stage-approval path, where two different
 * truncated sets compare equal. Those limits are the done-gate's alone and are
 * never read from a caller.
 */
const WORK_PRODUCT_SCAN_LIMIT = 100;
const COMMENT_SCAN_LIMIT = 200;

/**
 * SPA-9396 — truncation-detecting scan budget, for the premerge stage-approval
 * path. Read `limit + 1`: a full `limit + 1` PROVES the set is truncated (the
 * query returned more rows than the budget allows), and the caller refuses
 * rather than comparing two truncated sets. Exactly `limit` rows is NOT
  * truncation and is served normally.
 */
export type BoundPullRequestScanBudget = {
  workProductLimit: number;
  commentLimit: number;
  onTruncated: (surface: "work_products" | "comments", limit: number) => never;
};

export const APPROVAL_WORK_PRODUCT_SCAN_LIMIT = WORK_PRODUCT_SCAN_LIMIT;
export const APPROVAL_COMMENT_SCAN_LIMIT = COMMENT_SCAN_LIMIT;

/**
 * SPA-9038: PR links parsed out of card prose (description/comments) bind the
 * gate only when they point at Spark-Mojo repos — our own repos, where an
 * unmerged PR is a real DoD fact for the card. Foreign-repo mentions are
 * context, not obligations.
 */
const SPARK_MOJO_ORG = "spark-mojo";

/** SPA-9038: how many recent comments to scan for PR mentions. */
const COMMENT_SCAN_LIMIT_DONE_GATE = 200;

function isSparkMojoRepo(reference: GitHubPullRequestReference): boolean {
  return reference.owner.toLowerCase() === SPARK_MOJO_ORG;
}

export type DoneGatePullRequestReference = GitHubPullRequestReference;

export type DoneGatePullRequestState = {
  reference: GitHubPullRequestReference;
  state: "merged" | "open" | "closed" | "unknown";
};

export type DoneGateBlockedReason =
  | { kind: "open_pull_requests"; pullRequests: DoneGatePullRequestState[] }
  | { kind: "unknown_pull_request_state"; pullRequests: DoneGatePullRequestState[] };

export type DoneGateDecision =
  | { outcome: "allow" }
  | { outcome: "refuse"; reason: DoneGateBlockedReason };

export type DoneGateOverrideInput = {
  reason: string;
  actorType: "agent" | "user" | "board";
  actorId: string | null;
  agentId: string | null;
  runId: string | null;
};

export type IssueDoneGateServiceOptions = {
  /**
   * Test seam: replaces the GitHub merge-state resolver. Production default
   * resolves through the GitHub external-object provider (company-scoped
   * credentials, ETag cache upstream).
   */
  resolvePullRequestDetails?: (
    companyId: string,
    reference: GitHubPullRequestReference,
  ) => Promise<PullRequestMergeDetails>;
  /**
   * SPA-9396: an OPTIONAL truncation-detecting scan budget. Absent (the
   * done-gate, and every other consumer), the binding surface is read under
   * this service's own cap and truncation is neither detected nor reported —
   * unchanged, because truncation here can only ever cause a refusal. When
   * present, `listBoundPullRequests` reads `limit + 1` on both surfaces and
   * calls `onTruncated` (which never returns) the moment the extra row proves
   * the set is incomplete, so the approval path fails closed instead of
   * comparing two truncated sets.
   */
  seam?: BoundPullRequestScanBudget;
};

function formatReference(reference: GitHubPullRequestReference) {
  return `${reference.owner}/${reference.repo}#${reference.number}`;
}

/**
 * Map the merge-details snapshot onto the gate's four-state view.
 * `closed` (closed WITHOUT merge — a refused PR) is deliberately non-blocking:
 * a refused PR is a human signal, not an engine decision.
 *
 * SPA-9323: `notAPullRequest` is a classification, not a PR state. A card that
 * cites `owner/repo#779` where 779 is an ISSUE has no merge state to guard, so
 * it must not wedge the close. It maps to `closed` here — the same non-blocking
 * bucket — purely so the gate has nothing new to consume. The resolver keeps
 * `state: "unknown"` for those references so the three other consumers of
 * `PullRequestMergeDetails.state` are unaffected.
 */
function gateStateFromDetails(details: PullRequestMergeDetails): "merged" | "open" | "closed" | "unknown" {
  if (details.notAPullRequest) return "closed";
  if (details.state === "merged") return "merged";
  if (details.workProductState === "closed") return "closed";
  if (details.state === "open") return "open";
  return "unknown";
}

export function issueDoneGateService(db: Db, opts: IssueDoneGateServiceOptions = {}) {
  const defaultResolver = opts.resolvePullRequestDetails
    ? null
    : createPullRequestMergeDetailsResolver(db);
  const pullRequestStateCache = new Map<
    string,
    { state: "merged" | "open" | "closed" | "unknown"; checkedAtMs: number }
  >();
  const cacheTtlMs = 60_000;

  const scanBudget = opts.seam ?? null;

  async function resolvePullRequestState(
    companyId: string,
    reference: GitHubPullRequestReference,
  ): Promise<"merged" | "open" | "closed" | "unknown"> {
    if (opts.resolvePullRequestDetails) {
      return gateStateFromDetails(await opts.resolvePullRequestDetails(companyId, reference));
    }
    const key = `${companyId}:${formatReference(reference).toLowerCase()}`;
    const cached = pullRequestStateCache.get(key);
    if (cached && Date.now() - cached.checkedAtMs < cacheTtlMs) return cached.state;
    const details = await defaultResolver!(companyId, reference);
    const state = gateStateFromDetails(details);
    setBoundedPullRequestCacheEntry(pullRequestStateCache, key, { state, checkedAtMs: Date.now() });
    return state;
  }

  /**
   * Binding references, per James's SPA-9038 ruling (option 1):
   *   1. Every `pull_request` work product on the issue (any repo) —
   *      references extracted from url/externalId/title/summary/metadata,
   *      the same extraction surface `execution-workspaces.ts` uses for
   *      delivery assessment.
   *   2. GitHub PR URLs and `owner/repo#N` shorthands parsed from the card's
   *      description and its most recent comments, restricted to Spark-Mojo
   *      repos. Deleted comments never bind.
   */
  async function listBoundPullRequests(
    issue: { id: string; companyId: string; description?: string | null },
  ) {
    const references = new Map<string, GitHubPullRequestReference>();
    const addReferences = (values: readonly unknown[]) => {
      for (const reference of extractGitHubPullRequestReferences(values)) {
        const key = formatReference(reference).toLowerCase();
        if (!references.has(key)) references.set(key, reference);
      }
    };
    const addExtracted = (extracted: readonly GitHubPullRequestReference[]) => {
      for (const reference of extracted) {
        const key = formatReference(reference).toLowerCase();
        if (!references.has(key)) references.set(key, reference);
      }
    };

    const workProductLimit = scanBudget?.workProductLimit ?? WORK_PRODUCT_SCAN_LIMIT;
    const commentLimit = scanBudget?.commentLimit ?? COMMENT_SCAN_LIMIT;
    // Truncation detection needs the sentinel row: ask for `limit + 1` and
    // refuse when all of them come back. Asking for the bare cap would make a
    // truncated set indistinguishable from a complete one.
    const workProductRows = await db
      .select({
        url: issueWorkProducts.url,
        externalId: issueWorkProducts.externalId,
        title: issueWorkProducts.title,
        summary: issueWorkProducts.summary,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        eq(issueWorkProducts.type, "pull_request"),
      ))
      .orderBy(desc(issueWorkProducts.updatedAt))
      .limit(workProductLimit + 1);
    if (scanBudget && workProductRows.length > workProductLimit) {
      scanBudget.onTruncated("work_products", workProductLimit);
    }
    const products = workProductRows.slice(0, workProductLimit);

    for (const product of products) {
      addReferences([
        product.url,
        product.externalId,
        product.title,
        product.summary,
        product.metadata ? JSON.stringify(product.metadata) : null,
      ]);
    }

    // SPA-9038: prose bindings — description first, then recent live comments.
    if (typeof issue.description === "string" && issue.description.length > 0) {
      addExtracted(extractGitHubPullRequestReferences([issue.description])
        .filter(isSparkMojoRepo));
    }
    const commentRows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, issue.companyId),
        eq(issueComments.issueId, issue.id),
        isNull(issueComments.deletedAt),
      ))
      .orderBy(desc(issueComments.createdAt))
      .limit(commentLimit + 1);
    if (scanBudget && commentRows.length > commentLimit) {
      scanBudget.onTruncated("comments", commentLimit);
    }
    for (const row of commentRows.slice(0, commentLimit)) {
      addExtracted(extractGitHubPullRequestReferences([row.body])
        .filter(isSparkMojoRepo));
    }
    return [...references.values()];
  }

  async function evaluateDoneGate(
    issue: { id: string; companyId: string; description?: string | null },
  ): Promise<DoneGateDecision> {
    const references = await listBoundPullRequests(issue);
    if (references.length === 0) return { outcome: "allow" };

    const states: DoneGatePullRequestState[] = [];
    for (const reference of references) {
      states.push({ reference, state: await resolvePullRequestState(issue.companyId, reference) });
    }
    // `closed` (refused PR) is a human signal — never blocks the close.
    const open = states.filter((entry) => entry.state === "open" || entry.state === "unknown");
    if (open.length === 0) return { outcome: "allow" };

    const unknownOnly = open.every((entry) => entry.state === "unknown");
    return {
      outcome: "refuse",
      reason: unknownOnly
        ? { kind: "unknown_pull_request_state", pullRequests: open }
        : { kind: "open_pull_requests", pullRequests: open },
    };
  }

  /** 409 payload shape — the refusal the card pastes back on the board. */
  function refusalError(reason: DoneGateBlockedReason) {
    const pullRequests = reason.pullRequests.map((entry) => formatReference(entry.reference));
    const unknown = reason.kind === "unknown_pull_request_state";
    return conflict(
      unknown
        ? `Issue cannot be marked done: the merge state of its pull request(s) could not be verified (fail-closed): ${pullRequests.join(", ")}. Re-try once GitHub is reachable, or override explicitly.`
        : `Issue cannot be marked done while its pull request(s) are unmerged: ${pullRequests.join(", ")}. Wait for the merge sha to land on main, then close; or pass doneOverride with a reason from a board actor.`,
      {
        code: DONE_GATE_OPEN_PR_REFUSAL,
        pullRequests: reason.pullRequests.map((entry) => ({
          ...entry.reference,
          state: entry.state,
        })),
      },
    );
  }

  /**
   * The override is recorded as an activity row AND surfaced in the refusal
   * semantics: never silent, never agent-supplied.
   */
  async function recordOverride(input: {
    issue: { id: string; companyId: string; identifier: string | null };
    override: DoneGateOverrideInput;
  }) {
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: input.override.actorType === "agent" ? "agent" : "user",
      actorId: input.override.actorId ?? "board",
      agentId: input.override.agentId,
      runId: input.override.runId,
      action: "issue.done_gate_overridden",
      entityType: "issue",
      entityId: input.issue.id,
      issueId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        reason: input.override.reason,
        gate: DONE_GATE_OPEN_PR_REFUSAL,
      },
    });
  }

  return {
    evaluateDoneGate,
    refusalError,
    recordOverride,
    listBoundPullRequests,
  };
}

/**
 * Cheap pre-check used by callers that already hold the issue row: is there
 * any reason the done gate would care about this issue at all?
 */
export async function issueHasPullRequestWorkProducts(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, issue.companyId),
      eq(issueWorkProducts.issueId, issue.id),
      eq(issueWorkProducts.type, "pull_request"),
    ))
    .limit(1);
  return rows.length > 0;
}

/** Exported for tests: scan recent comments for PR mentions (diagnostics). */
export async function listRecentPullRequestCommentMentions(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<string[]> {
  const rows = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, issue.companyId),
      eq(issueComments.issueId, issue.id),
    ))
    .orderBy(desc(issueComments.createdAt))
    .limit(COMMENT_SCAN_LIMIT_DONE_GATE);
  const mentions: string[] = [];
  for (const row of rows) {
    for (const reference of extractGitHubPullRequestReferences([row.body])) {
      mentions.push(formatReference(reference));
    }
  }
  return mentions;
}
