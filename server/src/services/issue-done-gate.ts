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
 * SPA-9578 (James ruled `narrow-exception`, 2026-09-30, interaction
 * 753031a2 on SPA-9578): a card classified as a NON-CODE COORDINATION card may
 * close while a PR it merely CITES stays open. Live gap: SPA-9575 coordinates a
 * reviewer verdict on PR #957 and cites that PR as evidence; it has no
 * `pull_request` work product, yet two `done` PATCHes were refused 409 because
 * #957 is open. Under SPA-9038 prose links bind exactly like work products, so
 * a card that is not ABOUT the PR cannot close.
 *
 * The classification is deliberately narrow, and narrow in the direction that
 * protects merge safety:
 *   - It relaxes ONLY references derived from prose (description/comments). A
 *     `pull_request` WORK PRODUCT stays fully binding — from any repo — because
 *     an attached work product is the engine's strongest statement that the PR
 *     is this card's deliverable. SPA-9038 exists precisely because that signal
 *     is weak in practice (agents usually link PRs in comments, not work
 *     products), so a work product is the one signal we still insist on.
 *   - It relaxes ONLY `state === "open"`. An `unknown` reference (GitHub
 *     unreachable, credentials missing, resolver absent, or a 404 on both the
 *     pulls and issues endpoints) stays fail-closed and still refuses. The
 *     classification is a statement about INTENT ("this card's deliverable is
 *     a coordination outcome, not a merge"), never a statement that we failed
 *     to verify something.
 *   - It may only be supplied by a user/board actor, with a reason, exactly like
 *     `doneOverride` — an agent PATCH carrying it is 403. An agent whose own PR
 *     is open therefore cannot classify its way out of the gate; that is the
 *     SPA-8593/8626/8665/8715/8722 failure class this gate exists to stop.
 *   - It is never silent: an accepted classification writes an
 *     `issue.done_gate_coordination_relaxed` activity row naming the actor, the
 *     reason, and every reference it relaxed.
 *   - No PR evidence is ever deleted to use it. The cited links stay in the card
 *     text; only the gate's binding is narrowed for that one transition.
 *
 * Verdicts are snapshot-bound: the merge state is read through the same
 * resolver seam (and cache convention) as execution-workspace delivery
 * assessment — a short TTL, never a live re-check on refusal. A reviewer who
 * re-approves within the TTL after the merge lands may see one stale refusal;
 * re-approving is cheap, intentional, and rate-limit friendly. Do not add a
 * "re-check on refuse" path.
 */

export const DONE_GATE_OPEN_PR_REFUSAL = "issue_done_with_unmerged_pull_request";

/** Activity action written when a coordination classification was accepted. */
export const DONE_GATE_COORDINATION_RELAXED = "issue.done_gate_coordination_relaxed";

/**
 * SPA-9038: PR links parsed out of card prose (description/comments) bind the
 * gate only when they point at Spark-Mojo repos — our own repos, where an
 * unmerged PR is a real DoD fact for the card. Foreign-repo mentions are
 * context, not obligations.
 */
const SPARK_MOJO_ORG = "spark-mojo";

/** How many recent comments to scan for PR mentions (SPA-9038 bindings). */
const COMMENT_SCAN_LIMIT = 200;

function isSparkMojoRepo(reference: GitHubPullRequestReference): boolean {
  return reference.owner.toLowerCase() === SPARK_MOJO_ORG;
}

export type DoneGatePullRequestReference = GitHubPullRequestReference;

export type DoneGatePullRequestState = {
  reference: GitHubPullRequestReference;
  state: "merged" | "open" | "closed" | "unknown";
};

/**
 * SPA-9578: which binding surface produced a reference. `work_product` is an
 * attached `pull_request` work product (always binding); `prose` is a link in
 * the card's description or comments (the only surface a coordination
 * classification may relax).
 */
export type BoundPullRequestSource = "work_product" | "prose";

export type BoundPullRequestReference = {
  reference: GitHubPullRequestReference;
  source: BoundPullRequestSource;
};

export type DoneGateBlockedReason =
  | { kind: "open_pull_requests"; pullRequests: DoneGatePullRequestState[] }
  | { kind: "unknown_pull_request_state"; pullRequests: DoneGatePullRequestState[] };

export type DoneGateDecision =
  | { outcome: "allow"; relaxedPullRequests?: DoneGatePullRequestState[] }
  | { outcome: "refuse"; reason: DoneGateBlockedReason };

export type DoneGateOverrideInput = {
  reason: string;
  actorType: "agent" | "user" | "board";
  actorId: string | null;
  agentId: string | null;
  runId: string | null;
};

/**
 * SPA-9578: a user/board assertion that this card is a non-code COORDINATION
 * card — its deliverable is a coordination outcome (a verdict, a routing
 * decision, a reviewer answer), not a merge. Requires a reason; never agent
 * supplied (the PATCH route rejects an agent actor with 403 before this ever
 * reaches the service, exactly as it does for `doneOverride`).
 */
export type DoneGateCoordinationClassificationInput = DoneGateOverrideInput;

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
   *
   * SPA-9578: each entry is tagged with where it came from, because only the
   * prose-derived ones may be relaxed by a coordination classification. An
   * attached work product is the strongest "this PR IS the deliverable"
   * statement the engine has and stays binding under every classification.
   * A reference found through BOTH paths keeps the work-product tag — the
   * stronger signal wins, and the card must attach a work product rather than
   * drop one to qualify.
   */
  async function listBoundPullRequests(
    issue: { id: string; companyId: string; description?: string | null },
  ) {
    const references = new Map<string, BoundPullRequestReference>();
    // Work-product bindings always win over prose for the same reference, so a
    // card cannot drop its work product to qualify for the exception.
    const record = (
      reference: GitHubPullRequestReference,
      source: BoundPullRequestSource,
    ) => {
      const key = formatReference(reference).toLowerCase();
      const existing = references.get(key);
      if (!existing) references.set(key, { reference, source });
      else if (existing.source !== "work_product" && source === "work_product") {
        existing.source = "work_product";
      }
    };
    // Raw text surfaces (work-product columns, metadata JSON) are scanned by
    // the shared extractor.
    const addRawText = (values: readonly unknown[], source: BoundPullRequestSource) => {
      for (const reference of extractGitHubPullRequestReferences(values)) {
        record(reference, source);
      }
    };
    // Prose surfaces pass already-extracted references through unchanged.
    const addExtracted = (extracted: readonly GitHubPullRequestReference[]) => {
      for (const reference of extracted) {
        record(reference, "prose");
      }
    };

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

    for (const product of products) {
      addRawText(
        [
          product.url,
          product.externalId,
          product.title,
          product.summary,
          product.metadata ? JSON.stringify(product.metadata) : null,
        ],
        "work_product",
      );
    }

    // SPA-9038: prose bindings — description first, then recent live comments.
    if (typeof issue.description === "string" && issue.description.length > 0) {
      addExtracted(extractGitHubPullRequestReferences([issue.description])
        .filter(isSparkMojoRepo));
    }
    const commentBodies = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, issue.companyId),
        eq(issueComments.issueId, issue.id),
        isNull(issueComments.deletedAt),
      ))
      .orderBy(desc(issueComments.createdAt))
      .limit(COMMENT_SCAN_LIMIT);
    for (const row of commentBodies) {
      addExtracted(extractGitHubPullRequestReferences([row.body])
        .filter(isSparkMojoRepo));
    }
    return [...references.values()];
  }

  /**
   * SPA-9578: when a user/board actor classified the card as a non-code
   * coordination card, cited (`prose`-derived) OPEN pull requests no longer
   * block that one transition. Everything else is unchanged and fail-closed:
   * `work_product` references block from any repo, and an `unknown` state
   * blocks regardless of source — the classification asserts intent about what
   * the card delivers, never that a lookup failed.
   *
   * The relaxed references are returned alongside `allow` so the caller can
   * record them; nothing is dropped silently.
   */
  async function evaluateDoneGate(
    issue: { id: string; companyId: string; description?: string | null },
    opts: { coordinationClassification?: boolean } = {},
  ): Promise<DoneGateDecision> {
    const references = await listBoundPullRequests(issue);
    if (references.length === 0) return { outcome: "allow" };

    const states: DoneGatePullRequestState[] = [];
    for (const bound of references) {
      states.push({
        reference: bound.reference,
        state: await resolvePullRequestState(issue.companyId, bound.reference),
      });
    }

    // A classification relaxes ONLY a prose-derived reference that is
    // positively OPEN. `unknown` never relaxes — fail-closed on ambiguity is
    // the one property this gate may not trade away, and the classification
    // asserts intent about the deliverable, never that a lookup failed.
    const isRelaxable = (index: number) =>
      opts.coordinationClassification === true
      && references[index]!.source === "prose"
      && states[index]!.state === "open";

    // `closed` (refused PR) is a human signal — never blocks the close.
    const blocking = states
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.state === "open" || entry.state === "unknown");
    if (blocking.length === 0) return { outcome: "allow" };

    const stillBlocking = blocking.filter(({ index }) => !isRelaxable(index));
    const relaxed = blocking.filter(({ index }) => isRelaxable(index)).map(({ entry }) => entry);

    if (stillBlocking.length === 0) {
      return relaxed.length > 0
        ? { outcome: "allow", relaxedPullRequests: relaxed }
        : { outcome: "allow" };
    }

    const open = stillBlocking.map(({ entry }) => entry);
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

  /**
   * SPA-9578: never silent. Records the accepted coordination classification,
   * the actor who supplied it, and every cited reference it relaxed — so a
   * later reader can see exactly which PRs were open when this card closed and
   * why the gate stood down.
   */
  async function recordCoordinationClassification(input: {
    issue: { id: string; companyId: string; identifier: string | null };
    classification: DoneGateCoordinationClassificationInput;
    relaxedPullRequests: DoneGatePullRequestState[];
  }) {
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: input.classification.actorType === "agent" ? "agent" : "user",
      actorId: input.classification.actorId ?? "board",
      agentId: input.classification.agentId,
      runId: input.classification.runId,
      action: DONE_GATE_COORDINATION_RELAXED,
      entityType: "issue",
      entityId: input.issue.id,
      issueId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        reason: input.classification.reason,
        gate: DONE_GATE_OPEN_PR_REFUSAL,
        scope: "prose_cited_pull_requests_only",
        pullRequests: input.relaxedPullRequests.map((entry) => ({
          reference: formatReference(entry.reference),
          state: entry.state,
        })),
      },
    });
  }

  return {
    evaluateDoneGate,
    refusalError,
    recordOverride,
    recordCoordinationClassification,
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
    .limit(COMMENT_SCAN_LIMIT);
  const mentions: string[] = [];
  for (const row of rows) {
    for (const reference of extractGitHubPullRequestReferences([row.body])) {
      mentions.push(formatReference(reference));
    }
  }
  return mentions;
}
