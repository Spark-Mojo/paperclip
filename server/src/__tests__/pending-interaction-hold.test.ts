import { describe, expect, it } from "vitest";
import { isAwaitingInteractionResolution } from "../services/pending-interaction-hold.js";

// SPA-11807: a blocked posture whose unblocking action is a still-pending thread
// interaction must not be released automatically. Only a genuinely pending
// interaction holds; a terminal one must never, or the card would be stuck
// forever (the opposite failure class, #1213 / SPA-10513 item 2).
describe("isAwaitingInteractionResolution", () => {
  const pendingInteraction = { id: "interaction-1", status: "pending" as const };

  it("holds while the interaction is still pending", () => {
    expect(isAwaitingInteractionResolution([pendingInteraction])).toBe(true);
  });

  // Every terminal status must release the hold, not just a subset: an
  // `answered` or `failed` interaction that never woke anyone must still be
  // releasable by hand, or the card is stranded forever.
  it.each(["accepted", "rejected", "answered", "cancelled", "expired", "failed"] as const)(
    "does not hold once the interaction is %s",
    (status) => {
      expect(
        isAwaitingInteractionResolution([{ id: "interaction-1", status }]),
      ).toBe(false);
    },
  );

  it("does not hold when there are no interactions at all", () => {
    expect(isAwaitingInteractionResolution([])).toBe(false);
    expect(isAwaitingInteractionResolution(undefined)).toBe(false);
  });

  it("holds when any one of several interactions is still pending", () => {
    expect(
      isAwaitingInteractionResolution([
        { id: "interaction-1", status: "accepted" },
        pendingInteraction,
      ]),
    ).toBe(true);
  });
});