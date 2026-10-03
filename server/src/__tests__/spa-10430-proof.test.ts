// SPA-10430: reproduce the REAL promotion filter chain for the deferred
// board-comment wake on SPA-9641 (run 92d2e81b -> 22a911a3).
//
// Correction to an earlier draft of this proof: enrichWakeContextSnapshot
// (heartbeat.ts:26802, :7509-7535) runs at wakeup entry, BEFORE admission
// (:28367), and normalizes the emitter's scalar payload.commentId into
// contextSnapshot.wakeCommentIds as a 1-element ARRAY. So the deferred row's
// _paperclipWakeContext DOES carry wakeCommentIds, queuedCommentIds.length is
// 1 (not 0), and the author-ownership filters DO run. This file asserts the
// corrected chain.
import { describe, expect, it } from "vitest";
import { decideQueuedCommentAction } from "../modules/wake-queue/domain/policy.js";
import { queuedCommentIdsFromWakePayload } from "../services/issue-queued-comment-queue.js";

const BOARD_COMMENT = "385781ee-cbc2-4412-87ed-803477ce4243";
const FINISHING_RUN = "92d2e81b-2504-42fd-9e77-a8bfc42e0c05";
const REPLY_COMMENT = "61ba2cdd-37a9-4386-add9-a3dd0fdebd05";

describe("SPA-10430 promotion filter chain, corrected", () => {
  it("carries the board comment as a queued comment id, so the liveness filter runs", () => {
    // insertNewDeferredWake payload shape: emitter payload + _paperclipWakeContext
    // = the ALREADY-ENRICHED contextSnapshot (enrichWakeContextSnapshot ran first).
    const enrichedContextSnapshot = {
      issueId: "7fe21fef-07c8-4f38-99aa-5df591f37a91",
      taskId: "7fe21fef-07c8-4f38-99aa-5df591f37a91",
      commentId: BOARD_COMMENT,
      wakeCommentId: BOARD_COMMENT,
      wakeCommentIds: [BOARD_COMMENT], // <-- normalized by enrichWakeContextSnapshot
      source: "issue.comment",
      wakeReason: "issue_commented",
    };
    const deferredRowPayload = {
      issueId: "7fe21fef-07c8-4f38-99aa-5df591f37a91",
      commentId: BOARD_COMMENT,
      mutation: "comment",
      _paperclipWakeContext: enrichedContextSnapshot,
    };

    const queuedCommentIds = queuedCommentIdsFromWakePayload(deferredRowPayload);
    expect(queuedCommentIds).toEqual([BOARD_COMMENT]);

    const wakeReason = enrichedContextSnapshot.wakeReason;
    const queuedWakeIsCommentOnly =
      !wakeReason ||
      ["issue_commented", "issue_reopened_via_comment", "issue_comment_mentioned"].includes(wakeReason);
    const preservesIndependentContinuation =
      enrichedContextSnapshot.resumeIntent === true || !queuedWakeIsCommentOnly;
    expect(preservesIndependentContinuation).toBe(false);

    // use-cases.ts:198-201 -- ordinaryTaskComment gate opens (same agent as
    // finishing run, so the author-ownership branch at :201-217 is skipped).
    const ordinaryTaskComment =
      deferredRowPayload.mutation !== "interaction" &&
      !preservesIndependentContinuation &&
      queuedCommentIds.length > 0 &&
      ["issue_commented", "issue_reopened_via_comment"].includes(wakeReason);
    expect(ordinaryTaskComment).toBe(true);
    expect(FINISHING_RUN).toBeTruthy();
  });

  it("the liveness filter passes the board comment because it is board-authored", () => {
    // getQueuedCommentLiveness (postgres.ts:271-285) keeps a comment when it is
    // not deleted and NOT authored by the finishing run. The finishing run's own
    // reply 61ba2cdd is a DIFFERENT row; it is never consulted.
    const comments = [
      { id: BOARD_COMMENT, deletedAt: null, createdByRunId: null }, // board
      { id: REPLY_COMMENT, deletedAt: null, createdByRunId: FINISHING_RUN }, // run's reply
    ];
    const targetsFinishingRunAgent = true; // wakeAgentId === finishingRunAgentId (Tina)
    const queuedCommentIds = [BOARD_COMMENT];
    const liveNonSelfCommentIds = queuedCommentIds.filter((id) => {
      const row = comments.find((c) => c.id === id);
      return Boolean(row && !row.deletedAt && (!targetsFinishingRunAgent || row.createdByRunId !== FINISHING_RUN));
    });
    expect(liveNonSelfCommentIds).toEqual([BOARD_COMMENT]);

    const containedSelfAuthoredComment = comments.some(
      (row) => targetsFinishingRunAgent && !row.deletedAt && row.createdByRunId === FINISHING_RUN,
    );
    expect(containedSelfAuthoredComment).toBe(true);

    // decideQueuedCommentAction: hasQueuedCommentIds=true, live length 1 (not 0),
    // liveCommentIdsDiffer=false => "proceed", NOT "cancel_empty".
    expect(
      decideQueuedCommentAction({
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: liveNonSelfCommentIds.length,
        liveCommentIdsDiffer: false,
        containedSelfAuthoredComment,
        preservesIndependentContinuation: false,
      }),
    ).toEqual({ kind: "proceed" });
  });
});