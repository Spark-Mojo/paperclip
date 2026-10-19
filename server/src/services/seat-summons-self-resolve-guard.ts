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

import { z } from "zod";

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
 * Summons payload contract (SPA-13735 d10). The PR-author actor identity is
 * carried inside the interaction `payload` jsonb, as are the summons marker
 * tags. There is no seat-summons kind in hydrateInteraction's registry and
 * no `tags` column on the row, so there is no strict per-kind schema to
 * extend yet — the accessors below read `payload` field-by-field tolerantly
 * (tags and author pair parsed INDEPENDENTLY, so a malformed author field
 * can never un-detect the summons). No DB columns/migrations. d11 owns the
 * creation path (kind registration + strict schema, which must preserve
 * these fields: merge/extend this extension, or `.catchall` it, otherwise
 * strict parsing strips the author fields and the route fail-closes again).
 */
export const seatSummonsPayloadExtensionSchema = z.object({
  prAuthorActorId: z.string().trim().min(1).max(255).nullable().optional(),
  prAuthorActorType: z.string().trim().min(1).max(64).nullable().optional(),
  /**
   * Summons marker tags carried in payload jsonb. There is NO `tags`
   * column on the row and no seat-summons kind in the service/shared
   * registry, so `isSeatSummonsInteraction` cannot read top-level tags —
   * see `isSeatSummonsHydratedInteraction` below.
   */
  tags: z.array(z.string()).optional(),
});

export type SeatSummonsPayloadExtension = z.infer<
  typeof seatSummonsPayloadExtensionSchema
>;

export type SeatSummonsAuthorPair = {
  prAuthorActorId: string;
  prAuthorActorType: string;
} | null;

/**
 * Tolerant tag reader for the payload-carried summons markers. Independent
 * from the author-pair read below: a malformed author field must NEVER
 * un-detect the summons (shared-parse fail-open). Accepts `payload.tags` as
 * an array (non-string elements ignored) or a bare string; non-object
 * payload (or missing/non-string-array tags) yields undefined, never throws.
 */
function readSeatSummonsTags(payload: unknown): string[] | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const tags = (payload as { tags?: unknown }).tags;
  if (typeof tags === "string") return [tags];
  if (Array.isArray(tags)) {
    const out: string[] = [];
    for (const tag of tags) {
      if (typeof tag === "string") out.push(tag);
    }
    return out;
  }
  return undefined;
}

/**
 * Typed summons-shape check over a HYDRATED interaction: kind from the row
 * plus marker tags carried in the payload jsonb. The route's previous
 * `(current as { tags?: string[] }).tags` read was always undefined (no
 * `tags` column exists) — tags must come from `payload.tags` via the
 * tolerant reader above, independent of the author-pair parse.
 */
export function isSeatSummonsHydratedInteraction(
  interaction: { kind?: string; payload?: unknown } | null | undefined,
): boolean {
  if (!interaction || typeof interaction !== "object") return false;
  return isSeatSummonsInteraction({
    kind: interaction.kind,
    tags: readSeatSummonsTags(interaction.payload),
  });
}

/**
 * Typed accessor for the PR-author actor pair on a hydrated interaction.
 * Reads `interaction.payload` only (never top-level row fields), parsed
 * INDEPENDENTLY from the tag read above. Returns the pair when BOTH fields
 * are non-empty trimmed strings, else null (fail-closed: the route's
 * `evaluateSeatSummonsResolve` call then refuses). Malformed identity never
 * un-detects the summons — this parse touches tags not at all.
 */
export function getSeatSummonsAuthor(
  interaction: { payload?: unknown } | null | undefined,
): SeatSummonsAuthorPair {
  if (!interaction || typeof interaction !== "object") return null;
  const payload = interaction.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as {
    prAuthorActorId?: unknown;
    prAuthorActorType?: unknown;
  };
  const authorId = typeof raw.prAuthorActorId === "string"
    ? raw.prAuthorActorId.trim()
    : "";
  const authorType = typeof raw.prAuthorActorType === "string"
    ? raw.prAuthorActorType.trim()
    : "";
  if (!authorId || !authorType) return null;
  return { prAuthorActorId: authorId, prAuthorActorType: authorType };
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
