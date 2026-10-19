/**
 * Stop-and-surface guard for repeated model-stream stalls.
 *
 * When the same issue's runs fail terminally with error_code
 * `model_stream_stalled` N times in a row, the engine stops scheduling
 * further automatic runs for it, moves the card to `blocked`, and posts a
 * single board-visible note (deduped on STALL_STOP_SURFACE_MARKER). Only an
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
 * First line of the single board-visible note; also the dedup key the
 * caller uses to post it exactly once per stall episode.
 */
export const STALL_STOP_SURFACE_MARKER = "stop-and-surface:model_stream_stalled";

/** Named unblock actions (actorType must be "user"). `status_changed` is NOT
 * listed here: it is direction-checked in isExplicitHumanUnblock (only a user
 * move FROM `blocked` TO a non-blocked status counts). */
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
 * STALL_STOP_THRESHOLD and the run list renders as `(none)`. The marker is
 * always the first line.
 */
export function buildStallStopNotice(runIds: string[]): string {
  const count = runIds.length > 0 ? runIds.length : STALL_STOP_THRESHOLD;
  const runList = runIds.map((id) => `\`${id}\``).join(", ") || "(none)";
  return [
    STALL_STOP_SURFACE_MARKER,
    `The last ${count} consecutive runs failed with error code \`${STALL_STOP_ERROR_CODE}\` and no automatic recovery succeeded.`,
    `Runs counted toward this streak, newest first: ${runList}.`,
    "This card was moved to `blocked` so it stops consuming runs on a stalled model stream.",
    "A bare board comment does not re-arm automatic work; only an explicit human unblock (a user moving the card off `blocked`, or the named unblock action) resumes it.",
  ].join("\n\n");
}

/**
 * True only for a human ("user") actor performing a status-change-off-blocked
 * or the named unblock action. Bare board comments (`comment_added` by any
 * actor) and all system/agent actions return false. A `status_changed` move
 * INTO `blocked`, `blocked`->`blocked`, or one with missing from/to returns
 * false — only a user move FROM `blocked` TO a non-blocked status re-arms.
 */
export function isExplicitHumanUnblock(input: {
  actorType: string | null;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
}): boolean {
  if (input.actorType !== "user") return false;
  if (input.action === "status_changed") {
    if (input.fromStatus !== "blocked") return false;
    if (!input.toStatus || input.toStatus === "blocked") return false;
    return true;
  }
  return STALL_STOP_UNBLOCK_ACTIONS.has(input.action);
}

/**
 * Silence decision for an already-held card: once stop-and-surface has
 * tripped, further wakes stay held (no new run, no new note) until an
 * explicit human unblock. Otherwise defers to shouldStopSurface.
 */
export function evaluateStallWake(stopHeld: boolean, streak: number): { held: boolean } {
  if (stopHeld) return { held: true };
  return { held: shouldStopSurface(streak) };
}
