/**
 * SPA-11807: a blocked posture may rest on a still-pending thread interaction
 * rather than on a first-class blocker relation. The release paths that decide
 * "this card is ready to move again" read dependency readiness, which only
 * knows about `issueRelations`. An interaction hold is therefore invisible to
 * them, and a card waiting on a human decision gets treated as ready.
 *
 * This predicate is the single shared rule for that case: while a referenced
 * interaction is genuinely pending, nothing may auto-release the hold. It
 * deliberately keys on `pending` and nothing else, so an interaction that has
 * reached any terminal status — including `answered` or `failed`, which may
 * never have woken anyone — releases normally. That is the guard against the
 * opposite failure class (a resolved interaction that fails to release), so
 * widening the hold to any non-terminal status would reintroduce it.
 */
type InteractionHoldStatus = string;

type HoldableInteraction = {
  status: InteractionHoldStatus;
};

export function isAwaitingInteractionResolution<T extends HoldableInteraction>(
  interactions: readonly T[] | null | undefined,
): boolean {
  if (!interactions?.length) return false;
  return interactions.some((interaction) => interaction.status === "pending");
}