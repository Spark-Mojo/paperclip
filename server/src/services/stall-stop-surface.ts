/**
 * Stop-and-surface guard for repeated model-stream stalls.
 *
 * When the same issue's runs fail terminally with error_code
 * `model_stream_stalled` N times in a row, the engine stops scheduling
 * further automatic runs for it, moves the card to `blocked`, and posts a
 * single board-visible note (deduped per stall episode on
 * stallStopNoticeMarker(newestRunId)). Only an
 * explicit human unblock resumes automatic work; bare board comments do not
 * re-arm. Server-side recovery retries bypass this module entirely — the
 * caller wires that, so this module never gates recovery.
 *
 * Pure decision logic only: no DB, no heartbeat imports. Mirrors the
 * issue-rewake-throttle.ts style (exported consts + pure functions).
 */

/** Run-level error_code that feeds this guard (byte-exact match). */
export const STALL_STOP_ERROR_CODE = "model_stream_stalled";

/** Consecutive same-code terminal failures required before stop-and-surface. */
export const STALL_STOP_THRESHOLD = 3;

/**
 * First-line prefix of the board-visible note; callers use the per-episode
 * marker from stallStopNoticeMarker as the dedup key so a genuinely later
 * streak (different newest run id) posts a fresh note while a concurrent
 * duplicate of the same streak still dedups.
 */
export const STALL_STOP_SURFACE_MARKER = "stop-and-surface:model_stream_stalled";

/**
 * Per-stall-episode marker embedded as the first line of the notice. Keying
 * dedup on this (instead of the bare, forever-global prefix) means a
 * concurrent duplicate evaluation of the SAME streak (same newest counted
 * run) still posts exactly one comment, while a genuinely later streak (a
 * different newest run id) posts a fresh one. Mirrors
 * issueRewakeCircuitBreakerNoticeMarker.
 */
export function stallStopNoticeMarker(newestRunId: string): string {
  return `${STALL_STOP_SURFACE_MARKER} (run ${newestRunId})`;
}

/** agentWakeupRequests reason recorded when the stop first trips (R3). */
export const STALL_STOP_SURFACE_TRIPPED_REASON = "stall_stop_surface_tripped";

/** agentWakeupRequests reason recorded while a tripped stop holds (R4). */
export const STALL_STOP_SURFACE_HELD_REASON = "stall_stop_surface_held";

/** Named unblock actions (actorType must be "user"). `status_changed` and
 * `issue.updated` are NOT listed here: they are direction-checked in
 * isExplicitHumanUnblock (only a user move FROM `blocked` TO a non-blocked
 * status counts). `issue.updated` is the real logged action for a status
 * move (see routes/issues.ts); `status_changed` is kept as a harmless alias. */
export const STALL_STOP_UNBLOCK_ACTIONS: ReadonlySet<string> = new Set([
  "issue.unblocked",
  "issue_unblocked",
  "unblock",
]);

/** Terminal runs for the same issue, newest first. */
export interface StallStopRunSample {
  id: string;
  status: string;
  errorCode: string | null;
}

/**
 * Count the leading streak of runs with status === "failed" and a
 * byte-exact STALL_STOP_ERROR_CODE errorCode. Stops at the first run that
 * is not (success, different error_code, null error_code, cancelled,
 * timed_out, anything else). No wall-clock window: only order matters.
 */
export function countStallStreak(runs: StallStopRunSample[]): {
  streak: number;
  runIds: string[];
} {
  const runIds: string[] = [];
  for (const run of runs) {
    if (run.status !== "failed" || run.errorCode !== STALL_STOP_ERROR_CODE) break;
    runIds.push(run.id);
  }
  return { streak: runIds.length, runIds };
}

/** True once the streak reaches the stop-and-surface threshold. */
export function shouldStopSurface(streak: number): boolean {
  return streak >= STALL_STOP_THRESHOLD;
}

/**
 * Board-visible note for one stall episode. Precondition: runIds holds the
 * counted streak (newest first); when empty the count falls back to
 * STALL_STOP_THRESHOLD and the run list renders as `(none)`. The
 * per-episode marker stallStopNoticeMarker(newest) is always the first line.
 */
export function buildStallStopNotice(runIds: string[]): string {
  const count = runIds.length > 0 ? runIds.length : STALL_STOP_THRESHOLD;
  const newestRunId = runIds[0] ?? "unknown";
  const runList = runIds.map((id) => `\`${id}\``).join(", ") || "(none)";
  return [
    stallStopNoticeMarker(newestRunId),
    `The last ${count} consecutive runs failed with error code \`${STALL_STOP_ERROR_CODE}\` and no automatic recovery succeeded.`,
    `Runs counted toward this streak, newest first: ${runList}.`,
    "This card was moved to `blocked` so it stops consuming runs on a stalled model stream.",
    "A bare board comment does not re-arm automatic work; only an explicit human unblock (a user moving the card off `blocked`, or the named unblock action) resumes it.",
  ].join("\n\n");
}

/**
 * True only for a human ("user") actor performing a status-change-off-blocked
 * or the named unblock action. Bare board comments (`comment_added` by any
 * actor) and all system/agent actions return false. A status-change move
 * (`issue.updated`, the real logged action for a status move, or the
 * `status_changed` alias) INTO `blocked`, `blocked`->`blocked`, or one with
 * missing from/to returns false — only a user move FROM `blocked` TO a
 * non-blocked status re-arms.
 */
export function isExplicitHumanUnblock(input: {
  actorType: string | null;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
}): boolean {
  if (input.actorType !== "user") return false;
  if (input.action === "status_changed" || input.action === "issue.updated") {
    if (input.fromStatus !== "blocked") return false;
    if (!input.toStatus || input.toStatus === "blocked") return false;
    return true;
  }
  return STALL_STOP_UNBLOCK_ACTIONS.has(input.action);
}

/**
 * Extract a status transition (from/to) from an activity_log details blob.
 * Status moves land as "issue.updated" with the transition in
 * details._previous.status (issue-review-policy shape) or
 * details.changes.status.from/.to; a plain details.status carries the new
 * status. Missing/non-string parts resolve to null (never an unblock).
 */
export function extractStatusTransition(
  details: Record<string, unknown> | null,
): { fromStatus: string | null; toStatus: string | null } {
  const previous =
    (details?._previous as Record<string, unknown> | undefined) ?? undefined;
  const changes =
    (details?.changes as
      | Record<string, { from?: unknown; to?: unknown }>
      | undefined) ?? undefined;
  const fromStatus =
    typeof previous?.status === "string"
      ? (previous.status as string)
      : typeof changes?.status?.from === "string"
        ? (changes.status.from as string)
        : null;
  const toStatus =
    typeof details?.status === "string"
      ? (details.status as string)
      : typeof changes?.status?.to === "string"
        ? (changes.status.to as string)
        : null;
  return { fromStatus, toStatus };
}
