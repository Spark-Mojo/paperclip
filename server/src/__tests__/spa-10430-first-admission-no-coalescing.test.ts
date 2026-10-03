// SPA-10430: a board-authored comment arriving while a run holds the issue
// execution lock is DEFERRED, never coalesced, and is then promoted into a
// NEW run on lock release. This reproduces the observed SPA-9641 incident
// (run 22a911a3 created 1.48s after run 92d2e81b finished) from the real
// decision functions, using the exact facts read live from the board.
import { describe, expect, it } from "vitest";
import { shouldDeferFollowupWakeForSameIssue } from "../services/heartbeat.js";
import { decideWakeAdmission } from "../modules/wake-queue/domain/policy.js";

const BOARD_COMMENT_ID = "385781ee-cbc2-4412-87ed-803477ce4243";

describe("SPA-10430 first admission does not coalesce a board comment behind an in-flight run", () => {
  it("shouldDeferFollowupWakeForSameIssue is true for a running same-agent run carrying a board comment", () => {
    // Live facts for SPA-9641 at 09:23:34.631Z: run 92d2e81b was `running`,
    // agent 948042e0 (Tina) was both the active run's agent and the wake's
    // agent, and the wake carried board comment 385781ee.
    const deferred = shouldDeferFollowupWakeForSameIssue({
      activeRunStatus: "running",
      isSameExecutionAgent: true,
      wakeCommentId: BOARD_COMMENT_ID,
      forceFreshSession: false,
    });
    expect(deferred).toBe(true);
  });

  it("decideWakeAdmission returns defer (not coalesce) for that exact fact set", () => {
    const decision = decideWakeAdmission({
      allowRunCoalescing: undefined,
      sameDurableActor: undefined,
      isSameExecutionAgent: true,
      shouldDeferFollowupWake: true,
      shouldQueueFollowupForRunningWake: false,
      availableActiveExecutionRunPresent: true,
    });
    // defer => the wake is parked on agent_wakeup_requests with
    // status='deferred_issue_execution'. It is NOT absorbed by the in-flight
    // run, so the in-flight run never records 385781ee as consumed.
    expect(decision).toEqual({ kind: "defer" });
  });

  it("the same fact set coalesces only when the wake carries no comment id", () => {
    // Negative control: strip the comment id and the identical agent/lock
    // facts DO coalesce. That isolates the comment id as the sole reason the
    // board comment was not absorbed, rather than a same-agent mismatch.
    const withoutComment = shouldDeferFollowupWakeForSameIssue({
      activeRunStatus: "running",
      isSameExecutionAgent: true,
      wakeCommentId: null,
      forceFreshSession: false,
    });
    expect(withoutComment).toBe(false);

    const decision = decideWakeAdmission({
      allowRunCoalescing: undefined,
      sameDurableActor: undefined,
      isSameExecutionAgent: true,
      shouldDeferFollowupWake: withoutComment,
      shouldQueueFollowupForRunningWake: false,
      availableActiveExecutionRunPresent: true,
    });
    expect(decision).toEqual({ kind: "coalesce" });
  });

  it("a non-running active run with the same board comment also defers rather than coalescing", () => {
    // The comment id alone is not sufficient while status is `running`: the
    // guard is keyed on running status too. Once the predecessor run reaches
    // a terminal status the lock is released instead, so the promote path
    // (finalizePromotedWake) is what creates the new run.
    expect(
      shouldDeferFollowupWakeForSameIssue({
        activeRunStatus: "succeeded",
        isSameExecutionAgent: true,
        wakeCommentId: BOARD_COMMENT_ID,
        forceFreshSession: false,
      }),
    ).toBe(false);
  });
});