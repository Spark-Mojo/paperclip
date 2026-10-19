import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  issueComments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
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
 * SPA-12043 (James's SPA-11961 HYBRID card-close rule) — WORK-PRODUCT
 * ATTRIBUTION. Until now the gate bound a PR by the SHAPE of a reference: a
 * `pull_request` work product on the card, or a GitHub PR URL /
 * `owner/repo#N` shorthand in card prose. Ownership was not a concept the gate
 * could see, so a follow-up or routing card that merely CITED another card's
 * deliverable PR refused to close for as long as that PR was open — while the
 * builder card, the one that owns the PR, was the only card the rule had
 * anything to say about. The hybrid rule adds ownership, carried on
 * `issue_work_products.metadata.doneGate` (work products only — prose is never
 * a claim):
 *
 *   - `doneGate` ABSENT (or a jsonb `null`) → the work product is OWNED by
 *     this card and ALWAYS binds. This is clause 1, and it is what preserves
 *     SPA-8957 + SPA-9038 verbatim: an unmarked product is exactly the product
 *     those two rulings were written about. Notably the gate must never
 *     INFER `reference_only` from the shape of the world — a card that
 *     authored nothing while some other card uniquely owns the PR still OWNS
 *     its own unmarked product, and inference would hand every such card a
 *     free skip of immutable rule 12.
 *   - `{ binding: "completion_dependency" }` → clause 2: the card declares the
 *     PR a dependency of its own completion, so it binds ALWAYS, even when
 *     another card owns that same PR as a work product. Ownership elsewhere
 *     does not outrank a declared dependency — the depender opted in.
 *   - `{ binding: "reference_only", owningIssueIdentifier }` → clauses 3 + 4:
 *     the card only REFERENCES the PR; the reference does not bind, and only
 *     when the ENGINE independently proves all three:
 *       (a) exactly ONE OTHER card owns that same PR as a `pull_request` work
 *           product — zero owners and two-or-more owners are both unproven.
 *           "Owns" means the row CLAIMS the PR: a row whose own marker is
 *           `reference_only` is a disclaimer and does not count, so two
 *           routing-only cards cannot certify each other in a circle and
 *           close over an unmerged PR that nobody owns;
 *       (b) that owner's `issues.identifier` equals `owningIssueIdentifier`
 *           EXACTLY — case-sensitive string equality against the stored
 *           identifier. A "helpful" case-insensitive normalisation here would
 *           silently widen who may claim someone else's PR;
 *       (c) the citing card is proven ROUTING-ONLY — zero `execution_workspaces`
 *           rows with `sourceIssueId` = the citing card, zero `branch`/`commit`
 *           work products, and zero `pull_request` work products that are not
 *           `reference_only`: nothing it could have authored. (c) is a
 *           WHOLE-CARD property, so a card that also owns an unmarked PR
 *           product of its own fails (c) and then EVERY `reference_only`
 *           claim on that card is unproven — including one that is correctly
 *           marked beside it.
 *   - any other shape — `{ binding: "owned" }`, `reference_only` with a
 *     missing/blank/non-string `owningIssueIdentifier`, `{}`, or a non-object —
 *     is UNREADABLE attribution and REFUSES (clause 4). So does any
 *     `reference_only` claim whose proof fails (clause 5). Malformed input
 *     never throws and never buys a bypass: it refuses, exactly as an unmerged
 *     PR does, and it reuses the `open_pull_requests` refusal kind so the
 *     board message stays truthful (the card cannot close while an unmerged PR
 *     is attributed to it).
 *
 * WHY the proof is engine-derived rather than read off the marker: the marker
 * is written by the very card that wants the bypass. If naming an owning
 * identifier were sufficient — in metadata or in prose — SPA-11961 would be a
 * self-service skip of immutable rule 12: attach a product, name someone else,
 * close with an unmerged deliverable. So (a) counts other cards' real rows,
 * (b) compares the owner's stored `issues.identifier`, and (c) counts what
 * this card actually authored. Prose keeps its SPA-9981 classification
 * untouched, because a sentence citing another card's PR is exactly the shape
 * that must NOT earn reference-only status. Prose also cannot EARN it: the
 * attribute is only ever read off a `pull_request` work product. One
 * consequence worth stating, because it is load-bearing for SPA-9038: a prose
 * citation of the same PR is deduped INTO the product entry, so the
 * product-level decision governs in both directions — re-linking the PR in a
 * closing comment neither resurrects a reference the product retired nor
 * downgrades one the product binds.
 *
 * Uniqueness is enforced IN THE GATE on every evaluation, deliberately NOT by
 * a DB unique index: `issue_work_products` has no normalized PR-key column to
 * index (PR identity is extracted in JS from url/externalId/title/summary/
 * metadata), and the fork's drizzle snapshot chain is already base-red —
 * `9286` carries no snapshot — so a migration here would land on a broken
 * chain. A gate-side count is also the stronger property: it is re-proved at
 * every close, so a duplicate owner inserted after the fact cannot ride an
 * older proof.
 *
 * Clause 6 — park such a routing card `blocked` on its owning card until the
 * PR lands — is a GOVERNANCE statement and deliberately gets NO code here.
 * The interim workaround (an agent triages the blocked pair on the board)
 * must not be canonised into the engine: turning a temporary human habit into
 * engine behaviour is precisely what the card ruled out.
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
export const DONE_GATE_INCOMPLETE_STAGE_REFUSAL = "issue_done_with_incomplete_execution_stage";
// SPA-13737 — escalation close-guard: an escalation issue (stranded-issue
// recovery, harness-liveness escalation) may not reach `done` without an
// action-evidence receipt on the card.
export const DONE_GATE_ESCALATION_RECEIPT_REFUSAL = "issue_done_without_escalation_receipt";

export function assertIssueExecutionStagesComplete(issue: {
  executionPolicy?: unknown;
  executionState?: unknown;
}) {
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
  if (!policy?.stages.length) return;
  const state = parseIssueExecutionState(issue.executionState);
  const incomplete = policy.stages.filter((stage) => !state?.completedStageIds.includes(stage.id));
  if (state?.status === "completed" && incomplete.length === 0) return;
  throw conflict(
    "Issue cannot be marked done: configured review or approval stage is incomplete. Enter in_review and record the stage verdict, or use an explicit board doneOverride with a reason.",
    { code: DONE_GATE_INCOMPLETE_STAGE_REFUSAL, incompleteStageIds: incomplete.map((stage) => stage.id) },
  );
}

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

/**
 * SPA-12043: `pull_request` work products read per evaluation (unchanged
 * SPA-9981 bound). A saturated read is surfaced as `productScanTruncated` so
 * the routing-only proof can fail closed on it: a truncated view of a card's
 * products must never read as "this card owns none".
 */
const PULL_REQUEST_PRODUCT_SCAN_LIMIT = 100;

/**
 * SPA-12043: other cards' `pull_request` work products scanned for the
 * ownership proof. There is no normalized PR-key column, so uniqueness is
 * counted in JS over extracted references — and a saturated scan is treated as
 * UNPROVEN (fail-closed), never as "only one owner".
 */
const OTHER_PULL_REQUEST_OWNER_SCAN_LIMIT = 5_000;

/**
 * SPA-12043 clause 3(c): work-product types that prove a card AUTHORED
 * something, so it cannot be a routing-only citer.
 */
const AUTHORED_WORK_PRODUCT_TYPES: string[] = ["branch", "commit"];

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
  | { kind: "unresolved_pull_request_reference"; numbers: number[] }
  | { kind: "missing_escalation_action_receipt"; originKind: string; signal: "originKind" | "title-fallback" };

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
 * SPA-12043: the attribution a `pull_request` work product claims for itself,
 * read from `metadata.doneGate`.
 *
 *   - `undefined` — no usable `doneGate` assertion: absent, a jsonb `null`
 *     (which is not an assertion), or a `metadata` value that is not a plain
 *     object at all. The product is OWNED by this card and binds. Clause 1;
 *     this is the overwhelming majority of products and preserves SPA-8957 +
 *     SPA-9038 unchanged.
 *   - `{ kind: "completion_dependency" }` — clause 2; binds always.
 *   - `{ kind: "reference_only", owningIssueIdentifier }` — clause 3; a CLAIM
 *     that drops the reference out of the refusal only when the engine proves
 *     it (see `proveReferenceOnlyClaims`).
 *   - `{ kind: "unreadable" }` — present but not one of the two legal shapes.
 *
 * Malformed input is a VALUE here, never a throw: a gate that throws on a
 * hand-rolled marker would 500 the close instead of refusing it, and a gate
 * that guessed "owned" would be a bypass. Unreadable binds.
 */
export type DoneGateAttribution =
  | undefined
  | { kind: "completion_dependency" }
  | { kind: "reference_only"; owningIssueIdentifier: string }
  | { kind: "unreadable" };

function readDoneGateAttribution(metadata: unknown): DoneGateAttribution {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const raw = (metadata as Record<string, unknown>).doneGate;
  // Absent, and a jsonb `null`, are both "no assertion" — the product is
  // owned. Only a PRESENT value can be attribution.
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "unreadable" };
  const marker = raw as Record<string, unknown>;
  if (marker.binding === "completion_dependency") return { kind: "completion_dependency" };
  if (marker.binding === "reference_only") {
    const owningIssueIdentifier = marker.owningIssueIdentifier;
    if (typeof owningIssueIdentifier !== "string" || owningIssueIdentifier.trim().length === 0) {
      return { kind: "unreadable" };
    }
    // The RAW string is what gets compared: trimming here would let a padded
    // identifier pass a proof it has not earned.
    return { kind: "reference_only", owningIssueIdentifier };
  }
  return { kind: "unreadable" };
}

/**
 * The exact value array a `pull_request` work product is scanned for
 * references in — shared by the card's own products (`listBoundPullRequests`)
 * and by the ownership proof's other-card scan, so both sides of the
 * uniqueness count extract identity through ONE code path.
 */
function workProductReferenceValues(row: {
  url: string | null;
  externalId: string | null;
  title: string | null;
  summary: string | null;
  metadata: unknown;
}): unknown[] {
  return [row.url, row.externalId, row.title, row.summary, row.metadata ? JSON.stringify(row.metadata) : null];
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

/**
 * SPA-13737 — escalation close-guard input. `originKind` is the issue's stored
 * `origin_kind`; `doneGateOverride` is the route-minted bypass (board-only).
 * `title` feeds the legacy-fallback branch (see checkEscalationCloseGuard).
 */
export const ESCALATION_CLOSE_GUARD_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  "stranded_issue_recovery",
  "harness_liveness_escalation",
  // SPA-13753: "issue_productivity_review" and "stale_active_run_evaluation"
  // are deliberately NOT guarded. They are system-fold closures, not human
  // escalation closes: the source-resolved watchdog fold
  // (active-run-watchdog/adapters/postgres.ts foldSourceResolvedRun) closes
  // the evaluation card via update({status:"done", doneGateBypass:true}) with
  // no work product attached, and the guard runs even under doneGateBypass
  // by design — so guarding these kinds 409s the fold and rolls back its
  // transaction (heartbeat-active-run-output-watchdog.test.ts expects the
  // evaluation to land done). The guard's purpose is human escalation-close
  // evidence; these kinds carry none by design.
]);

/**
 * SPA-13737 hardened fix (SPA-13683-shaped cards): escalate-filed cards carry
 * NO explicit originKind, so the server defaults them to "manual". Match the
 * exact anchored title prefix board-status.sh escalate files
 * ("Escalation: <card> stuck waiting on <tok>").
 */
export const ESCALATION_CLOSE_GUARD_TITLE_PREFIX = "Escalation:";

export const ESCALATION_ACTION_EVIDENCE_WORK_PRODUCT_TYPES: ReadonlySet<string> = new Set([
  "pull_request",
  "commit",
  "branch",
]);

export async function issueHasEscalationActionReceipt(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<boolean> {
  // Fail closed: no positive control (a qualifying row) means no receipt.
  // The evidence predicate lives in SQL with limit(1): scanning a capped,
  // unordered page in JS would ignore a valid receipt past row 100.
  const rows = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, issue.companyId),
      eq(issueWorkProducts.issueId, issue.id),
      inArray(issueWorkProducts.type, [...ESCALATION_ACTION_EVIDENCE_WORK_PRODUCT_TYPES]),
      or(
        sql`coalesce(${issueWorkProducts.externalId}, '') ~ '[^[:space:]]'`,
        sql`coalesce(${issueWorkProducts.url}, '') ~ '[^[:space:]]'`,
        isNotNull(issueWorkProducts.createdByRunId),
      ),
    ))
    .limit(1);
  return rows.length > 0;
}

export async function checkEscalationCloseGuard(
  db: Db,
  input: {
    issue: { id: string; companyId: string; originKind?: string | null; title?: string | null };
    /**
     * SPA-13737 de-escalation evasion fix: the CLOSING snapshot (incoming
     * values when defined, else stored). The guard signals if EITHER the
     * stored or the closing snapshot matches — a stored escalation flipped
     * to manual/routine-title + done in one op must still refuse, and a
     * closing flip into an escalation signal must still refuse. Absent =
     * evaluate `issue` alone (evaluateDoneGate's internal call passes the
     * closing values as `issue`, so it is unchanged).
     */
    closingIssue?: { originKind?: string | null; title?: string | null };
    doneGateOverride?: unknown;
  },
): Promise<DoneGateDecision> {
  const escalationSignalOf = (snapshot: { originKind?: string | null; title?: string | null }): "originKind" | "title-fallback" | null => {
    const originKind = snapshot.originKind ?? null;
    if (originKind && ESCALATION_CLOSE_GUARD_ORIGIN_KINDS.has(originKind)) {
      return "originKind";
    }
    if (
      // Legacy-fallback for escalate-filed cards that predate an explicit
      // originKind: board-status.sh escalate files title
      // "Escalation: <card> stuck waiting on <tok>" with NO originKind, so the
      // server defaults originKind to "manual" (services/issues.ts).
      (!originKind || originKind === "manual") &&
      (snapshot.title ?? "").startsWith(ESCALATION_CLOSE_GUARD_TITLE_PREFIX)
    ) {
      return "title-fallback";
    }
    return null;
  };
  const storedSignal = escalationSignalOf(input.issue);
  const closingSignal = input.closingIssue ? escalationSignalOf(input.closingIssue) : null;
  const signal = storedSignal ?? closingSignal;
  if (!signal) {
    return { outcome: "allow" };
  }
  const signalingOriginKind = (storedSignal ? input.issue.originKind : input.closingIssue?.originKind) ?? null;
  // Board-only override bypasses (never agent-supplied; the route rejects
  // agent overrides before this point). No resolution-note branch: the issue
  // update path carries no resolution note (verified 2026-10-19 — the update
  // options type has doneGateOverride/doneGateBypass only, and resolutionNote
  // lives on recovery-action resolution), so a note branch here would be a
  // dead allow-path.
  if (input.doneGateOverride) return { outcome: "allow" };
  if (await issueHasEscalationActionReceipt(db, input.issue)) {
    return { outcome: "allow" };
  }
  return { outcome: "refuse", reason: { kind: "missing_escalation_action_receipt", originKind: signalingOriginKind ?? "manual", signal } };
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
   *
   * SPA-12043: the same pass returns the per-key attribution each product
   * claims (`attributionByKey`, keyed on the lowercased `owner/repo#N`),
   * the per-ROW attributions (`productAttributions`, in row order — the
   * routing-only proof reads these, not the deduped keys, so a `pull_request`
   * row that extracts no reference still counts as an owned product), and
   * `productScanTruncated` for the fail-closed case.
   */
  async function listBoundPullRequests(
    issue: { id: string; companyId: string; description?: string | null },
  ) {
    const references = new Map<string, GitHubPullRequestReference>();
    const unresolved = new Set<number>();
    const productReferences: GitHubPullRequestReference[] = [];
    const proseReferences: GitHubPullRequestReference[] = [];
    const attributionByKey = new Map<string, DoneGateAttribution>();
    const productAttributions: DoneGateAttribution[] = [];
    /**
     * Two products on the same card can cite the same PR with different
     * markers. Fail closed: the key counts as `reference_only` only when
     * EVERY row that cites it says so — one unmarked row beside a marked one
     * re-asserts ownership. Two MARKED rows that name DIFFERENT owners are
     * also refused: the first row's identifier is not silently kept, because
     * picking one of two conflicting claims would let a card choose which
     * owner to be judged against.
     */
    const recordAttribution = (key: string, attribution: DoneGateAttribution) => {
      if (!attributionByKey.has(key)) {
        attributionByKey.set(key, attribution);
        return;
      }
      const existing = attributionByKey.get(key);
      if (existing?.kind !== "reference_only" || attribution?.kind !== "reference_only") {
        attributionByKey.set(key, undefined);
        return;
      }
      // Both marked, but naming DIFFERENT owners. Keep neither: letting the
      // first row decide which owner the card is judged against would let a
      // card write a second, self-serving marker beside an honest one.
      if (existing.owningIssueIdentifier !== attribution.owningIssueIdentifier) {
        attributionByKey.set(key, undefined);
      }
    };
    const addProse = (body: string) => {
      addExtracted(extractGitHubPullRequestReferences([body]).filter(isSparkMojoRepo));
      for (const number of unresolvedPaperclipPullRoutes(body)) {
        const repos = new Set(productReferences.filter((reference) => reference.number === number && isSparkMojoRepo(reference))
          .map((reference) => `${reference.owner}/${reference.repo}`.toLowerCase()));
        if (repos.size !== 1) unresolved.add(number);
      }
    };
    const addReferences = (values: readonly unknown[], attribution: DoneGateAttribution) => {
      for (const reference of extractGitHubPullRequestReferences(values)) {
        const key = formatReference(reference).toLowerCase();
        if (!references.has(key)) {
          references.set(key, reference);
          productReferences.push(reference);
        }
        recordAttribution(key, attribution);
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
      .limit(PULL_REQUEST_PRODUCT_SCAN_LIMIT);

    for (const product of products) {
      const attribution = readDoneGateAttribution(product.metadata);
      productAttributions.push(attribution);
      addReferences(workProductReferenceValues(product), attribution);
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
      attributionByKey,
      productAttributions,
      productScanTruncated: products.length >= PULL_REQUEST_PRODUCT_SCAN_LIMIT,
    };
  }

  /**
   * SPA-12043 clause 3(a): every OTHER card's `pull_request` work products in
   * the company, mapped to the issue ids that cite each reference key. Same
   * five columns and the same `extractGitHubPullRequestReferences` surface as
   * `listBoundPullRequests` — one extraction code path, so "the same PR" means
   * the same thing on both sides of the count.
   *
   * `truncated` is a fail-closed signal, not a size hint: a truncated scan
   * cannot prove that an owner is the ONLY owner, so every claim it would
   * support stays unproven.
   *
   * A row that DISCLAIMS (its own marker is `reference_only`) is not an owner.
   * This is what stops two routing-only cards from certifying each other: if
   * C marks PR X `reference_only` naming A, and A marks X `reference_only`
   * naming C, then counting disclaiming rows as owners gives each card exactly
   * one "owner" — the other — and both close with the PR unmerged and nothing
   * in the board owning it. Ownership must be asserted by someone, so the
   * count is over rows that actually CLAIM the PR: unmarked (clause 1),
   * `completion_dependency` (clause 2), and `unreadable` (which binds, and so
   * is the stricter reading — an ambiguous marker never manufactures an owner
   * out of thin air, it just cannot be discounted either).
   */
  async function listOtherPullRequestOwners(issue: { id: string; companyId: string }) {
    const rows = await db
      .select({
        issueId: issueWorkProducts.issueId,
        url: issueWorkProducts.url,
        externalId: issueWorkProducts.externalId,
        title: issueWorkProducts.title,
        summary: issueWorkProducts.summary,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.type, "pull_request"),
        ne(issueWorkProducts.issueId, issue.id),
      ))
      .limit(OTHER_PULL_REQUEST_OWNER_SCAN_LIMIT);
    const owners = new Map<string, Set<string>>();
    for (const row of rows) {
      // A disclaiming row is a reference, not an owner (see the doc block).
      if (readDoneGateAttribution(row.metadata)?.kind === "reference_only") continue;
      for (const reference of extractGitHubPullRequestReferences(workProductReferenceValues(row))) {
        const key = formatReference(reference).toLowerCase();
        const issueIds = owners.get(key) ?? new Set<string>();
        issueIds.add(row.issueId);
        owners.set(key, issueIds);
      }
    }
    return { owners, truncated: rows.length >= OTHER_PULL_REQUEST_OWNER_SCAN_LIMIT };
  }

  /**
   * SPA-12043 clause 3(c): the citing card is ROUTING-ONLY — it could not have
   * authored the PR it references. Three signals, none of them prose: zero
   * `execution_workspaces` rows sourced from this card, zero `branch`/`commit`
   * work products, and zero `pull_request` products that are not
   * `reference_only`.
   *
   * Read from the per-ROW attributions, not the deduped reference keys, and
   * evaluated per CARD rather than per marked product: one unmarked PR product
   * of its own fails the whole card, and then every `reference_only` claim on
   * it is unproven — including a correctly marked one sitting beside it.
   */
  async function isRoutingOnlyCard(
    issue: { id: string; companyId: string },
    productAttributions: readonly DoneGateAttribution[],
    productScanTruncated: boolean,
  ): Promise<boolean> {
    // A truncated view of this card's products must not read as "owns none".
    if (productScanTruncated) return false;
    for (const attribution of productAttributions) {
      if (attribution?.kind !== "reference_only") return false;
    }
    const workspaces = await db
      .select({ id: executionWorkspaces.id })
      .from(executionWorkspaces)
      .where(and(
        eq(executionWorkspaces.companyId, issue.companyId),
        eq(executionWorkspaces.sourceIssueId, issue.id),
      ))
      .limit(1);
    if (workspaces.length > 0) return false;
    // `execution_workspaces.sourceIssueId` is nullable and `onDelete: "set
    // null"`, so a workspace whose source card was removed leaves no
    // `sourceIssueId` trail — but a product row carrying a non-null
    // `executionWorkspaceId` is direct evidence that a real workspace produced
    // it. Treat that as authorship: it can only make (c) fail closed.
    const workspaceProduced = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        isNotNull(issueWorkProducts.executionWorkspaceId),
      ))
      .limit(1);
    if (workspaceProduced.length > 0) return false;
    const authored = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        inArray(issueWorkProducts.type, AUTHORED_WORK_PRODUCT_TYPES),
      ))
      .limit(1);
    return authored.length === 0;
  }

  /**
   * SPA-12043 clause 3(b): the candidate owners' STORED identifiers. Company
   * scoped even though the ids came from a company-scoped scan — a predicate
   * the proof does not need is free defence against a scan that ever widens.
   * A row that cannot be read back (deleted, moved) simply yields no entry,
   * which fails the exact compare and refuses.
   */
  async function loadIssueIdentifiers(
    companyId: string,
    issueIds: readonly string[],
  ): Promise<Map<string, string>> {
    const identifiers = new Map<string, string>();
    if (issueIds.length === 0) return identifiers;
    const rows = await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        inArray(issues.id, [...issueIds]),
      ))
      .limit(issueIds.length);
    for (const row of rows) {
      if (typeof row.identifier === "string") identifiers.set(row.id, row.identifier);
    }
    return identifiers;
  }

  /**
   * SPA-12043 clause 3: prove every `reference_only` claim on this card, once
   * per evaluation and only when a claim exists (most evaluations carry no
   * `doneGate` metadata at all and must not pay for these reads).
   *
   * THE PROOF IS THE ENGINE'S, NOT THE MARKER'S. A `doneGate` marker is
   * written by the very card that wants the bypass, so trusting
   * `owningIssueIdentifier` because the marker says so would make SPA-11961 a
   * self-service skip of immutable rule 12: attach a product, name someone
   * else, close with an unmerged deliverable. What is honoured here is a
   * derivation the citing card cannot fake — other cards' real rows, the
   * owner's stored `issues.identifier`, and what this card actually authored.
   *
   * Fail-closed by construction: the verdict map starts all-false and no path
   * that cannot PROVE a claim ever sets it true, so an unreadable marker, a
   * zero-owner scan, duplicate owners, a truncated scan, a missing identifier
   * row and an exact-compare mismatch all land identically — the reference
   * binds and the card refuses.
   */
  async function proveReferenceOnlyClaims(input: {
    issue: { id: string; companyId: string };
    claims: ReadonlyMap<string, string>;
    productAttributions: readonly DoneGateAttribution[];
    productScanTruncated: boolean;
  }): Promise<Map<string, boolean>> {
    const verdicts = new Map<string, boolean>();
    for (const key of input.claims.keys()) verdicts.set(key, false);
    if (verdicts.size === 0) return verdicts;

    // (c) whole-card, cheapest, and it decides every claim at once.
    const routingOnly = await isRoutingOnlyCard(
      input.issue,
      input.productAttributions,
      input.productScanTruncated,
    );
    if (!routingOnly) return verdicts;

    // (a) uniqueness, counted over other cards' real rows.
    const { owners, truncated } = await listOtherPullRequestOwners(input.issue);
    if (truncated) return verdicts;
    const candidateOwnerIds = new Set<string>();
    for (const key of input.claims.keys()) {
      for (const ownerIssueId of owners.get(key) ?? []) candidateOwnerIds.add(ownerIssueId);
    }

    // (b) exact identifier equality against the owner's STORED identifier.
    const identifiers = await loadIssueIdentifiers(input.issue.companyId, [...candidateOwnerIds]);
    for (const [key, owningIssueIdentifier] of input.claims) {
      const ownerIssueIds = owners.get(key);
      // Zero owners and two-or-more owners are both unproven: ambiguity is not
      // a licence, it is the absence of one.
      if (!ownerIssueIds || ownerIssueIds.size !== 1) continue;
      const ownerIssueId = [...ownerIssueIds][0]!;
      // Case-sensitive by design — see the module header.
      verdicts.set(key, identifiers.get(ownerIssueId) === owningIssueIdentifier);
    }
    return verdicts;
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
    issue: { id: string; companyId: string; description?: string | null; identifier?: string | null; originKind?: string | null; title?: string | null },
  ): Promise<DoneGateDecision> {
    // SPA-13737 escalation close-guard first: an escalation close without an
    // action-evidence receipt refuses before the PR gate runs. Passes through
    // (allow) for non-escalation cards.
    const escalation = await checkEscalationCloseGuard(db, { issue });
    if (escalation.outcome === "refuse") return escalation;
    const bound = await listBoundPullRequests(issue);
    const { productReferences, proseReferences, unresolved, attributionByKey } = bound;
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
        // same-repo card-lane prose refs. SPA-12043 leaves this untouched on
        // purpose: it is a same-repo mutation rule over refs this card BOUND,
        // and narrowing it would change SPA-9981 behaviour for unmarked
        // products, which clause 1 freezes.
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
    //
    // SPA-12043: collect this card's `reference_only` claims. Evaluated lazily
    // below (only if a product branch actually reaches one) because the
    // overwhelming majority of evaluations carry no `doneGate` metadata at all
    // and must not pay for the proof's extra reads.
    const referenceOnlyClaims = new Map<string, string>();
    for (const [key, attribution] of attributionByKey) {
      if (attribution?.kind === "reference_only") referenceOnlyClaims.set(key, attribution.owningIssueIdentifier);
    }
    let referenceOnlyVerdicts: Map<string, boolean> | null = null;

    const refusal: DoneGatePullRequestState[] = [];
    for (const [entryKey, entry] of resolved) {
      if (entry.state === "merged" || entry.state === "closed") continue;
      if (entry.source === "product") {
        // SPA-12043 — the hybrid rule's one decision point. Absent marker =
        // OWNED and binds (clause 1: SPA-8957 + SPA-9038 verbatim);
        // `completion_dependency` binds even when another card owns the PR
        // (clause 2); a `reference_only` claim leaves the refusal ONLY where
        // the engine proved it (clauses 3 + 4). Every other shape — unreadable
        // attribution (clause 4) and any unproven claim (clause 5) — falls
        // through to `refusal.push`, because the marker is never self-service.
        if (attributionByKey.get(entryKey)?.kind === "reference_only") {
          referenceOnlyVerdicts ??= await proveReferenceOnlyClaims({
            issue,
            claims: referenceOnlyClaims,
            productAttributions: bound.productAttributions,
            productScanTruncated: bound.productScanTruncated,
          });
          if (referenceOnlyVerdicts.get(entryKey) === true) continue;
        }
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

  /**
   * 409 payload shape — the refusal the card pastes back on the board.
   *
   * SPA-12043 deliberately adds NO reason kind: an unreadable `doneGate` marker
   * and an unproven `reference_only` claim both land here as
   * `open_pull_requests`, which is the truth they need to tell — an unmerged PR
   * is attributed to this card, so this card cannot close. Do not add a
   * dedicated ambiguity kind for it: the branch below is a non-exhaustive read
   * of `reason.pullRequests`, and a new kind without a new branch here would
   * ship a broken payload.
   */
  function refusalError(reason: DoneGateBlockedReason) {
    if (reason.kind === "missing_escalation_action_receipt") {
      return conflict(
        `Issue cannot be marked done: escalation issue (origin ${reason.originKind}, signal ${reason.signal}) has no action-evidence receipt. Attach a pull_request/commit/branch work product with an external id or url, or use an explicit board doneOverride.`,
        { code: DONE_GATE_ESCALATION_RECEIPT_REFUSAL, originKind: reason.originKind, signal: reason.signal },
      );
    }
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
    checkEscalationCloseGuard,
    issueHasEscalationActionReceipt,
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
