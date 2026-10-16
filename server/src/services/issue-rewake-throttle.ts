/**
 * PAP-13775: throttle no-information issue re-wakes.
 *
 * After a process death (or any stall), external drivers — assignment pollers,
 * stranded-issue reconcilers, on-demand invokes — can re-wake the same agent
 * for the same issue every few seconds for as long as the issue stays
 * `in_progress`. When each of those runs ends without changing any
 * issue-visible state, every wake pays a full adapter session for zero new
 * information (the Phase 4 interruption-recovery smoke paid 25 sessions and
 * 2.4x cost for one recovery this way).
 *
 * This module decides when such a wake should be skipped: once an issue has
 * accumulated a streak of consecutive succeeded-but-no-issue-progress runs by
 * the same agent, further event-free wakes are held back for an escalating
 * cooldown anchored to the last run's finish time. Fresh issue activity, an
 * explicit resume, forceFreshSession, and event-carrying wake reasons bypass
 * the throttle. Human comment wakes also bypass it. Agent-authored comment
 * wakes deliberately stay in the normal throttle class so a cross-issue write
 * cannot smuggle human wake privileges.
 *
 * Server-side recovery retries (process-loss retries, missing-comment
 * follow-ups) insert their runs directly and never pass through this gate, so
 * crash recovery stays immediate; only repeated no-op re-invocations slow
 * down.
 */

/** Consecutive no-progress runs required before the cooldown engages. */
export const ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 2;

/** Cooldown after the threshold streak; doubles per additional no-progress run. */
export const ISSUE_REWAKE_BASE_COOLDOWN_MS = 120_000;

/** Upper bound for the escalating cooldown. */
export const ISSUE_REWAKE_MAX_COOLDOWN_MS = 30 * 60_000;

/** Only runs newer than this feed the streak; older history is ignored. */
export const ISSUE_REWAKE_LOOKBACK_MS = 6 * 60 * 60_000;

/** How many recent terminal runs to sample when computing the streak. */
export const ISSUE_REWAKE_RUN_SAMPLE_LIMIT = 8;

/**
 * Wake reasons that assert issue state rather than deliver a new event.
 * These (plus reason-less on-demand invokes) are the only wakes the throttle
 * applies to; every event-shaped reason (comments, mentions, blockers
 * resolved, interactions, approvals, monitors, reviews, …) passes through.
 */
export const THROTTLED_ISSUE_REWAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_assigned",
  "issue_continuation_needed",
  "issue_assignment_recovery",
  "issue_graph_liveness_backstop",
]);

/**
 * Activity actions that count as issue-visible progress when attributed to a
 * run. Deliberately narrower than run-liveness "concrete action evidence":
 * tool calls inside the workspace do not move the issue, so they do not reset
 * the streak — a run must leave a comment, mutation, document, work product,
 * interaction, or scheduled continuation behind.
 */
export const ISSUE_PROGRESS_ACTIVITY_ACTIONS: string[] = [
  "issue.updated",
  "issue.comment_added",
  "issue.created",
  "issue.child_created",
  "issue.assigned",
  "issue.released",
  "issue.blockers_updated",
  "issue.document_upserted",
  "issue.document_updated",
  "issue.document_deleted",
  "issue.document_restored",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_resolved",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.work_product_deleted",
  "issue.attachment_added",
  "issue.attachment_removed",
  "issue.thread_interaction_created",
  "issue.monitor_scheduled",
  "issue.approval_linked",
];

/**
 * Activity on the issue that counts as new external input since the last run
 * finished — anything a waiting agent should be woken for, including board
 * responses to interactions.
 */
export const ISSUE_NEW_INPUT_ACTIVITY_ACTIONS: string[] = [
  ...ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_item_verdicts_submitted",
  "issue.blockers_resolved_wake_emitted",
];

export interface IssueRewakeCandidateInput {
  reason: string | null;
  wakeCommentId: string | null;
  requestedByActorType?: "user" | "agent" | "system" | null;
  forceFreshSession: boolean;
  hasExplicitResume: boolean;
}

const NO_EXTRA_ISSUE_REWAKE_REASONS: ReadonlySet<string> = new Set();

/**
 * Whether a wake is even a candidate for throttling. Wakes that carry new
 * information or an explicit operator escalation always pass.
 *
 * `extraReasons` lets a caller widen candidacy for a specific downstream
 * decision without changing the shared cooldown throttle's own reason set —
 * the circuit breaker uses this to also gate `finish_successful_run_handoff`
 * (audit finding, PR #211) while every other caller keeps the original
 * THROTTLED_ISSUE_REWAKE_REASONS-only behavior unchanged.
 */
export function isThrottleCandidateIssueRewake(
  input: IssueRewakeCandidateInput,
  extraReasons: ReadonlySet<string> = NO_EXTRA_ISSUE_REWAKE_REASONS,
): boolean {
  if (input.forceFreshSession) return false;
  // Explicit resume is an operator privilege, not an actor-class escape hatch.
  // Agent-authored resume comments remain subject to the normal rewake throttle.
  if (input.hasExplicitResume && input.requestedByActorType !== "agent") return false;
  if (input.wakeCommentId) return input.requestedByActorType === "agent";
  if (input.reason === null) return true;
  return THROTTLED_ISSUE_REWAKE_REASONS.has(input.reason) || extraReasons.has(input.reason);
}

export interface RecentIssueRunSample {
  id: string;
  status: string;
  finishedAt: Date | null;
}

export interface IssueRewakeThrottleInput {
  now: Date;
  /** Terminal runs for the same (agent, issue), newest finish first. */
  recentTerminalRuns: RecentIssueRunSample[];
  /** Runs among the sample that produced issue-visible progress. */
  runIdsWithIssueProgress: ReadonlySet<string>;
  /** New issue input landed after the newest run finished. */
  hasNewIssueInputSinceLastRun: boolean;
}

export type IssueRewakeThrottleDecision =
  | { blocked: false; noProgressStreak: number }
  | {
      blocked: true;
      noProgressStreak: number;
      cooldownMs: number;
      lastRunFinishedAt: Date;
      nextAllowedAt: Date;
    };

export function computeIssueRewakeCooldownMs(noProgressStreak: number): number {
  const doublings = Math.max(0, noProgressStreak - ISSUE_REWAKE_NO_PROGRESS_THRESHOLD);
  // Guard the exponent so an absurd streak can't overflow into Infinity.
  const factor = 2 ** Math.min(doublings, 16);
  return Math.min(ISSUE_REWAKE_BASE_COOLDOWN_MS * factor, ISSUE_REWAKE_MAX_COOLDOWN_MS);
}

/**
 * PAP-13775 follow-up: the escalating cooldown above slows a no-progress loop
 * but never stops it — it caps at ISSUE_REWAKE_MAX_COOLDOWN_MS and keeps
 * re-admitting forever (measured 10-16: SPA-12493 ran ~120 times). This is
 * the permanent circuit breaker on top of the same streak computation: once
 * a card's last N consecutive terminal runs for the same agent all landed
 * with no issue-visible progress, the engine stops scheduling further
 * continuation/handoff wakes for it entirely rather than just slowing them
 * down. The caller is responsible for actually moving the card to `backlog`
 * and posting the one-time notice; this module only decides whether that
 * should happen.
 */
export const ISSUE_REWAKE_CIRCUIT_BREAKER_THRESHOLD_ENV_VAR =
  "PAPERCLIP_ISSUE_REWAKE_CIRCUIT_BREAKER_THRESHOLD";

/** Matches the default asked for: 3 consecutive no-progress runs trips it. */
export const ISSUE_REWAKE_CIRCUIT_BREAKER_DEFAULT_THRESHOLD = 3;

// A 1-run breaker would trip on ordinary variance (a single slow or
// ambiguous run is not a loop); a cap keeps a misconfigured env var from
// disabling the breaker in all practical terms.
const ISSUE_REWAKE_CIRCUIT_BREAKER_MIN_THRESHOLD = 2;
const ISSUE_REWAKE_CIRCUIT_BREAKER_MAX_THRESHOLD = 20;

export function normalizeIssueRewakeCircuitBreakerThreshold(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(parsed)) return ISSUE_REWAKE_CIRCUIT_BREAKER_DEFAULT_THRESHOLD;
  return Math.max(
    ISSUE_REWAKE_CIRCUIT_BREAKER_MIN_THRESHOLD,
    Math.min(ISSUE_REWAKE_CIRCUIT_BREAKER_MAX_THRESHOLD, Math.floor(parsed)),
  );
}

export const ISSUE_REWAKE_CIRCUIT_BREAKER_TRIPPED_REASON =
  "issue_rewake_circuit_breaker_tripped";

/** Fixed prefix of the one-time card comment; used to dedupe the notice. */
export const ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX =
  "Paperclip stopped automatic re-wakes for this card";

/**
 * Pure trip decision. Deliberately conservative: a card owned by a human —
 * assigned directly (`assigneeUserId`) or holding the conversation seat
 * (`conversationUserId`, audit finding #3, PR #211) — never trips. A false
 * trip strands real work, a miss only costs tokens. The streak itself
 * already excludes failed/cancelled runs (evaluateIssueRewakeThrottle breaks
 * the streak there) and resets on new issue input, so this only needs the
 * human-ownership guard; the delegation veto below is a second, independent
 * guard the caller applies before actually tripping.
 */
export function shouldTripIssueRewakeCircuitBreaker(input: {
  noProgressStreak: number;
  threshold: number;
  isHumanOwned: boolean;
}): boolean {
  if (input.isHumanOwned) return false;
  return input.noProgressStreak >= input.threshold;
}

export interface BreakerSampledRun {
  id: string;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * Audit finding #2 (PR #211): the primary progress check only looks at
 * activity logged directly against THIS issue under one of this agent's own
 * sampled run ids, so a delegated child issue (a fan-out worker doing real
 * work) or a subagent's comment/activity on this same issue under its own
 * run id is invisible to it — a parent that is genuinely delegating looks
 * identical to one that is stuck.
 *
 * This resolves the time window the caller should search across both of
 * those evidence shapes in: the union of the counted no-progress runs' own
 * windows, from the earliest counted run's start through now. Veto-only
 * logic lives in the caller (it needs a DB read); this function only
 * decides the window, so a wider window can only make the breaker MORE
 * reluctant to trip, never the opposite.
 */
export function resolveBreakerExtraProgressWindowStart(input: {
  recentTerminalRuns: BreakerSampledRun[];
  noProgressStreak: number;
}): Date | null {
  const counted = input.recentTerminalRuns.slice(0, input.noProgressStreak);
  const starts = counted
    .map((run) => run.startedAt ?? run.finishedAt)
    .filter((value): value is Date => value instanceof Date);
  if (starts.length === 0) return null;
  return new Date(Math.min(...starts.map((date) => date.getTime())));
}

/**
 * Per-trip marker embedded as the first line of the notice. Keying dedup on
 * this (instead of the bare, forever-global prefix — audit finding #4, PR
 * #211) means a concurrent duplicate evaluation of the SAME streak (same
 * newest counted run) still posts exactly one comment, while a genuinely
 * later trip (a different streak, so a different newest run id) posts a
 * fresh one instead of silently no-op'ing forever after the first trip ever
 * recorded on this card.
 */
export function issueRewakeCircuitBreakerNoticeMarker(newestRunId: string): string {
  return `${ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX} (run ${newestRunId})`;
}

export function buildIssueRewakeCircuitBreakerNotice(input: {
  noProgressStreak: number;
  /** Run ids counted toward the streak, newest first. */
  runIds: string[];
}): string {
  const newestRunId = input.runIds[0] ?? "unknown";
  const runList = input.runIds.map((id) => `\`${id}\``).join(", ") || "(none)";
  return [
    issueRewakeCircuitBreakerNoticeMarker(newestRunId),
    `The last ${input.noProgressStreak} consecutive runs ended with no issue-visible progress (issue status unchanged, no new comment, no new work product, no delegated child-issue activity).`,
    `Runs counted toward this streak, newest first: ${runList}.`,
    "This card was moved to `backlog` so it stops consuming runs for no new information.",
    "To resume automatic work: move the card back to `todo` (or reassign it). Either change counts as new progress and resets this breaker.",
  ].join("\n\n");
}

export function evaluateIssueRewakeThrottle(input: IssueRewakeThrottleInput): IssueRewakeThrottleDecision {
  const runs = input.recentTerminalRuns;
  if (runs.length === 0) return { blocked: false, noProgressStreak: 0 };
  if (input.hasNewIssueInputSinceLastRun) return { blocked: false, noProgressStreak: 0 };

  let noProgressStreak = 0;
  for (const run of runs) {
    // A failed/cancelled/interrupted run breaks the streak: its follow-up is
    // recovery, not a redundant re-poll, and must not be delayed.
    if (run.status !== "succeeded" || !run.finishedAt) break;
    if (input.runIdsWithIssueProgress.has(run.id)) break;
    noProgressStreak += 1;
  }

  if (noProgressStreak < ISSUE_REWAKE_NO_PROGRESS_THRESHOLD) {
    return { blocked: false, noProgressStreak };
  }

  const lastRunFinishedAt = runs[0]?.finishedAt;
  if (!lastRunFinishedAt) return { blocked: false, noProgressStreak };

  const cooldownMs = computeIssueRewakeCooldownMs(noProgressStreak);
  const nextAllowedAt = new Date(lastRunFinishedAt.getTime() + cooldownMs);
  if (input.now.getTime() < nextAllowedAt.getTime()) {
    return { blocked: true, noProgressStreak, cooldownMs, lastRunFinishedAt, nextAllowedAt };
  }
  return { blocked: false, noProgressStreak };
}
