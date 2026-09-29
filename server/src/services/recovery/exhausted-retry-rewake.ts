/**
 * SPA-9351 shape 1: bounded re-wake for cards stranded by an exhausted retry.
 *
 * The stranded sweep already understands "the continuation retried and still
 * failed" — but only for the `issue_continuation_needed` retry reason. A card
 * whose retries were exhausted by the heartbeat's *bounded transient* lane
 * (`contextSnapshot.retryReason === "transient_failure"`,
 * `BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON` in heartbeat.ts) is structurally
 * invisible to that branch, and so is it to
 * `summarizeRecentContinuationRetries`, which hard-breaks on any other reason.
 * Such a card falls through the entire continuation chain into
 * `enqueueStrandedIssueRecovery`, which routes a terminal-failed predecessor
 * back to `scheduleRecoveryRetry` — which the heartbeat scheduler refuses
 * because the bounded budget is already spent. Nothing re-wakes the card and it
 * sits with no run, no pending wake and no open blocker indefinitely.
 *
 * This module is the pure decision half of the repair. The sweep supplies the
 * facts it cannot cheaply derive itself; the decision is deliberately a pure
 * function so every guard is unit-testable without a database.
 *
 * Two properties matter more than the trigger itself:
 *
 *  1. The budget is scoped to a *failure episode*, never to `issueId +
 *     errorCode`. `adapter_failed` is a broad code; a lifetime key would
 *     permanently suppress recovery from unrelated future incidents on the same
 *     card. The episode is anchored on the exhausted run, so a later distinct
 *     failure gets a fresh budget, and progress demonstrably ends the episode.
 *
 *  2. The re-wake must not be re-submitted to the exhausted retry scheduler.
 *     The caller enqueues directly with no `retryOfRunId`; see the
 *     `EXHAUSTED_RETRY_REWAKE_WAKE_REASON` note on `enqueueExhaustedRetryRewake`.
 */

/**
 * `heartbeat.ts` writes this into `contextSnapshot.retryReason` when it parks a
 * run on the bounded transient retry lane. A card can only be stranded by
 * *exhaustion* of that lane if its latest run carries this reason — which is
 * precisely the value the `issue_continuation_needed` branch excludes.
 */
export const BOUNDED_TRANSIENT_RETRY_REASON = "transient_failure";

export const EXHAUSTED_RETRY_REWAKE_WAKE_REASON = "issue_exhausted_retry_rewake";
export const EXHAUSTED_RETRY_REWAKE_SOURCE = "issue.exhausted_retry_rewake";
export const EXHAUSTED_RETRY_REWAKE_EPISODE_EVIDENCE_KEY = "exhaustedRetryRewakeEpisode";

/** Read at call time, never at module load: tests set the env after import. */
function exhaustedRetryRewakeDelayMs() {
  return Math.max(
    60_000,
    Number(process.env.STRANDED_EXHAUSTED_RETRY_REWAKE_DELAY_MS) ||
      DEFAULT_STRANDED_EXHAUSTED_RETRY_REWAKE_DELAY_MS,
  );
}

/** Default: 30 minutes — long enough for a transient infra failure to clear. */
export const DEFAULT_STRANDED_EXHAUSTED_RETRY_REWAKE_DELAY_MS = 30 * 60 * 1000;

/** One re-wake per episode. A second re-wake would be an unbounded loop. */
export const EXHAUSTED_RETRY_REWAKE_MAX_ATTEMPTS = 1;

export type ExhaustedRetryEpisodeFacts = {
  /** Retry reason recorded on the exhausted run's context snapshot. */
  retryReason: string | null;
  errorCode: string | null;
  /**
   * `classifyContinuationFailure(latestRun).kind`. Only a retryable kind is
   * eligible; `non_retryable` keeps its existing escalate-to-`blocked` path.
   */
  classificationKind:
    | "transient_infra"
    | "non_retryable"
    | "deliberate_wait_without_target"
    | "default";
  /** True when the lane's own attempts are spent (no automatic retry remains). */
  retryBudgetExhausted: boolean;
  /** `finishedAt` of the newest run in the episode, if recorded. */
  latestFinishedAt: Date | null;
  /** Re-wakes already spent on this episode. */
  episodeRewakeCount: number;
  /** An already-active recovery action has consumed its budget. */
  recoveryBudgetExhausted: boolean;
  hasLiveExecutionPath: boolean;
  hasQueuedWake: boolean;
  hasOpenBlocker: boolean;
  hasPendingInteraction: boolean;
  isInvocationBudgetBlocked: boolean;
  isSuppressedByPauseHold: boolean;
  issueStatus: string;
  hasAgentAssignee: boolean;
  now?: Date;
};

export type ExhaustedRetryRewakeDecision =
  | { kind: "rewake"; delayMs: number }
  | { kind: "suppressed"; reason: ExhaustedRetryRewakeSuppressReason };

export type ExhaustedRetryRewakeSuppressReason =
  | "not_bounded_transient_episode"
  | "not_retryable"
  | "retry_budget_remaining"
  | "episode_already_rewoken"
  | "recovery_budget_exhausted"
  | "live_execution_path"
  | "queued_wake"
  | "open_blocker"
  | "pending_interaction"
  | "invocation_budget_blocked"
  | "pause_hold"
  | "issue_not_assignable"
  | "delay_not_elapsed";

const REWAKABLE_ISSUE_STATUSES = new Set(["todo", "in_progress"]);

const NON_RETRYABLE_KINDS = new Set(["non_retryable"]);

/**
 * Decide whether an exhausted-retry episode earns its single bounded re-wake.
 *
 * Order is deliberate: cheap, purely-decidable guards first, so a suppression
 * reason is the *most specific* true statement about the card rather than the
 * first one the caller happened to test.
 */
export function decideExhaustedRetryRewake(
  facts: ExhaustedRetryEpisodeFacts,
): ExhaustedRetryRewakeDecision {
  if (facts.retryReason !== BOUNDED_TRANSIENT_RETRY_REASON) {
    return { kind: "suppressed", reason: "not_bounded_transient_episode" };
  }
  // A non-retryable failure must never be silently re-woken: it is escalated
  // to `blocked` so a human sees it.
  if (NON_RETRYABLE_KINDS.has(facts.classificationKind)) {
    return { kind: "suppressed", reason: "not_retryable" };
  }
  if (!facts.retryBudgetExhausted) {
    return { kind: "suppressed", reason: "retry_budget_remaining" };
  }
  if (facts.episodeRewakeCount >= EXHAUSTED_RETRY_REWAKE_MAX_ATTEMPTS) {
    return { kind: "suppressed", reason: "episode_already_rewoken" };
  }
  if (facts.recoveryBudgetExhausted) {
    return { kind: "suppressed", reason: "recovery_budget_exhausted" };
  }
  if (!facts.hasAgentAssignee || !REWAKABLE_ISSUE_STATUSES.has(facts.issueStatus)) {
    return { kind: "suppressed", reason: "issue_not_assignable" };
  }
  if (facts.hasLiveExecutionPath) {
    return { kind: "suppressed", reason: "live_execution_path" };
  }
  if (facts.hasQueuedWake) {
    return { kind: "suppressed", reason: "queued_wake" };
  }
  if (facts.hasOpenBlocker) {
    return { kind: "suppressed", reason: "open_blocker" };
  }
  if (facts.hasPendingInteraction) {
    return { kind: "suppressed", reason: "pending_interaction" };
  }
  if (facts.isInvocationBudgetBlocked) {
    return { kind: "suppressed", reason: "invocation_budget_blocked" };
  }
  if (facts.isSuppressedByPauseHold) {
    return { kind: "suppressed", reason: "pause_hold" };
  }

  const now = facts.now ?? new Date();
  const delayMs = exhaustedRetryRewakeDelayMs();
  // A run with no recorded finish cannot anchor a delay. Treating that as
  // "zero elapsed" would make the backstop fire immediately on a run that may
  // still be tearing down, so wait out a full delay instead.
  if (!facts.latestFinishedAt) {
    return { kind: "suppressed", reason: "delay_not_elapsed" };
  }
  if (now.getTime() - facts.latestFinishedAt.getTime() < delayMs) {
    return { kind: "suppressed", reason: "delay_not_elapsed" };
  }

  return { kind: "rewake", delayMs };
}

/**
 * Identity of a failure *episode*.
 *
 * Anchored on the exhausted run's id rather than on `errorCode`, so a card
 * that fails again later gets a fresh budget while a re-sweep of the same
 * failure does not. This is the key that makes the repair bounded without
 * making it one-shot-per-card-forever.
 */
export function buildExhaustedRetryRewakeEpisodeKey(input: {
  companyId: string;
  issueId: string;
  exhaustedRunId: string;
}) {
  return [
    "exhausted_retry_rewake",
    input.companyId,
    input.issueId,
    input.exhaustedRunId,
  ].join(":");
}

/**
 * Stable idempotency key for the episode's single re-wake. The insert is the
 * budget: two concurrent sweeps race on the partial unique index behind
 * `agent_wakeup_requests.idempotency_key` and exactly one wins.
 */
export function buildExhaustedRetryRewakeIdempotencyKey(input: {
  companyId: string;
  issueId: string;
  episodeKey: string;
}) {
  return `${input.episodeKey}:rewake`;
}

/**
 * Persisted on the wake's recovery context so a later sweep can read the
 * episode's re-wake count back without a separate query.
 */
export function exhaustedRetryRewakeEpisodeContext(input: {
  episodeKey: string;
  exhaustedRunId: string;
  errorCode: string | null;
}) {
  return {
    [EXHAUSTED_RETRY_REWAKE_EPISODE_EVIDENCE_KEY]: {
      episodeKey: input.episodeKey,
      exhaustedRunId: input.exhaustedRunId,
      errorCode: input.errorCode,
    },
  };
}

/** Read the episode marker back off a wake/run context snapshot. */
export function readExhaustedRetryRewakeEpisode(
  context: unknown,
): { episodeKey: string; exhaustedRunId: string; errorCode: string | null } | null {
  const record = parseRecord(context);
  const marker = parseRecord(
    record[EXHAUSTED_RETRY_REWAKE_EPISODE_EVIDENCE_KEY],
  );
  if (!marker) return null;
  const episodeKey = readNonEmptyString(marker.episodeKey);
  const exhaustedRunId = readNonEmptyString(marker.exhaustedRunId);
  if (!episodeKey || !exhaustedRunId) return null;
  return {
    episodeKey,
    exhaustedRunId,
    errorCode: readNonEmptyString(marker.errorCode),
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export const ORPHANED_RETRY_REWAKE_WAKE_REASON = "issue_orphaned_retry_redispatch";
export const ORPHANED_RETRY_REWAKE_SOURCE = "issue.orphaned_retry_redispatch";
export const ORPHANED_RETRY_REWAKE_EPISODE_EVIDENCE_KEY = "orphanedRetryRedispatchEpisode";
export const ORPHANED_RETRY_REWAKE_MAX_ATTEMPTS = 1;
export const EXHAUSTED_RETRY_REWAKE_ISSUE_STATUSES = ["todo", "in_progress"] as const;
export const ORPHANED_RETRY_RUN_ERROR_CODE = "orphaned_running_run";

export function isOrphanedRetryRun(run: {
  status: string | null;
  errorCode: string | null;
}) {
  return run.status === "interrupted" && run.errorCode === ORPHANED_RETRY_RUN_ERROR_CODE;
}

export type OrphanedRetryFacts = {
  runStatus: string | null;
  runErrorCode: string | null;
  latestFinishedAt: Date | null;
  episodeRewakeCount: number;
  recoveryBudgetExhausted: boolean;
  hasNewerRun: boolean;
  exhaustedRetryBudgetSpent: boolean;
  hasLiveExecutionPath: boolean;
  hasQueuedWake: boolean;
  hasOpenBlocker: boolean;
  hasPendingInteraction: boolean;
  isInvocationBudgetBlocked: boolean;
  isSuppressedByPauseHold: boolean;
  issueStatus: string;
  hasAgentAssignee: boolean;
  now?: Date;
};

export type OrphanedRetryRewakeDecision =
  | { kind: "redispatch"; delayMs: number }
  | { kind: "suppressed"; reason: OrphanedRetryRewakeSuppressReason };

export type OrphanedRetryRewakeSuppressReason =
  | "not_orphaned_retry_run"
  | "newer_run_exists"
  | "exhausted_retry_budget_spent"
  | "episode_already_redispatched"
  | "recovery_budget_exhausted"
  | "issue_not_assignable"
  | "live_execution_path"
  | "queued_wake"
  | "open_blocker"
  | "pending_interaction"
  | "invocation_budget_blocked"
  | "pause_hold"
  | "delay_not_elapsed";

export function decideOrphanedRetryRewake(
  facts: OrphanedRetryFacts,
): OrphanedRetryRewakeDecision {
  if (!isOrphanedRetryRun({ status: facts.runStatus, errorCode: facts.runErrorCode })) {
    return { kind: "suppressed", reason: "not_orphaned_retry_run" };
  }
  if (facts.hasNewerRun) {
    return { kind: "suppressed", reason: "newer_run_exists" };
  }
  if (facts.exhaustedRetryBudgetSpent) {
    return { kind: "suppressed", reason: "exhausted_retry_budget_spent" };
  }
  if (facts.episodeRewakeCount >= ORPHANED_RETRY_REWAKE_MAX_ATTEMPTS) {
    return { kind: "suppressed", reason: "episode_already_redispatched" };
  }
  if (facts.recoveryBudgetExhausted) {
    return { kind: "suppressed", reason: "recovery_budget_exhausted" };
  }
  if (!facts.hasAgentAssignee || !REWAKABLE_ISSUE_STATUSES.has(facts.issueStatus)) {
    return { kind: "suppressed", reason: "issue_not_assignable" };
  }
  if (facts.hasLiveExecutionPath) {
    return { kind: "suppressed", reason: "live_execution_path" };
  }
  if (facts.hasQueuedWake) {
    return { kind: "suppressed", reason: "queued_wake" };
  }
  if (facts.hasOpenBlocker) {
    return { kind: "suppressed", reason: "open_blocker" };
  }
  if (facts.hasPendingInteraction) {
    return { kind: "suppressed", reason: "pending_interaction" };
  }
  if (facts.isInvocationBudgetBlocked) {
    return { kind: "suppressed", reason: "invocation_budget_blocked" };
  }
  if (facts.isSuppressedByPauseHold) {
    return { kind: "suppressed", reason: "pause_hold" };
  }
  if (!facts.latestFinishedAt) {
    return { kind: "suppressed", reason: "delay_not_elapsed" };
  }
  const now = facts.now ?? new Date();
  if (now.getTime() - facts.latestFinishedAt.getTime() < exhaustedRetryRewakeDelayMs()) {
    return { kind: "suppressed", reason: "delay_not_elapsed" };
  }
  return { kind: "redispatch", delayMs: exhaustedRetryRewakeDelayMs() };
}

export function buildOrphanedRetryRewakeEpisodeKey(input: {
  companyId: string;
  issueId: string;
  rootRunId: string;
}) {
  return ["orphaned_retry_rewake", input.companyId, input.issueId, input.rootRunId].join(":");
}

export function buildOrphanedRetryRewakeIdempotencyKey(input: {
  companyId: string;
  issueId: string;
  episodeKey: string;
}) {
  return `${input.episodeKey}:redispatch`;
}

export function orphanedRetryRewakeReplacementContext(input: {
  episodeKey: string;
  orphanRunId: string;
  rootRunId: string;
  previousOrphanRunId?: string | null;
}) {
  return {
    [ORPHANED_RETRY_REWAKE_EPISODE_EVIDENCE_KEY]: {
      episodeKey: input.episodeKey,
      orphanRunId: input.orphanRunId,
      rootRunId: input.rootRunId,
      previousOrphanRunId: input.previousOrphanRunId ?? null,
    },
  };
}

export function orphanedRetryRewakeEpisodeContext(context: unknown) {
  const episode = readOrphanedRetryRewakeEpisode(context);
  if (!episode) return {};
  return orphanedRetryRewakeReplacementContext(episode);
}

export function readOrphanedRetryRewakeEpisode(
  context: unknown,
): {
  episodeKey: string;
  orphanRunId: string;
  rootRunId: string;
  previousOrphanRunId: string | null;
} | null {
  const marker = parseRecord(parseRecord(context)[ORPHANED_RETRY_REWAKE_EPISODE_EVIDENCE_KEY]);
  if (!marker) return null;
  const episodeKey = readNonEmptyString(marker.episodeKey);
  const orphanRunId = readNonEmptyString(marker.orphanRunId);
  const rootRunId = readNonEmptyString(marker.rootRunId);
  if (!episodeKey || !orphanRunId || !rootRunId) return null;
  return {
    episodeKey,
    orphanRunId,
    rootRunId,
    previousOrphanRunId: readNonEmptyString(marker.previousOrphanRunId),
  };
}
