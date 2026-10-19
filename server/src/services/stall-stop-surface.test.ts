import { describe, expect, it } from "vitest";
import {
  STALL_STOP_ERROR_CODE,
  STALL_STOP_SURFACE_MARKER,
  buildStallStopNotice,
  countStallStreak,
  evaluateStallWake,
  isExplicitHumanUnblock,
  shouldStopSurface,
  type StallStopRunSample,
} from "./stall-stop-surface.js";

function stalled(id: string): StallStopRunSample {
  return { id, status: "failed", errorCode: STALL_STOP_ERROR_CODE };
}

describe("countStallStreak / shouldStopSurface", () => {
  it("3x failed+same-code -> streak 3, shouldStop true", () => {
    const { streak, runIds } = countStallStreak([stalled("r3"), stalled("r2"), stalled("r1")]);
    expect(streak).toBe(3);
    expect(runIds).toEqual(["r3", "r2", "r1"]);
    expect(shouldStopSurface(streak)).toBe(true);
  });

  it("2x -> streak 2, shouldStop false", () => {
    const { streak, runIds } = countStallStreak([stalled("r2"), stalled("r1")]);
    expect(streak).toBe(2);
    expect(runIds).toEqual(["r2", "r1"]);
    expect(shouldStopSurface(streak)).toBe(false);
  });

  it("success breaks the streak", () => {
    const runs: StallStopRunSample[] = [
      stalled("r3"),
      { id: "ok", status: "succeeded", errorCode: null },
      stalled("r1"),
    ];
    expect(countStallStreak(runs)).toEqual({ streak: 1, runIds: ["r3"] });
  });

  it("different error_code breaks the streak", () => {
    const runs: StallStopRunSample[] = [
      stalled("r3"),
      stalled("r2"),
      { id: "other", status: "failed", errorCode: "something_else" },
      stalled("r0"),
    ];
    expect(countStallStreak(runs)).toEqual({ streak: 2, runIds: ["r3", "r2"] });
  });

  it("null error_code breaks the streak", () => {
    const runs: StallStopRunSample[] = [
      stalled("r2"),
      { id: "nullcode", status: "failed", errorCode: null },
      stalled("r0"),
    ];
    expect(countStallStreak(runs)).toEqual({ streak: 1, runIds: ["r2"] });
  });

  it("cancelled breaks the streak", () => {
    const runs: StallStopRunSample[] = [
      stalled("r2"),
      { id: "cx", status: "cancelled", errorCode: STALL_STOP_ERROR_CODE },
      stalled("r0"),
    ];
    expect(countStallStreak(runs)).toEqual({ streak: 1, runIds: ["r2"] });
  });

  it("timed_out breaks the streak", () => {
    const runs: StallStopRunSample[] = [
      stalled("r2"),
      { id: "to", status: "timed_out", errorCode: STALL_STOP_ERROR_CODE },
    ];
    expect(countStallStreak(runs).streak).toBe(1);
  });

  it("empty sample -> streak 0, shouldStop false", () => {
    expect(countStallStreak([])).toEqual({ streak: 0, runIds: [] });
    expect(shouldStopSurface(0)).toBe(false);
  });

  it("no wall-clock: old timestamps do not affect the count (module takes no dates)", () => {
    // Interface carries no finishedAt/date fields at all — replay with
    // samples that would be ancient in any dated model; order alone decides.
    const runs: StallStopRunSample[] = [stalled("old3"), stalled("old2"), stalled("old1")];
    const { streak } = countStallStreak(runs);
    expect(streak).toBe(3);
    expect(shouldStopSurface(streak)).toBe(true);
  });
});

describe("buildStallStopNotice", () => {
  it("first line is exactly the marker", () => {
    const notice = buildStallStopNotice(["r3", "r2", "r1"]);
    expect(notice.split("\n")[0]).toBe(STALL_STOP_SURFACE_MARKER);
    expect(notice.split("\n")[0]).toBe("stop-and-surface:model_stream_stalled");
  });

  it("empty runIds still emits marker first line with threshold count", () => {
    const notice = buildStallStopNotice([]);
    expect(notice.split("\n")[0]).toBe(STALL_STOP_SURFACE_MARKER);
    expect(notice).toContain("3");
    expect(notice).toContain("(none)");
  });

  it("body names the streak, code, blocked move, and no-rearm rule", () => {
    const notice = buildStallStopNotice(["r3", "r2", "r1"]);
    expect(notice).toContain("3");
    expect(notice).toContain(STALL_STOP_ERROR_CODE);
    expect(notice).toContain("blocked");
    expect(notice).toContain("bare board comment does not re-arm");
    expect(notice).toContain("explicit human unblock");
  });
});

describe("isExplicitHumanUnblock", () => {
  it("user status change blocked->todo is true", () => {
    expect(
      isExplicitHumanUnblock({
        actorType: "user",
        action: "status_changed",
        fromStatus: "blocked",
        toStatus: "todo",
      }),
    ).toBe(true);
  });

  it("user status change blocked->blocked is false", () => {
    expect(
      isExplicitHumanUnblock({
        actorType: "user",
        action: "status_changed",
        fromStatus: "blocked",
        toStatus: "blocked",
      }),
    ).toBe(false);
  });

  it("user status change todo->blocked (into blocked) is false", () => {
    expect(
      isExplicitHumanUnblock({
        actorType: "user",
        action: "status_changed",
        fromStatus: "todo",
        toStatus: "blocked",
      }),
    ).toBe(false);
  });

  it("user status change with missing from/to is false", () => {
    expect(isExplicitHumanUnblock({ actorType: "user", action: "status_changed" })).toBe(false);
    expect(
      isExplicitHumanUnblock({ actorType: "user", action: "status_changed", fromStatus: "blocked" }),
    ).toBe(false);
    expect(
      isExplicitHumanUnblock({ actorType: "user", action: "status_changed", toStatus: "todo" }),
    ).toBe(false);
  });

  it("user named unblock action is true", () => {
    expect(isExplicitHumanUnblock({ actorType: "user", action: "issue.unblocked" })).toBe(true);
  });

  it("user comment_added is false", () => {
    expect(isExplicitHumanUnblock({ actorType: "user", action: "comment_added" })).toBe(false);
  });

  it("agent comment is false", () => {
    expect(isExplicitHumanUnblock({ actorType: "agent", action: "comment_added" })).toBe(false);
  });

  it("system action is false", () => {
    expect(isExplicitHumanUnblock({ actorType: "system", action: "status_changed" })).toBe(false);
  });

  it("agent unblock action is false", () => {
    expect(isExplicitHumanUnblock({ actorType: "agent", action: "issue.unblocked" })).toBe(false);
  });
});

describe("evaluateStallWake silence", () => {
  it("stopHeld stays held across repeated wakes with the same streak", () => {
    expect(evaluateStallWake(true, 3)).toEqual({ held: true });
    expect(evaluateStallWake(true, 3)).toEqual({ held: true });
    expect(evaluateStallWake(true, 3)).toEqual({ held: true });
  });

  it("not held below threshold, held at threshold", () => {
    expect(evaluateStallWake(false, 2)).toEqual({ held: false });
    expect(evaluateStallWake(false, 3)).toEqual({ held: true });
  });
});
