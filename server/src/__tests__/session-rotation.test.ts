import { describe, expect, it } from "vitest";
import {
  SESSION_ROTATION_THRESHOLD,
  buildSessionRotationHandoff,
  countConsecutiveSameCodeTerminalFailures,
  shouldRotateSession,
} from "../services/session-rotation.ts";

function fail(id: string, code: string | null | undefined, status = "failed") {
  return { id, status, errorCode: code };
}

describe("countConsecutiveSameCodeTerminalFailures", () => {
  it("counts two consecutive same-code failures and rotates", () => {
    const streak = countConsecutiveSameCodeTerminalFailures([
      fail("r2", "E_STALL"),
      fail("r1", "E_STALL"),
    ]);
    expect(streak).toEqual({ code: "E_STALL", count: 2, runIds: ["r2", "r1"] });
    expect(shouldRotateSession({ count: streak.count, code: streak.code })).toBe(true);
  });

  it("threshold is 2, below the stop-and-surface count of 3", () => {
    expect(SESSION_ROTATION_THRESHOLD).toBe(2);
    expect(SESSION_ROTATION_THRESHOLD).toBeLessThan(3);
  });

  it("third same-code failure still rotates without resetting the counter", () => {
    const streak = countConsecutiveSameCodeTerminalFailures([
      fail("r3", "E_STALL"),
      fail("r2", "E_STALL"),
      fail("r1", "E_STALL"),
    ]);
    expect(streak.count).toBe(3);
    expect(shouldRotateSession({ count: streak.count, code: streak.code })).toBe(true);
  });

  it("breaks the streak on a different code", () => {
    const streak = countConsecutiveSameCodeTerminalFailures([
      fail("r2", "E_STALL"),
      fail("r1", "E_OTHER"),
    ]);
    expect(streak).toEqual({ code: "E_STALL", count: 1, runIds: ["r2"] });
    expect(shouldRotateSession({ count: streak.count, code: streak.code })).toBe(false);
  });

  it("breaks the streak on non-terminal or unsuccessful-other runs", () => {
    for (const status of ["succeeded", "cancelled", "interrupted", "running"]) {
      const streak = countConsecutiveSameCodeTerminalFailures([
        fail("r2", "E_STALL"),
        { id: "r1", status, errorCode: "E_STALL" },
      ]);
      expect(streak.count).toBe(1);
    }
    expect(
      countConsecutiveSameCodeTerminalFailures([
        { id: "r1", status: "succeeded", errorCode: "E_STALL" },
      ]).count,
    ).toBe(0);
  });

  it("counts timed_out as terminal alongside failed", () => {
    const streak = countConsecutiveSameCodeTerminalFailures([
      fail("r2", "E_STALL", "timed_out"),
      fail("r1", "E_STALL"),
    ]);
    expect(streak.count).toBe(2);
  });

  it("fail-closes on null errorCode and empty input", () => {
    expect(countConsecutiveSameCodeTerminalFailures([fail("r1", null)])).toEqual({
      code: null, count: 0, runIds: [],
    });
    expect(countConsecutiveSameCodeTerminalFailures([])).toEqual({
      code: null, count: 0, runIds: [],
    });
    expect(shouldRotateSession({ count: 0, code: null })).toBe(false);
  });
});

describe("buildSessionRotationHandoff", () => {
  it("names the stalled session, code, never-resume wording and run ids", () => {
    const note = buildSessionRotationHandoff({
      code: "E_STALL", count: 2, stalledSessionId: "sess-123", runIds: ["r2", "r1"],
    });
    expect(note).toContain("sess-123");
    expect(note).toContain("E_STALL");
    expect(note).toContain("never resume");
    expect(note).toContain("r2");
    expect(note).toContain("r1");
  });
});
