import { describe, expect, it } from "vitest";
import {
  STALL_STOP_ERROR_CODE,
  STALL_STOP_SURFACE_MARKER,
  buildStallStopNotice,
  countStallStreak,
  extractStatusTransition,
  isExplicitHumanUnblock,
  shouldStopSurface,
  stallStopNoticeMarker,
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

describe("stallStopNoticeMarker", () => {
  it("same newest run id => same marker", () => {
    expect(stallStopNoticeMarker("r3")).toBe(stallStopNoticeMarker("r3"));
  });

  it("different newest run id => different marker", () => {
    expect(stallStopNoticeMarker("r3")).not.toBe(stallStopNoticeMarker("r4"));
  });

  it("marker starts with the episode-independent prefix", () => {
    expect(stallStopNoticeMarker("r3").startsWith(STALL_STOP_SURFACE_MARKER)).toBe(true);
  });
});

describe("buildStallStopNotice", () => {
  it("first line is the per-episode marker (run id embedded)", () => {
    const notice = buildStallStopNotice(["r3", "r2", "r1"]);
    const firstLine = notice.split("\n")[0];
    expect(firstLine).toBe(stallStopNoticeMarker("r3"));
    expect(firstLine.startsWith(STALL_STOP_SURFACE_MARKER)).toBe(true);
    expect(firstLine).toContain("r3");
  });

  it("empty runIds still emits marker first line with threshold count", () => {
    const notice = buildStallStopNotice([]);
    expect(notice.split("\n")[0]).toBe(stallStopNoticeMarker("unknown"));
    expect(notice.split("\n")[0].startsWith(STALL_STOP_SURFACE_MARKER)).toBe(true);
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

  it("user issue.updated change blocked->todo is true", () => {
    expect(
      isExplicitHumanUnblock({
        actorType: "user",
        action: "issue.updated",
        fromStatus: "blocked",
        toStatus: "todo",
      }),
    ).toBe(true);
  });

  it("user issue.updated change todo->blocked (into blocked) is false", () => {
    expect(
      isExplicitHumanUnblock({
        actorType: "user",
        action: "issue.updated",
        fromStatus: "todo",
        toStatus: "blocked",
      }),
    ).toBe(false);
  });

  it("user issue.updated change blocked->blocked is false", () => {
    expect(
      isExplicitHumanUnblock({
        actorType: "user",
        action: "issue.updated",
        fromStatus: "blocked",
        toStatus: "blocked",
      }),
    ).toBe(false);
  });

  it("user issue.updated title-edit shape (no status transition) is false", () => {
    // A later trivial issue.updated (title edit) carries details without a
    // status transition, so fromStatus/toStatus resolve to null — it must
    // not count as an unblock and (per the heartbeat re-arm window) must not
    // shadow a genuine earlier unblock.
    expect(
      isExplicitHumanUnblock({
        actorType: "user",
        action: "issue.updated",
        fromStatus: null,
        toStatus: null,
      }),
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

describe("extractStatusTransition", () => {
  it("_previous shape resolves from/to", () => {
    expect(
      extractStatusTransition({ _previous: { status: "blocked" }, status: "todo" }),
    ).toEqual({ fromStatus: "blocked", toStatus: "todo" });
  });

  it("changes shape resolves from/to", () => {
    expect(
      extractStatusTransition({
        changes: { status: { from: "blocked", to: "in_progress" } },
      }),
    ).toEqual({ fromStatus: "blocked", toStatus: "in_progress" });
  });

  it("title-edit shape (no transition) resolves nulls", () => {
    expect(extractStatusTransition({ title: "renamed" })).toEqual({
      fromStatus: null,
      toStatus: null,
    });
    expect(extractStatusTransition(null)).toEqual({
      fromStatus: null,
      toStatus: null,
    });
  });
});
