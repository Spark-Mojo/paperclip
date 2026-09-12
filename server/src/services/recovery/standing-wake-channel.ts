// SPA-7177: standing wake channels are cards whose correct steady state is to
// stay open, non-terminal, and assigned forever — probe/comment-target cards
// (live case SPA-7170, node05 memory tripwire) whose description carries a
// DO NOT CLOSE wake-channel contract. Closing them silences an early-warning
// channel; `blocked`/`in_review` would be false states. The engine therefore
// honors an explicit opt-in marker in the issue description and treats the
// card as comment-driven: engine-inferred nudges derived from successful runs
// (missing-disposition handoff, productive-terminal continuation requeue) are
// suppressed, while comment wakes, accepted interactions, and failure
// recovery keep working.
//
// Marker contract: a description line of the form
//
//   standing-wake-channel: <channel-id>
//
// Line-anchored, so prose mentioning it cannot opt a card in by accident.
const STANDING_WAKE_CHANNEL_PATTERN = /^\s*standing-wake-channel:[ \t]*\S+.*$/im;

export function isStandingWakeChannelDescription(description: string | null | undefined) {
  return typeof description === "string" && STANDING_WAKE_CHANNEL_PATTERN.test(description);
}

export function isStandingWakeChannelIssue(issue: { description?: string | null } | null | undefined) {
  return isStandingWakeChannelDescription(issue?.description ?? null);
}
