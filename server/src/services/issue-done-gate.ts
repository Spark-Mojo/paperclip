import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
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
  unresolvedPaperclipPullRoutes,
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
 * SPA-9981 (2026-10-12): historical and foreign citations were wedging cards
 * even after the actual deliverable PR merged. Real instances: SPA-9808
 * (deliverable internal#1029 merged; abandoned internal#1011
 * `ty/SPA-9808-verifier-order` still cited in the card text → permanent
 * 409), SPA-10557 (deliverable platform#1412 merged; foreign platform#1394
 * `dex/spa-10485-actionlint-cap` quoted as evidence in a comment → 409).
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
 * SPA-9981 — prose-reference classification. Product references (work
 * products) ALWAYS bind — unchanged. Prose references (description/comments)
 * bind by class, computed from the resolved PR's `headRef` and two card
 * signals (the issue's identifier and its execution-workspace branches):
 *   1. `workspace-deliverable` — the reference's repo matches an execution
 *      workspace of the issue (`execution_workspaces` joined on
 *      `sourceIssueId` = issue id and `companyId`) AND the resolved
 *      `headRef` equals that workspace's `branchName`. Binds unconditionally
 *      until merged — the CURRENT deliverable (the same equality
 *      `execution-workspaces.ts` uses to derive `merged_via_pr`) is never
 *      supersessable by anything else that landed in the repo.
 *   2. `card-lane` — the resolved `headRef` contains the issue identifier
 *      as a delimited token (case-insensitive; `SPA-9808` matches
 *      `ty/SPA-9808-verifier-order` but NOT `spa-98081-hotfix`, a different
 *      card that merely shares the digit prefix). Binds UNLESS superseded:
 *      some OTHER bound reference in the SAME repo (owner/repo,
 *      case-insensitive) that is deliverable-class (product,
 *      workspace-deliverable, or card-lane) resolves to state "merged".
 *      Supersession retires abandoned prior attempts of THIS card; it is
 *      computed from a different reference than the one being muted — a
 *      merged ref never needs muting, and a ref must not supersede itself.
 *   3. `foreign` — a resolved `headRef` (non-null) matching neither
 *      workspace-deliverable nor card-lane. NEVER binds, and is excluded
 *      from the refusal payload entirely.
 *   4. `fail-closed` — a prose reference whose resolution yields NO
 *      `headRef` (state "unknown", or `headRef` null/empty). Binds, because
 *      we cannot classify what we cannot resolve. A state of "merged"
 *      passes regardless of `headRef`; the SPA-9323 `notAPullRequest`
 *      mapping to "closed" is unchanged and non-blocking.
 *
 * Muted (non-binding) refs are excluded from the refusal `pullRequests`
 * list. The unresolved-relative-route refusal path
 * (`unresolvedPaperclipPullRoutes`) is unchanged.
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
 * SPA-9038: PR links parsed out of card prose (description/comments) bind the
 * gate only when they point at Spark-Mojo repos — our own repos, where an
 * unmerged PR is a real DoD fact for the card. Foreign-repo mentions are
 * context, not obligations.
 */
const SPARK_MOJO_ORG = "spark-mojo";

/** How many recent comments to scan for PR mentions (SPA-9038 bindings). */
const COMMENT_SCAN_LIMIT = 200;

/**
 * SPA-9981: execution-workspace rows scanned per gate evaluation. The
 * `company_source_issue_idx` index covers `(companyId, sourceIssueId)`, so
 * this stays an indexed lookup even with ~5.6k rows in production.
 */
const EXECUTION_WORKSPACE_LOOKUP_LIMIT = 200;

function isSparkMojoRepo(reference: GitHubPullRequestReference): boolean {
  return reference.owner.toLowerCase() === SPARK_MOJO_ORG;
}

/**
 * SPA-9981: local twin of `parseGitHubRepository` in `execution-workspaces.ts`.
 * Kept module-local because the two parsers must stay in lockstep but the
 * done-gate must not import the execution-workspaces service module (a
 * service-to-service import would couple the gate to the workspace
 * lifecycle's re-exports). If the canonical parser changes, mirror the
 * change here. The regex shape is the only thing that matters; nothing
 * else in the workspace service is touched.
 */
function parseGitHubRepositoryForGate(repoUrl: string | null): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  if (!match) return null;
  return { owner: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase() };
}

export type DoneGatePullRequestReference = GitHubPullRequestReference;

export type DoneGatePullRequestState = {
  reference: GitHubPullRequestReference;
  state: "merged" | "open" | "closed" | "unknown";
};

export type DoneGateBlockedReason =
  | { kind: "open_pull_requests"; pullRequests: DoneGatePullRequestState[] }
  | { kind: "unknown_pull_request_state"; pullRequests: DoneGatePullRequestState[] }
  | { kind: "unresolved_pull_request_reference"; numbers: number[] };

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
    { state: "merged" | "open" | "closed" | "unknown"; headRef: string | null; checkedAtMs: number }
  >();
  const cacheTtlMs = 60_000;

  async function resolvePullRequestState(
    companyId: string,
    reference: GitHubPullRequestReference,
  ): Promise<{ state: "merged" | "open" | "closed" | "unknown"; headRef: string | null }> {
    if (opts.resolvePullRequestDetails) {
      const details = await opts.resolvePullRequestDetails(companyId, reference);
      return { state: gateStateFromDetails(details), headRef: details.headRef ?? null };
    }
    const key = `${companyId}:${formatReference(reference).toLowerCase()}`;
    const cached = pullRequestStateCache.get(key);
    if (cached && Date.now() - cached.checkedAtMs < cacheTtlMs) {
      return { state: cached.state, headRef: cached.headRef };
    }
    const details = await defaultResolver!(companyId, reference);
    const state = gateStateFromDetails(details);
    const headRef = details.headRef ?? null;
    setBoundedPullRequestCacheEntry(pullRequestStateCache, key, {
      state,
      headRef,
      checkedAtMs: Date.now(),
    });
    return { state, headRef };
  }

  /**
   * SPA-9981: resolve the issue's execution-workspace branches, grouped by
   * repo. The result is the workspace-deliverable signal: a prose PR ref is
   * `workspace-deliverable` iff its repo matches and its resolved `headRef`
   * equals one of the listed branch names.
   */
  async function listExecutionWorkspaceBranches(
    issue: { id: string; companyId: string },
  ): Promise<Map<string, Set<string>>> {
    const byRepo = new Map<string, Set<string>>();
    const rows = await db
      .select({ repoUrl: executionWorkspaces.repoUrl, branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(and(
        eq(executionWorkspaces.companyId, issue.companyId),
        eq(executionWorkspaces.sourceIssueId, issue.id),
        isNotNull(executionWorkspaces.repoUrl),
        isNotNull(executionWorkspaces.branchName),
      ))
      .limit(EXECUTION_WORKSPACE_LOOKUP_LIMIT);
    for (const row of rows) {
      if (!row.repoUrl || !row.branchName) continue;
      const repository = parseGitHubRepositoryForGate(row.repoUrl);
      if (!repository) continue;
      const key = `${repository.owner}/${repository.repo}`;
      const branches = byRepo.get(key) ?? new Set<string>();
      branches.add(row.branchName);
      byRepo.set(key, branches);
    }
    return byRepo;
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
   * First-source-wins keying: products are inserted into the dedup Map
   * before prose, so a reference present in BOTH is recorded as a product
   * (always binding). The returned `productReferences` array is the
   * authoritative source list; the prose array holds only refs that did
   * not collide with a product.
   */
  async function listBoundPullRequests(
    issue: { id: string; companyId: string; description?: string | null },
  ) {
    const references = new Map<string, GitHubPullRequestReference>();
    const unresolved = new Set<number>();
    const productReferences: GitHubPullRequestReference[] = [];
    const proseReferences: GitHubPullRequestReference[] = [];
    const addProse = (body: string) => {
      addExtracted(extractGitHubPullRequestReferences([body]).filter(isSparkMojoRepo));
      for (const number of unresolvedPaperclipPullRoutes(body)) {
        const repos = new Set(productReferences.filter((reference) => reference.number === number && isSparkMojoRepo(reference))
          .map((reference) => `${reference.owner}/${reference.repo}`.toLowerCase()));
        if (repos.size !== 1) unresolved.add(number);
      }
    };
    const addReferences = (values: readonly unknown[]) => {
      for (const reference of extractGitHubPullRequestReferences(values)) {
        const key = formatReference(reference).toLowerCase();
        if (!references.has(key)) {
          references.set(key, reference);
          productReferences.push(reference);
        }
      }
    };
    const addExtracted = (extracted: readonly GitHubPullRequestReference[]) => {
      for (const reference of extracted) {
        const key = formatReference(reference).toLowerCase();
        if (!references.has(key)) {
          references.set(key, reference);
          proseReferences.push(reference);
        }
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
      const values = [
        product.url,
        product.externalId,
        product.title,
        product.summary,
        product.metadata ? JSON.stringify(product.metadata) : null,
      ];
      addReferences(values);
    }

    // SPA-9038: prose bindings — description first, then recent live comments.
    if (typeof issue.description === "string" && issue.description.length > 0) {
      addProse(issue.description);
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
      addProse(row.body);
    }
    return {
      references: [...references.values()],
      productReferences,
      proseReferences,
      unresolved: [...unresolved],
    };
  }

  /**
   * SPA-9981: classify one prose reference. The caller passes the
   * already-resolved `headRef` and the workspace + identifier context needed
   * to walk the four prose classes. A `null` headRef (or state `unknown`) is
   * `fail-closed` — the reference binds, because we cannot classify what we
   * cannot resolve.
   *
   * The class drives two different questions and must not be flattened into
   * one flag:
   *   - binding: workspace-deliverable, card-lane and fail-closed bind;
   *     foreign never does.
   *   - supersession: ONLY `card-lane` may be muted (by a deliverable-class
   *     merged ref in the same repo). A `workspace-deliverable` ref is the
   *     CURRENT deliverable by the engine's own definition (headRef ===
   *     workspace branchName — the same equality execution-workspaces.ts
   *     uses for `merged_via_pr`), so it binds until it merges no matter
   *     what else landed; muting it would let a card close with its actual
   *     deliverable unmerged. `fail-closed` refs carry no classification to
   *     supersede.
   */
  type ProseReferenceClass = "workspace-deliverable" | "card-lane" | "foreign" | "fail-closed";

  /**
   * SPA-9981: true when `identifier` ("SPA-9808") appears in `headRef`
   * ("ty/SPA-9808-verifier-order") as a delimited token — bounded by
   * non-alphanumerics or string edges on both sides, case-insensitive.
   * A plain substring test would let SPA-9808 match a SPA-98081 branch
   * (a different card whose identifier shares the digit prefix).
   */
  function identifierTokenMatch(headRef: string, identifier: string): boolean {
    const escaped = identifier.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(headRef.toLowerCase());
  }

  function classifyProseReference(input: {
    reference: GitHubPullRequestReference;
    state: "merged" | "open" | "closed" | "unknown";
    headRef: string | null;
    workspaceBranchesByRepo: Map<string, Set<string>>;
    identifier: string | null;
  }): ProseReferenceClass {
    const { reference, state, headRef, workspaceBranchesByRepo, identifier } = input;
    const repoKey = `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}`;
    const workspaceBranches = workspaceBranchesByRepo.get(repoKey);

    // (4) fail-closed: no headRef to classify from. Binds, never superseded.
    if (state === "unknown" || !headRef || headRef.length === 0) {
      return "fail-closed";
    }

    // (1) workspace-deliverable: headRef equals a workspace branch in this
    // repo. Binds unconditionally until merged.
    if (workspaceBranches && workspaceBranches.has(headRef)) {
      return "workspace-deliverable";
    }

    // (2) card-lane: headRef contains the issue identifier as a delimited
    // token. Binds, subject to supersession by another deliverable-class
    // merged ref in the same repo (an abandoned earlier attempt of this
    // card). The delimiters matter: SPA-9981 must NOT classify a
    // `spa-99810-hotfix` branch (a different card's identifier that merely
    // shares a digit prefix) as this card's lane.
    if (identifier && identifier.length > 0 && identifierTokenMatch(headRef, identifier)) {
      return "card-lane";
    }

    // (3) foreign: a resolved headRef that is neither workspace-deliverable
    // nor card-lane. Never binds.
    return "foreign";
  }

  async function evaluateDoneGate(
    issue: { id: string; companyId: string; description?: string | null; identifier?: string | null },
  ): Promise<DoneGateDecision> {
    const { productReferences, proseReferences, unresolved } = await listBoundPullRequests(issue);
    if (unresolved.length > 0) {
      return { outcome: "refuse", reason: { kind: "unresolved_pull_request_reference", numbers: unresolved } };
    }
    if (productReferences.length === 0 && proseReferences.length === 0) {
      return { outcome: "allow" };
    }

    const identifier = typeof issue.identifier === "string" && issue.identifier.length > 0
      ? issue.identifier
      : null;
    const workspaceBranchesByRepo = await listExecutionWorkspaceBranches(issue);

    // Resolve every reference once, in insertion order. Product refs are
    // inserted first, so they are resolved first; a merged product closes
    // the gate without needing the prose resolves (cheap path). For the
    // general case every ref's (state, headRef) is needed.
    const allReferences: GitHubPullRequestReference[] = [...productReferences, ...proseReferences];
    // Set-keyed (lowercased) source lookup — O(1) per reference, and robust
    // to case-variant duplicates that dedup merged into one object.
    const productKeys = new Set(productReferences.map((reference) => formatReference(reference).toLowerCase()));
    const resolved = new Map<
      string,
      { reference: GitHubPullRequestReference; source: "product" | "prose"; state: "merged" | "open" | "closed" | "unknown"; headRef: string | null }
    >();
    for (const reference of allReferences) {
      const key = formatReference(reference).toLowerCase();
      const source: "product" | "prose" = productKeys.has(key) ? "product" : "prose";
      const { state, headRef } = await resolvePullRequestState(issue.companyId, reference);
      resolved.set(key, { reference, source, state, headRef });
    }

    // SPA-9981 supersession pre-pass: a card-lane ref is muted when some
    // OTHER bound reference in the same repo (owner/repo, case-insensitive)
    // is deliverable-class AND resolves to state "merged". The pre-pass
    // walks only refs that have ALREADY been classified as deliverable +
    // merged, and records the repo set against which card-lane refs are
    // superseded. "Other" means a different key — a ref never supersedes
    // itself.
    const deliverableMergedRepos = new Set<string>();
    for (const entry of resolved.values()) {
      if (entry.source !== "prose") {
        // Product refs are always deliverable; merged product → supersedes
        // same-repo card-lane prose refs.
        if (entry.state === "merged") {
          deliverableMergedRepos.add(`${entry.reference.owner.toLowerCase()}/${entry.reference.repo.toLowerCase()}`);
        }
        continue;
      }
      const classification = classifyProseReference({
        reference: entry.reference,
        state: entry.state,
        headRef: entry.headRef,
        workspaceBranchesByRepo,
        identifier,
      });
      if (
        (classification === "workspace-deliverable" || classification === "card-lane")
        && entry.state === "merged"
      ) {
        deliverableMergedRepos.add(`${entry.reference.owner.toLowerCase()}/${entry.reference.repo.toLowerCase()}`);
      }
    }

    // Build the refusal list. Product refs: always binding. Prose refs:
    // classify, then mute if (foreign) or (card-lane AND superseded by
    // deliverable-merged in the same repo). Merged state is a pass
    // regardless of classification and never contributes to the refusal.
    // workspace-deliverable and fail-closed prose refs are NEVER muted —
    // the current deliverable binds until it merges, and an unclassifiable
    // reference has nothing to supersede it with.
    const refusal: DoneGatePullRequestState[] = [];
    for (const entry of resolved.values()) {
      if (entry.state === "merged" || entry.state === "closed") continue;
      if (entry.source === "product") {
        refusal.push({ reference: entry.reference, state: entry.state });
        continue;
      }
      const classification = classifyProseReference({
        reference: entry.reference,
        state: entry.state,
        headRef: entry.headRef,
        workspaceBranchesByRepo,
        identifier,
      });
      if (classification === "foreign") continue; // excluded from refusal
      if (classification === "card-lane") {
        // An abandoned prior attempt of this card — mute when a
        // deliverable-class ref in the same repo already resolved to
        // "merged". The deliverable-merged signal is by construction a
        // different ref than this one (merged refs were filtered above).
        const repoKey = `${entry.reference.owner.toLowerCase()}/${entry.reference.repo.toLowerCase()}`;
        if (deliverableMergedRepos.has(repoKey)) continue;
      }
      refusal.push({ reference: entry.reference, state: entry.state });
    }
    if (refusal.length === 0) return { outcome: "allow" };

    const unknownOnly = refusal.every((entry) => entry.state === "unknown");
    return {
      outcome: "refuse",
      reason: unknownOnly
        ? { kind: "unknown_pull_request_state", pullRequests: refusal }
        : { kind: "open_pull_requests", pullRequests: refusal },
    };
  }

  /** 409 payload shape — the refusal the card pastes back on the board. */
  function refusalError(reason: DoneGateBlockedReason) {
    if (reason.kind === "unresolved_pull_request_reference") {
      return conflict(
        `Issue cannot be marked done: relative PR link(s) ${reason.numbers.map((number) => `#${number}`).join(", ")} lack an adjacent (Spark-Mojo/repo) identity. Add the repository next to each link or attach a pull_request work product.`,
        { code: DONE_GATE_OPEN_PR_REFUSAL, pullRequests: [], unresolvedPullRequestNumbers: reason.numbers },
      );
    }
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
    .limit(COMMENT_SCAN_LIMIT);
  const mentions: string[] = [];
  for (const row of rows) {
    for (const reference of extractGitHubPullRequestReferences([row.body])) {
      mentions.push(formatReference(reference));
    }
  }
  return mentions;
}
