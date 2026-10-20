/**
 * Session rotation (R6, SPA-13647 program).
 *
 * Rotation ONLY: after N consecutive same error_code terminal failures on the
 * same issue, the next run starts on a FRESH provider session with a short
 * handoff note; the stalled session id is never resumed.
 *
 * Pure functions only — no DB, no imports from heartbeat.ts (cycle risk).
 * Fail-closed: empty/unknown input → count 0, shouldRotate false.
 */

export const SESSION_ROTATION_THRESHOLD = 2;

export const SESSION_ROTATION_HANDOFF_REASON =
  "session_rotation_same_stall_code";

/**
 * Fail-closed clear of the three rotation-scoped context keys. Rotation query
 * errors must never block the run, so the catch path clears any stale
 * handoff/rotation/previous-session fields before continuing on the existing
 * session. Operates in place on the run context record.
 */
export function clearStaleRotationState(
  context: Record<string, unknown> | null | undefined,
): void {
  if (!context || typeof context !== "object") return;
  delete context.paperclipSessionHandoffMarkdown;
  delete context.paperclipSessionRotationReason;
  delete context.paperclipPreviousSessionId;
}

export interface SameCodeStreakRun {
  id: string;
  status: string;
  errorCode: string | null | undefined;
}

export interface SameCodeStreak {
  code: string | null;
  count: number;
  runIds: string[];
}

const TERMINAL_UNSUCCESSFUL = new Set(["failed", "timed_out"]);

export function countConsecutiveSameCodeTerminalFailures(
  runs: readonly SameCodeStreakRun[] | null | undefined,
): SameCodeStreak {
  const empty: SameCodeStreak = { code: null, count: 0, runIds: [] };
  if (!runs || runs.length === 0) return empty;
  const newest = runs[0];
  const code = newest?.errorCode ?? null;
  if (!code) return empty;
  if (!newest || !TERMINAL_UNSUCCESSFUL.has(newest.status)) return empty;
  const runIds: string[] = [];
  for (const run of runs) {
    if (!run || !TERMINAL_UNSUCCESSFUL.has(run.status)) break;
    if ((run.errorCode ?? null) !== code) break;
    runIds.push(run.id);
  }
  return { code, count: runIds.length, runIds };
}

export function shouldRotateSession(input: {
  streak?: number | null;
  count?: number | null;
  code?: string | null;
}): boolean {
  const count = input?.streak ?? input?.count ?? 0;
  const code = input?.code ?? null;
  return (
    typeof count === "number" &&
    count >= SESSION_ROTATION_THRESHOLD &&
    typeof code === "string" &&
    code.length > 0
  );
}

export function buildSessionRotationHandoff(input: {
  code: string;
  count: number;
  stalledSessionId?: string | null;
  runIds?: readonly string[];
}): string {
  const stalled = input?.stalledSessionId || "unknown";
  const runs = (input?.runIds ?? []).join(", ") || "none";
  return [
    `reason: ${SESSION_ROTATION_HANDOFF_REASON}`,
    `stall code: ${input?.code ?? "unknown"} (x${input?.count ?? 0} consecutive)`,
    `stalled session ${stalled} is abandoned — never resume it;`,
    `start on a fresh provider session.`,
    `runs: ${runs}`,
  ].join("\n");
}
