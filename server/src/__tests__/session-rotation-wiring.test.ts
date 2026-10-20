import { describe, expect, it } from "vitest";
import {
  SESSION_ROTATION_HANDOFF_REASON,
  SESSION_ROTATION_THRESHOLD,
  buildSessionRotationHandoff,
  countConsecutiveSameCodeTerminalFailures,
  shouldRotateSession,
} from "../services/session-rotation.ts";

const CODE = "model_stream_stalled";
const STALLED = "ses_eaebfd3b";

function fail(id: string, code: string | null | undefined, status = "failed") {
  return { id, status, errorCode: code };
}

// Replays the heartbeat else-if branch: streak -> shouldRotate -> handoff on
// a fresh session (null) that must never equal the stalled session id.
function branchDecision(runs: ReturnType<typeof fail>[], stalledSessionId: string) {
  const streak = countConsecutiveSameCodeTerminalFailures(runs);
  const rotate = shouldRotateSession({ count: streak.count, code: streak.code });
  if (!rotate || !streak.code) return { rotate: false as const, streak };
  const freshSessionId: string | null = null;
  const handoff = buildSessionRotationHandoff({
    code: streak.code,
    count: streak.count,
    stalledSessionId,
    runIds: streak.runIds,
  });
  return { rotate: true as const, streak, handoff, freshSessionId };
}

describe("session rotation heartbeat wiring", () => {
  it("2 consecutive same-code failures rotate to a fresh session", () => {
    const d = branchDecision([fail("r2", CODE), fail("r1", CODE)], STALLED);
    expect(d.rotate).toBe(true);
    expect(d.streak.count).toBe(2);
    expect(d.rotate && d.freshSessionId).not.toBe(STALLED);
    expect(d.rotate && d.freshSessionId).toBeNull();
    if (d.rotate) {
      expect(d.handoff).toContain(STALLED);
      expect(d.handoff).toContain(CODE);
      expect(d.handoff).toContain("never resume");
      expect(d.handoff).toContain(SESSION_ROTATION_HANDOFF_REASON);
    }
    expect(SESSION_ROTATION_HANDOFF_REASON).toBe("session_rotation_same_stall_code");
    expect(SESSION_ROTATION_THRESHOLD).toBeLessThan(3);
  });

  it("3rd consecutive same-code failure still rotates without resetting", () => {
    const d = branchDecision([fail("r3", CODE), fail("r2", CODE), fail("r1", CODE)], STALLED);
    expect(d.rotate).toBe(true);
    expect(d.streak.count).toBe(3);
    if (d.rotate) expect(d.handoff).toContain("x3 consecutive");
  });

  it("different code, null code, or success do not rotate (fail-closed)", () => {
    expect(branchDecision([fail("r2", "other_code"), fail("r1", CODE)], STALLED).rotate).toBe(false);
    expect(branchDecision([fail("r2", null), fail("r1", CODE)], STALLED).rotate).toBe(false);
    expect(branchDecision([{ id: "r2", status: "succeeded", errorCode: CODE }, fail("r1", CODE)], STALLED).rotate).toBe(false);
  });

  it("negative: newest differs so streak is 1, no rotation", () => {
    const streak = countConsecutiveSameCodeTerminalFailures([fail("r3", "other_code"), fail("r2", CODE), fail("r1", CODE)]);
    expect(streak.count).toBe(1);
    expect(shouldRotateSession({ count: streak.count, code: streak.code })).toBe(false);
  });
});
