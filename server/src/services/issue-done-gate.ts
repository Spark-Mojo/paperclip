import { and, desc, eq } from "drizzle-orm";
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
 * Detection is deliberately NARROW (a card-close DoD check that blocks
 * legitimate closures is worse than none):
 *   - The only binding signal is a `pull_request` work product on the card.
 *     PR URLs pasted into prose/comments are NOT a binding — a comment that
 *     mentions a related PR must never wedge the card closed.
 *   - `state === "merged"` passes. `state === "open"` refuses.
 *     `state === "unknown"` (GitHub unreachable, credentials missing,
 *     resolver absent) refuses — fail-closed on ambiguity.
 *   - A PR that is closed WITHOUT being merged (a refused PR) does NOT block:
 *     a refused PR is a human signal, not an engine decision (card's own
 *     "you do not" list).
 *   - A card with zero `pull_request` work products passes untouched — docs,
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

/** How many recent comments to scan for stale PR mentions (diagnostics only). */
const DIAGNOSTIC_COMMENT_SCAN_LIMIT = 20;

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
};

function formatReference(reference: GitHubPullRequestReference) {
  return `${reference.owner}/${reference.repo}#${reference.number}`;
}

/**
 * Map the merge-details snapshot onto the gate's four-state view.
 * `closed` (closed WITHOUT merge — a refused PR) is deliberately non-blocking:
 * a refused PR is a human signal, not an engine decision.
 */
function gateStateFromDetails(details: PullRequestMergeDetails): "merged" | "open" | "closed" | "unknown" {
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
   * Every `pull_request` work product on the issue is a binding. References
   * are extracted from the product's url/externalId/title/summary/metadata —
   * the same extraction surface `execution-workspaces.ts` uses for delivery
   * assessment.
   */
  async function listBoundPullRequests(issue: { id: string; companyId: string }) {
    const products = await db
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
      .limit(100);

    const references = new Map<string, GitHubPullRequestReference>();
    for (const product of products) {
      for (const reference of extractGitHubPullRequestReferences([
        product.url,
        product.externalId,
        product.title,
        product.summary,
        product.metadata ? JSON.stringify(product.metadata) : null,
      ])) {
        const key = formatReference(reference).toLowerCase();
        if (!references.has(key)) references.set(key, reference);
      }
    }
    return [...references.values()];
  }

  async function evaluateDoneGate(
    issue: { id: string; companyId: string },
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
    .limit(DIAGNOSTIC_COMMENT_SCAN_LIMIT);
  const mentions: string[] = [];
  for (const row of rows) {
    for (const reference of extractGitHubPullRequestReferences([row.body])) {
      mentions.push(formatReference(reference));
    }
  }
  return mentions;
}
