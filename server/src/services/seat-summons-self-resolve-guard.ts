/**
 * Seat-summons self-resolve guard (SPA-13735, class D).
 *
 * Pure-function companion to the live audience evaluator
 * `evaluateIssueThreadInteractionResolverAudience` in
 * `issue-thread-interaction-resolution.ts` (creator-exclusion / `not_creator`,
 * denial code `interaction_creator_excluded`) and the verdicts route
 * (audit action `issue.thread_interaction_item_verdicts_submitted`).
 *
 * This module is intentionally standalone: no DB, no network, no route wiring.
 * It only classifies summons-shaped interactions and refuses self-resolution
 * (fail-closed on missing/invalid identity).
 */

export type SeatSummonsInteractionInput = {
  kind?: string;
  tags?: string[];
} | null | undefined;

export type SeatSummonsResolveInput = {
  isSummons?: boolean;
  resolverActorId?: string | null;
  resolverActorType?: string | null;
  prAuthorActorId?: string | null;
  prAuthorActorType?: string | null;
  creatorAgentId?: string | null;
  creatorUserId?: string | null;
} | null | undefined;

export type SeatSummonsResolveCode =
  | "allow"
  | "author_actor_self_resolve_refused"
  | "creator_self_resolve_refused"
  | "resolver_identity_invalid";

export type SeatSummonsResolveDecision = {
  allowed: boolean;
  code: SeatSummonsResolveCode;
  auditNote: string;
};

function normalizedToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True when the interaction is seat-summons shaped: its kind contains the
 * WORD `seat` or `summons` (word-boundary, so `seating-chart` does not
 * match), or one of its tags contains `seat-summons` / `sable-seat`
 * (case-insensitive). Fail-closed `false` on null/invalid input.
 */
export function isSeatSummonsInteraction(
  interaction: SeatSummonsInteractionInput,
): boolean {
  if (!interaction || typeof interaction !== "object") return false;
  const kind = typeof interaction.kind === "string"
    ? interaction.kind.toLowerCase()
    : "";
  if (/\bseat\b/.test(kind) || /\bsummons\b/.test(kind)) return true;
  if (Array.isArray(interaction.tags)) {
    for (const tag of interaction.tags) {
      if (typeof tag !== "string") continue;
      const lowered = tag.toLowerCase();
      if (
        lowered.includes("seat-summons") || lowered.includes("sable-seat")
      ) return true;
    }
  }
  return false;
}

/**
 * Refuse self-resolution of a seat summons.
 *
 * Actor identities compare as (type, id) PAIRS: the same raw ID under a
 * different actor type is a different actor and never counts as a match in
 * either direction (author or creator). A missing/invalid type on either
 * side of a comparison is fail-closed refuse, never an allow on bare-ID
 * equality.
 *
 * Allow happens ONLY when all of these hold: the resolver identity is a
 * valid (agent|user, id) pair, the PR-author identity is a valid pair the
 * resolver does not match, `isSummons === true` (a false/undefined summons
 * flag refuses), and the summons creator identity for the resolver's side
 * (agent -> creatorAgentId, user -> creatorUserId) is present and unmatched.
 * Every other shape refuses. The `auditNote` always names the reason for
 * the audit log.
 */
export function evaluateSeatSummonsResolve(
  input: SeatSummonsResolveInput,
): SeatSummonsResolveDecision {
  const resolverId = normalizedToken(input?.resolverActorId);
  const resolverType = normalizedToken(input?.resolverActorType)?.toLowerCase();
  if (
    !resolverId || (resolverType !== "agent" && resolverType !== "user")
  ) {
    return {
      allowed: false,
      code: "resolver_identity_invalid",
      auditNote:
        "seat-summons self-resolve refused: resolver actor identity missing or invalid — fail-closed refuse",
    };
  }

  const authorId = normalizedToken(input?.prAuthorActorId);
  const authorType = normalizedToken(input?.prAuthorActorType)?.toLowerCase();
  const authorTypeValid = authorType === "agent" || authorType === "user";
  // Pair equality only: same raw ID under a different type is NOT the author.
  if (
    authorId && authorTypeValid
    && authorType === resolverType && resolverId === authorId
  ) {
    return {
      allowed: false,
      code: "author_actor_self_resolve_refused",
      auditNote:
        `seat-summons author-actor self-resolve refused: resolver ${resolverType}:${resolverId} is the PR author actor`,
    };
  }
  // Missing/invalid author identity: cannot prove non-authorship — refuse.
  if (!authorId || !authorTypeValid) {
    return {
      allowed: false,
      code: "creator_self_resolve_refused",
      auditNote:
        "seat-summons self-resolve refused: PR author actor identity missing or invalid — fail-closed refuse",
    };
  }

  // Only a positively-identified summons can allow; anything else refuses.
  if (input?.isSummons !== true) {
    return {
      allowed: false,
      code: "creator_self_resolve_refused",
      auditNote:
        "seat-summons self-resolve refused: not a positively-identified not_creator summons — fail-closed refuse",
    };
  }

  // The creator identity lives on the resolver's side, so this comparison is
  // pair equality by construction: a same raw ID held only on the other
  // side's creator field never matches.
  const creatorId = resolverType === "agent"
    ? normalizedToken(input?.creatorAgentId)
    : normalizedToken(input?.creatorUserId);
  if (!creatorId) {
    return {
      allowed: false,
      code: "creator_self_resolve_refused",
      auditNote:
        "seat-summons self-resolve refused: summons creator identity missing — fail-closed refuse",
    };
  }
  if (resolverId === creatorId) {
    return {
      allowed: false,
      code: "creator_self_resolve_refused",
      auditNote:
        `seat-summons creator self-resolve refused: resolver ${resolverType}:${resolverId} is the interaction creator under a not_creator summons`,
    };
  }

  return {
    allowed: true,
    code: "allow",
    auditNote:
      `seat-summons resolve allowed: resolver ${resolverType}:${resolverId} is neither PR author ${authorType}:${authorId} nor summons creator ${resolverType}:${creatorId} under a positively-identified not_creator summons`,
  };
}
