/**
 * SPA-12043 — pins James's SPA-11961 HYBRID card-close PR-binding rule
 * against `server/src/services/issue-done-gate.ts`.
 *
 * Today the gate binds a PR because of the SHAPE of a reference: a
 * `pull_request` work product on the card, or a GitHub PR URL / `owner/repo#N`
 * shorthand in the card's description or live comments. There is no notion of
 * ownership at all. The hybrid rule adds one, carried on
 * `issue_work_products.metadata.doneGate`:
 *
 *   - metadata ABSENT → the work product is OWNED by this card and ALWAYS
 *     binds. This is what preserves SPA-8957 + SPA-9038 exactly as they stand
 *     (clause 1).
 *   - `{ doneGate: { binding: "completion_dependency" } }` → clause 2. The
 *     card declares the PR a dependency of its own completion, so it binds
 *     ALWAYS — even when another card owns that same PR as a work product.
 *     Ownership elsewhere does not outrank a declared dependency.
 *   - `{ doneGate: { binding: "reference_only", owningIssueIdentifier } }` →
 *     clauses 3 + 4. This card only REFERENCES the PR; the reference does not
 *     bind, and only when the engine independently proves ALL of:
 *       1. exactly ONE OTHER card owns that same PR as a `pull_request` work
 *          product (uniqueness — zero owners and two-or-more owners are both
 *          unproven, and an unproven claim fails closed);
 *       2. that owner's `issues.identifier` equals `owningIssueIdentifier`
 *          exactly, compared against the stored identifier;
 *       3. the citing card is proven ROUTING-ONLY — zero `execution_workspaces`
 *          rows with `sourceIssueId` = citing card, zero `branch`/`commit` work
 *          products, and zero `pull_request` work products that are not
 *          `reference_only`. Nothing it could have authored. Prose and
 *          arbitrary citations are irrelevant to the proof.
 *     Clause 4 is the anti-self-service clause: the proof is the engine's, so
 *     writing the owning card's identifier in prose buys nothing.
 *   - any other `doneGate` shape — `{ binding: "owned" }`, `reference_only`
 *     with no `owningIssueIdentifier`, `{}`, or a non-object — is UNREADABLE
 *     attribution and the gate refuses (clause 5, fail-closed). So does a
 *     `reference_only` claim whose proof fails: no other owner (clause 5),
 *     two or more other owners, or an `owningIssueIdentifier` naming a
 *     different card than the real unique owner.
 *
 * Clause 6 is a governance statement (park such a routing card blocked on its
 * owning card until the PR lands); the engine deliberately gets no code for it.
 *
 * Assertion shape: the ambiguity cases assert `{ outcome: "refuse" }` only, so
 * a card close never depends on a reason-kind label the gate may pick. Where a
 * genuinely unmerged PR is the cause, the refusal names that PR.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueDoneGateService } from "../services/issue-done-gate.js";
import type { PullRequestMergeDetails } from "../services/github-pull-request-merge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OWNER_REPO = { owner: "Spark-Mojo", repo: "paperclip" } as const;

function prReference(number: number) {
  return { host: "github.com" as const, ...OWNER_REPO, number };
}

function details(
  state: PullRequestMergeDetails["state"],
  workProductState?: PullRequestMergeDetails["workProductState"],
  headRef?: string | null,
): PullRequestMergeDetails {
  return {
    state,
    headRef: headRef ?? null,
    headSha: null,
    ...(workProductState ? { workProductState } : {}),
  };
}

async function createCompany(db: ReturnType<typeof createDb>) {
  const company = await db
    .insert(companies)
    .values({
      name: `Hybrid Done Gate ${randomUUID()}`,
      issuePrefix: `HG${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    });
  return company;
}

/**
 * Every card carries a real identifier: the ownership proof compares
 * `issues.identifier` against the marker's `owningIssueIdentifier`, and
 * `issues_identifier_idx` is a global unique index, so identifiers are unique
 * per live row.
 */
async function createCard(
  db: ReturnType<typeof createDb>,
  companyId: string,
  overrides: Partial<typeof issues.$inferInsert> = {},
) {
  return db
    .insert(issues)
    .values({
      companyId,
      title: `Card ${randomUUID()}`,
      status: "in_progress",
      ...overrides,
    })
    .returning()
    .then((rows) => rows[0]!);
}

/**
 * Attach a `pull_request` work product. `options.doneGate === undefined` means
 * the metadata is ABSENT — clause 1's owned-and-always-binds case. Malformed
 * shapes are passed through verbatim so the gate has to read them as
 * unreadable rather than silently treating them as owned.
 */
async function attachPullRequestWorkProduct(
  db: ReturnType<typeof createDb>,
  issue: { id: string; companyId: string },
  number: number,
  options: { doneGate?: unknown; repository?: { owner: string; repo: string } } = {},
) {
  const repository = options.repository ?? OWNER_REPO;
  await db.insert(issueWorkProducts).values({
    companyId: issue.companyId,
    issueId: issue.id,
    type: "pull_request",
    provider: "github",
    title: `PR ${number}`,
    url: `https://github.com/${repository.owner}/${repository.repo}/pull/${number}`,
    status: "open",
    ...(options.doneGate === undefined ? {} : { metadata: { doneGate: options.doneGate } }),
  });
}

/** An authored branch work product — the marker of a card that built something. */
async function attachBranchWorkProduct(
  db: ReturnType<typeof createDb>,
  issue: { id: string; companyId: string },
  branchName: string,
) {
  await db.insert(issueWorkProducts).values({
    companyId: issue.companyId,
    issueId: issue.id,
    type: "branch",
    provider: "github",
    title: `branch ${branchName}`,
    url: `https://github.com/${OWNER_REPO.owner}/${OWNER_REPO.repo}/tree/${branchName}`,
    status: "open",
  });
}

async function seedExecutionWorkspace(
  db: ReturnType<typeof createDb>,
  companyId: string,
  card: { id: string },
  repoUrl: string,
  branchName: string,
) {
  const project = await db
    .insert(projects)
    .values({ companyId, name: `Project ${randomUUID()}`, status: "in_progress" })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(executionWorkspaces).values({
    companyId,
    projectId: project.id,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: `workspace ${randomUUID()}`,
    status: "active",
    sourceIssueId: card.id,
    repoUrl,
    branchName,
  });
}

describeEmbeddedPostgres("issue done gate — hybrid PR binding: reference_only vs completion_dependency (SPA-11961 / SPA-12043)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hybrid-done-gate-");
    db = createDb(tempDb.connectionString);
    const company = await createCompany(db);
    companyId = company.id;
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
    await db.delete(issueWorkProducts);
    await db.delete(activityLog);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Clause 1 + clauses 3/4. A prose citation of another card's unmerged PR
  // still refuses — the SPA-9038 shape, unchanged — and the marker cannot be
  // used to skip the proof: a citing card that provably authored an execution
  // workspace is not routing-only, so its `reference_only` claim is unproven
  // and it refuses too. Both halves here, because the refusal in (ii) is only
  // meaningful next to (i): without (i) a reader cannot tell that the same
  // citation shape binds at all.
  it("done_refused_unmerged_pr_owned_by_another_card", async () => {
    const owner = await createCard(db, companyId, { identifier: "SPA-11961" });
    await attachPullRequestWorkProduct(db, owner, 1400);
    const citing = await createCard(db, companyId, {
      identifier: "SPA-12001",
      description: "Tracking card. The fix lands in https://github.com/Spark-Mojo/paperclip/pull/1400",
    });

    // No `headRef` to classify from: the citation is unresolvable, so the
    // reference is fail-closed and binds. Nothing in today's rule reads
    // ownership here (clause 1).
    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => details("open", "open"),
    });
    const plainCitation = await gate.evaluateDoneGate({
      id: citing.id,
      companyId,
      identifier: citing.identifier,
      description: citing.description,
    });
    expect(plainCitation).toMatchObject({
      outcome: "refuse",
      reason: {
        kind: "open_pull_requests",
        pullRequests: [
          expect.objectContaining({ reference: expect.objectContaining({ number: 1400 }) }),
        ],
      },
    });

    // (ii) The same claim, made explicit with a `reference_only` marker naming
    // the real owner — but the citing card owns an execution workspace, so
    // routing-only proof FAILS and the claim is unproven (clauses 3 + 4).
    // Either the gate falls back to binding the reference or it refuses as
    // ambiguous; the card must not close either way, so the assertion pins
    // the outcome only.
    const owner2 = await createCard(db, companyId, { identifier: "SPA-11962" });
    await attachPullRequestWorkProduct(db, owner2, 1401);
    const authoringCiter = await createCard(db, companyId, { identifier: "SPA-12002" });
    await attachPullRequestWorkProduct(db, authoringCiter, 1401, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-11962" },
    });
    await seedExecutionWorkspace(
      db,
      companyId,
      authoringCiter,
      "https://github.com/Spark-Mojo/paperclip",
      "craft/SPA-12002-lane",
    );
    const workspaceGate = issueDoneGateService(db, {
      // headRef on the citing card's own lane, so a fallback that simply binds
      // the reference also refuses: this half cannot pass by accident.
      resolvePullRequestDetails: async () => ({ ...details("open", "open"), headRef: "craft/SPA-12002-lane" }),
    });
    const unprovenClaim = await workspaceGate.evaluateDoneGate({
      id: authoringCiter.id,
      companyId,
      identifier: authoringCiter.identifier,
    });
    expect(unprovenClaim).toMatchObject({ outcome: "refuse" });
  });

  // Clauses 3 + 4 — the one shape that must NOT refuse. A routing-only card
  // that only REFERENCES the owning card's PR closes while that PR is
  // unmerged. The second assertion is the positive control: the OWNING card
  // still refuses on the same PR and the same resolver, so the `allow` above
  // is the hybrid rule at work, not an unfound reference.
  it("done_allowed_routing_only_card_citing_owning_card_while_pr_unmerged", async () => {
    const owner = await createCard(db, companyId, { identifier: "SPA-11963" });
    await attachPullRequestWorkProduct(db, owner, 1410);
    const router = await createCard(db, companyId, {
      identifier: "SPA-12003",
      description: "Routing card for SPA-11963 — no deliverables of its own.",
    });
    await attachPullRequestWorkProduct(db, router, 1410, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-11963" },
    });

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async (_companyId, reference) => {
        expect(reference).toMatchObject(prReference(1410));
        return { ...details("open", "open"), headRef: "craft/SPA-11963-deliverable" };
      },
    });

    // Routing-only by construction: no execution workspaces, no branch/commit
    // work products, and its only `pull_request` product is `reference_only`.
    expect(
      await gate.evaluateDoneGate({
        id: router.id,
        companyId,
        identifier: router.identifier,
        description: router.description,
      }),
    ).toEqual({ outcome: "allow" });

    // Positive control: the unique owner of the same unmerged PR refuses.
    expect(
      await gate.evaluateDoneGate({ id: owner.id, companyId, identifier: owner.identifier }),
    ).toMatchObject({
      outcome: "refuse",
      reason: {
        kind: "open_pull_requests",
        pullRequests: [
          expect.objectContaining({ reference: expect.objectContaining({ number: 1410 }) }),
        ],
      },
    });
  });

  // Clause 2. A declared completion dependency binds even though another card
  // owns the same PR: the marker is this card's own obligation, and it
  // outranks the fact that someone else authored the branch.
  it("completion_dependency_binds_even_when_another_card_owns_the_pr", async () => {
    const owner = await createCard(db, companyId, { identifier: "SPA-11964" });
    await attachPullRequestWorkProduct(db, owner, 1411);
    const depender = await createCard(db, companyId, { identifier: "SPA-12004" });
    await attachPullRequestWorkProduct(db, depender, 1411, {
      doneGate: { binding: "completion_dependency" },
    });

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-11964-deliverable",
      }),
    });
    const decision = await gate.evaluateDoneGate({
      id: depender.id,
      companyId,
      identifier: depender.identifier,
    });
    expect(decision).toMatchObject({
      outcome: "refuse",
      reason: {
        kind: "open_pull_requests",
        pullRequests: [
          expect.objectContaining({ reference: expect.objectContaining({ number: 1411 }) }),
        ],
      },
    });
  });

  // Clause 5 (condition 1 of clause 3). `reference_only` naming a card that
  // owns nothing — here the owner does not exist at all. The uniqueness proof
  // fails, so the claim is unproven and the gate fails closed rather than
  // trusting the marker.
  it("reference_only_missing_owner_refuses_done", async () => {
    const router = await createCard(db, companyId, { identifier: "SPA-12005" });
    await attachPullRequestWorkProduct(db, router, 1412, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-11965" },
    });

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-11965-deliverable",
      }),
    });
    expect(
      await gate.evaluateDoneGate({ id: router.id, companyId, identifier: router.identifier }),
    ).toMatchObject({ outcome: "refuse" });
  });

  // Clause 5 (condition 1 of clause 3). TWO other cards own the same PR. The
  // marker names one of them, but "exactly one other owner" is the proof, and
  // duplicate ownership is precisely the ambiguity that must not close.
  it("reference_only_duplicate_owner_refuses_done", async () => {
    const ownerA = await createCard(db, companyId, { identifier: "SPA-11966" });
    await attachPullRequestWorkProduct(db, ownerA, 1413);
    const ownerB = await createCard(db, companyId, { identifier: "SPA-11967" });
    await attachPullRequestWorkProduct(db, ownerB, 1413);
    const router = await createCard(db, companyId, { identifier: "SPA-12006" });
    await attachPullRequestWorkProduct(db, router, 1413, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-11966" },
    });

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-11966-deliverable",
      }),
    });
    expect(
      await gate.evaluateDoneGate({ id: router.id, companyId, identifier: router.identifier }),
    ).toMatchObject({ outcome: "refuse" });
  });

  // Clause 5 (condition 2 of clause 3). The `owningIssueIdentifier` names a
  // card that exists but owns a DIFFERENT PR, while a different card is the
  // unique real owner. The identifier compare is exact against the stored
  // identifier, so the mismatch is a conflict, not a near miss.
  it("reference_only_conflicting_owner_identifier_refuses_done", async () => {
    const actualOwner = await createCard(db, companyId, { identifier: "SPA-11968" });
    await attachPullRequestWorkProduct(db, actualOwner, 1414);
    const namedButNotOwner = await createCard(db, companyId, { identifier: "SPA-11969" });
    await attachPullRequestWorkProduct(db, namedButNotOwner, 1415);
    const router = await createCard(db, companyId, { identifier: "SPA-12007" });
    await attachPullRequestWorkProduct(db, router, 1414, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-11969" },
    });

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async (_companyId, reference) =>
        reference.number === 1414
          ? { ...details("open", "open"), headRef: "craft/SPA-11968-deliverable" }
          : { ...details("merged"), headRef: "craft/SPA-11969-deliverable" },
    });
    expect(
      await gate.evaluateDoneGate({ id: router.id, companyId, identifier: router.identifier }),
    ).toMatchObject({ outcome: "refuse" });
  });

  // Clause 5. A `doneGate` present but not one of the two legal shapes is
  // UNREADABLE attribution. Every variant here must refuse — including a
  // `reference_only` with no `owningIssueIdentifier` (the shape a hand-rolled
  // marker is most likely to take) and a non-object `doneGate`. Asserting the
  // outcome only keeps this independent of whatever reason kind the gate
  // picks for the ambiguity.
  it("unreadable_done_gate_attribution_refuses_done", async () => {
    const malformedShapes: { cardIdentifier: string; number: number; doneGate: unknown }[] = [
      { cardIdentifier: "SPA-12008", number: 1416, doneGate: { binding: "owned" } },
      { cardIdentifier: "SPA-12009", number: 1417, doneGate: { binding: "reference_only" } },
      { cardIdentifier: "SPA-12010", number: 1418, doneGate: {} },
      { cardIdentifier: "SPA-12011", number: 1419, doneGate: "reference_only" },
    ];

    for (const shape of malformedShapes) {
      const card = await createCard(db, companyId, { identifier: shape.cardIdentifier });
      await attachPullRequestWorkProduct(db, card, shape.number, { doneGate: shape.doneGate });
      const gate = issueDoneGateService(db, {
        resolvePullRequestDetails: async () => ({
          ...details("open", "open"),
          headRef: `craft/${shape.cardIdentifier}-lane`,
        }),
      });
      const decision = await gate.evaluateDoneGate({
        id: card.id,
        companyId,
        identifier: card.identifier,
      });
      expect(decision, `doneGate ${JSON.stringify(shape.doneGate)} must refuse`).toMatchObject({
        outcome: "refuse",
      });
    }
  });

  // Clause 4 — the self-service-bypass guard. A routing-only card whose
  // PROSE mentions the owning card's identifier and its PR, with no
  // `reference_only` work product marker at all, still refuses: the marker is
  // the only way to claim a reference, and prose is not a claim. headRef sits
  // on the citing card's own lane so the citation is card-lane and binds under
  // today's classifier — the proof of authorship the card cannot escape.
  it("reference_only_requires_unique_owner_not_prose_marker", async () => {
    const owner = await createCard(db, companyId, { identifier: "SPA-11970" });
    await attachPullRequestWorkProduct(db, owner, 1420);
    const router = await createCard(db, companyId, {
      identifier: "SPA-12012",
      description:
        "Follow-up for SPA-11970. See https://github.com/Spark-Mojo/paperclip/pull/1420 — owned by SPA-11970, not by me.",
    });

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-12012-audit",
      }),
    });
    const decision = await gate.evaluateDoneGate({
      id: router.id,
      companyId,
      identifier: router.identifier,
      description: router.description,
    });
    expect(decision).toMatchObject({
      outcome: "refuse",
      reason: {
        kind: "open_pull_requests",
        pullRequests: [
          expect.objectContaining({ reference: expect.objectContaining({ number: 1420 }) }),
        ],
      },
    });
  });

  // Clause 3, condition 3 (authored branch): a card carrying an authored
  // `branch` work product is not routing-only, so its otherwise perfect
  // `reference_only` claim is unproven and it refuses.
  it("reference_only_refused_when_citing_card_authored_a_branch", async () => {
    const owner = await createCard(db, companyId, { identifier: "SPA-11971" });
    await attachPullRequestWorkProduct(db, owner, 1421);
    const builder = await createCard(db, companyId, { identifier: "SPA-12013" });
    await attachPullRequestWorkProduct(db, builder, 1421, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-11971" },
    });
    await attachBranchWorkProduct(db, builder, "craft/SPA-12013-lane");

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-11971-deliverable",
      }),
    });
    expect(
      await gate.evaluateDoneGate({ id: builder.id, companyId, identifier: builder.identifier }),
    ).toMatchObject({ outcome: "refuse" });
  });

  // Clause 1 — the discriminating shape for "absent metadata means owned".
  // This is the case that separates a correct gate from one that INFERS
  // `reference_only` from the shape of the world ("I authored nothing, and
  // exactly one other card owns this PR"). The citing card here is routing-only
  // by every signal the contract names — no execution workspace, no branch, no
  // commit — and the other card genuinely is the unique owner. It still owns
  // the unmarked product it attached, so it still binds. An inference-based
  // implementation closes this card and fails here.
  it("unmarked_pull_request_product_binds_even_on_a_routing_only_card", async () => {
    const owner = await createCard(db, companyId, { identifier: "SPA-11972" });
    await attachPullRequestWorkProduct(db, owner, 1422);
    const router = await createCard(db, companyId, { identifier: "SPA-12014" });
    await attachPullRequestWorkProduct(db, router, 1422);

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-11972-deliverable",
      }),
    });
    expect(
      await gate.evaluateDoneGate({ id: router.id, companyId, identifier: router.identifier }),
    ).toMatchObject({
      outcome: "refuse",
      reason: {
        kind: "open_pull_requests",
        pullRequests: [
          expect.objectContaining({ reference: expect.objectContaining({ number: 1422 }) }),
        ],
      },
    });
  });

  // Clause 3, condition 3, third signal: routing-only also requires zero
  // NON-reference-only `pull_request` products. A card that correctly marks one
  // PR `reference_only` but ALSO owns an unmarked PR of its own has authored a
  // deliverable, so its routing-only proof fails on the whole card and every
  // `reference_only` claim on it is unproven. An implementation that validated
  // only the marked product would mute the reference-only PR and refuse solely
  // on the unmarked one; this asserts both bind.
  it("reference_only_refused_when_citing_card_owns_another_pull_request", async () => {
    const owner = await createCard(db, companyId, { identifier: "SPA-11973" });
    await attachPullRequestWorkProduct(db, owner, 1423);
    const hybrid = await createCard(db, companyId, { identifier: "SPA-12015" });
    await attachPullRequestWorkProduct(db, hybrid, 1423, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-11973" },
    });
    await attachPullRequestWorkProduct(db, hybrid, 1424);

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-11973-deliverable",
      }),
    });
    const decision = await gate.evaluateDoneGate({
      id: hybrid.id,
      companyId,
      identifier: hybrid.identifier,
    });
    expect(decision).toMatchObject({ outcome: "refuse" });
    const refused = (decision as { reason: { pullRequests: { reference: { number: number } }[] } }).reason
      .pullRequests;
    expect(refused.map((entry) => entry.reference.number).sort()).toEqual([1423, 1424]);
  });

  // Clause 3(a) — "owns" must mean CLAIMS, so two routing-only cards cannot
  // certify each other in a circle. Neither card owns PR 1426 as an unmarked
  // product; each disclaims it and names the other. Counting disclaiming rows
  // as owners would give each exactly one "owner" (the other), and both would
  // close with the PR unmerged and nothing on the board owning it — a
  // self-service skip of immutable rule 12 built from nothing but two markers.
  // Both cards must refuse.
  it("mutually_marked_reference_only_cards_cannot_certify_each_other", async () => {
    const cardA = await createCard(db, companyId, { identifier: "SPA-12017" });
    const cardB = await createCard(db, companyId, { identifier: "SPA-12018" });
    // A attaches marking B as owner; B attaches marking A as owner. No
    // unmarked product exists on either card — that is the whole point.
    await attachPullRequestWorkProduct(db, cardA, 1426, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-12018" },
    });
    await attachPullRequestWorkProduct(db, cardB, 1426, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "SPA-12017" },
    });

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-12017-lane",
      }),
    });
    expect(
      await gate.evaluateDoneGate({ id: cardA.id, companyId, identifier: cardA.identifier }),
    ).toMatchObject({ outcome: "refuse" });
    expect(
      await gate.evaluateDoneGate({ id: cardB.id, companyId, identifier: cardB.identifier }),
    ).toMatchObject({ outcome: "refuse" });
  });

  // Clause 3, condition 2 — the identifier compare is exact. A case variant is
  // not the stored identifier, so the claim is unproven and fails closed. This
  // pins the compare against a future case-insensitive "helpful" normalisation,
  // which would silently widen who may claim a PR.
  it("reference_only_rejects_case_variant_owner_identifier", async () => {
    const owner = await createCard(db, companyId, { identifier: "SPA-11974" });
    await attachPullRequestWorkProduct(db, owner, 1425);
    const router = await createCard(db, companyId, { identifier: "SPA-12016" });
    await attachPullRequestWorkProduct(db, router, 1425, {
      doneGate: { binding: "reference_only", owningIssueIdentifier: "spa-11974" },
    });

    const gate = issueDoneGateService(db, {
      resolvePullRequestDetails: async () => ({
        ...details("open", "open"),
        headRef: "craft/SPA-11974-deliverable",
      }),
    });
    expect(
      await gate.evaluateDoneGate({ id: router.id, companyId, identifier: router.identifier }),
    ).toMatchObject({ outcome: "refuse" });
  });
});