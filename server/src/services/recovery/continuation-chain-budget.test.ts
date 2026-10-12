import { describe, expect, it } from "vitest";

import {
  CONTINUATION_CHAIN_RETRY_REASON,
  CONTINUATION_CHAIN_STOP_EVENT_PREFIX,
  DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS,
  DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH,
  PRODUCTIVE_CONTINUATION_RECOVERY_SOURCE,
  evaluateContinuationChainBudget,
  isNonAdvancingContinuationRun,
  isProductiveContinuationChainRun,
  resolveContinuationChainBudget,
  type ContinuationChainRun,
} from "./continuation-chain-budget.js";

const ISSUE_ID = "43299995-9abd-4d80-96d0-4e01fbc725e6";

/**
 * Mirrors the live SPA-11628 chain: `contextSnapshot.source` is the stranded
 * recovery lane and `contextSnapshot.retryReason` is the continuation reason.
 * Both keys must be present for a run to count as a chain member — a run from
 * any other lane is a fresh chain root, not a link in this one.
 */
function chainMember(input: {
  id: string;
  retryOfRunId: string | null;
  livenessState: string | null;
  status?: string | null;
}): ContinuationChainRun {
  return {
    id: input.id,
    retryOfRunId: input.retryOfRunId,
    livenessState: input.livenessState,
    status: input.status ?? "succeeded",
    contextSnapshot: {
      issueId: ISSUE_ID,
      taskId: ISSUE_ID,
      wakeReason: CONTINUATION_CHAIN_RETRY_REASON,
      retryReason: CONTINUATION_CHAIN_RETRY_REASON,
      source: PRODUCTIVE_CONTINUATION_RECOVERY_SOURCE,
      retryOfRunId: input.retryOfRunId,
    },
  };
}

function chain(input: {
  count: number;
  livenessStates: (string | null)[];
}): ContinuationChainRun[] {
  return input.livenessStates.slice(0, input.count).map((livenessState, index) =>
    chainMember({
      id: `run-${index}`,
      retryOfRunId: index === 0 ? "human-root" : `run-${index - 1}`,
      livenessState,
    }),
  );
}

describe("continuation chain budget", () => {
  describe("isProductiveContinuationChainRun", () => {
    it("recognises a run the automatic continuation lane produced", () => {
      expect(
        isProductiveContinuationChainRun(
          chainMember({
            id: "run-0",
            retryOfRunId: "human-root",
            livenessState: "blocked",
          }),
        ),
      ).toBe(true);
    });

    it.each([
      "issue.continuation_recovery",
      "issue.assignment_recovery",
      "issue.interaction_continuation_recovery",
    ])("rejects a run from the %s lane", (source) => {
      expect(
        isProductiveContinuationChainRun({
          id: "run-0",
          retryOfRunId: null,
          livenessState: "blocked",
          status: "succeeded",
          contextSnapshot: {
            issueId: ISSUE_ID,
            source,
            retryReason: CONTINUATION_CHAIN_RETRY_REASON,
          },
        }),
      ).toBe(false);
    });

    it("rejects a run with no retryReason", () => {
      expect(
        isProductiveContinuationChainRun({
          id: "run-0",
          retryOfRunId: null,
          livenessState: "advanced",
          status: "succeeded",
          contextSnapshot: { issueId: ISSUE_ID, source: PRODUCTIVE_CONTINUATION_RECOVERY_SOURCE },
        }),
      ).toBe(false);
    });

    it("rejects a run whose context snapshot is not an object", () => {
      expect(
        isProductiveContinuationChainRun({
          id: "run-0",
          retryOfRunId: null,
          livenessState: "blocked",
          status: "succeeded",
          contextSnapshot: "issue.productive_terminal_continuation_recovery",
        }),
      ).toBe(false);
    });
  });

  describe("isNonAdvancingContinuationRun", () => {
    it.each(["blocked", "needs_followup"])("treats %s as non-advancing", (state) => {
      expect(isNonAdvancingContinuationRun(state)).toBe(true);
    });

    it.each(["advanced", "completed", "plan_only", "empty_response", "failed", null])(
      "treats %s as advancing or not loop-shaped",
      (state) => {
        expect(isNonAdvancingContinuationRun(state)).toBe(false);
      },
    );
  });

  describe("evaluateContinuationChainBudget", () => {
    const budget = {
      maxConsecutive: DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS,
      maxDepth: DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH,
    };

    it("never treats a first run as a chain", () => {
      expect(
        evaluateContinuationChainBudget({ ancestry: [], ...budget }),
      ).toEqual({ allowed: true, consecutive: 0, depth: 0 });
    });

    it("permits a chain that has not reached the consecutive bound", () => {
      const verdict = evaluateContinuationChainBudget({
        ancestry: chain({
          count: 2,
          livenessStates: ["blocked", "blocked"],
        }),
        ...budget,
      });
      expect(verdict).toEqual({ allowed: true, consecutive: 2, depth: 2 });
    });

    it("refuses at the consecutive bound", () => {
      const verdict = evaluateContinuationChainBudget({
        ancestry: chain({
          count: 3,
          livenessStates: ["blocked", "blocked", "blocked"],
        }),
        ...budget,
      });
      expect(verdict).toEqual({
        allowed: false,
        bound: "consecutive",
        consecutive: 3,
        depth: 3,
      });
    });

    it("lets an advancing member end the consecutive run without resetting depth", () => {
      const verdict = evaluateContinuationChainBudget({
        // Newest first: advanced, blocked, blocked, advanced.
        ancestry: chain({
          count: 4,
          livenessStates: ["advanced", "blocked", "blocked", "advanced"],
        }),
        ...budget,
      });
      expect(verdict).toEqual({ allowed: true, consecutive: 0, depth: 4 });
    });

    it("refuses an alternating chain on the absolute depth ceiling", () => {
      const verdict = evaluateContinuationChainBudget({
        ancestry: chain({
          count: 12,
          livenessStates: Array.from({ length: 12 }, (_, index) =>
            index % 2 === 0 ? "blocked" : "advanced",
          ),
        }),
        ...budget,
      });
      expect(verdict).toEqual({
        allowed: false,
        bound: "chain_depth",
        consecutive: 1,
        depth: 12,
      });
    });

    it("refuses an all-advancing chain once it passes the depth ceiling", () => {
      const verdict = evaluateContinuationChainBudget({
        ancestry: chain({
          count: 12,
          livenessStates: Array.from({ length: 12 }, () => "advanced"),
        }),
        ...budget,
      });
      expect(verdict).toEqual({
        allowed: false,
        bound: "chain_depth",
        consecutive: 0,
        depth: 12,
      });
    });

    it("never cuts off a progressing chain that is under the depth ceiling", () => {
      const verdict = evaluateContinuationChainBudget({
        ancestry: chain({
          count: 4,
          livenessStates: Array.from({ length: 4 }, () => "advanced"),
        }),
        ...budget,
      });
      expect(verdict).toEqual({ allowed: true, consecutive: 0, depth: 4 });
    });

    it("reports the consecutive bound when both bounds trip", () => {
      const verdict = evaluateContinuationChainBudget({
        ancestry: chain({
          count: 5,
          livenessStates: Array.from({ length: 5 }, () => "blocked"),
        }),
        maxConsecutive: 3,
        maxDepth: 3,
      });
      expect(verdict).toEqual({
        allowed: false,
        bound: "consecutive",
        consecutive: 5,
        depth: 5,
      });
    });

    it("counts only the leading non-advancing run of a chain that recovered part way", () => {
      const verdict = evaluateContinuationChainBudget({
        ancestry: chain({
          count: 6,
          livenessStates: ["blocked", "blocked", "blocked", "advanced", "blocked", "blocked"],
        }),
        maxConsecutive: 3,
        maxDepth: 10,
      });
      expect(verdict).toEqual({
        allowed: false,
        bound: "consecutive",
        consecutive: 3,
        depth: 6,
      });
    });
  });

  describe("resolveContinuationChainBudget", () => {
    it("falls back to the shipped defaults", () => {
      expect(resolveContinuationChainBudget({})).toEqual({
        maxConsecutive: DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS,
        maxDepth: DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH,
      });
      expect(DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS).toBe(3);
      expect(DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH).toBe(10);
    });

    it("honours explicit overrides", () => {
      expect(
        resolveContinuationChainBudget({
          RECOVERY_CONTINUATION_CHAIN_MAX_CONSECUTIVE: "7",
          RECOVERY_CONTINUATION_CHAIN_MAX_DEPTH: "25",
        }),
      ).toEqual({ maxConsecutive: 7, maxDepth: 25 });
    });

    it.each(["", "abc", "0", "-4", "2.5", "  "])(
      "falls back to the defaults for the junk value %j",
      (value) => {
        expect(
          resolveContinuationChainBudget({
            RECOVERY_CONTINUATION_CHAIN_MAX_CONSECUTIVE: value,
            RECOVERY_CONTINUATION_CHAIN_MAX_DEPTH: value,
          }),
        ).toEqual({
          maxConsecutive: DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS,
          maxDepth: DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH,
        });
      },
    );

    it("resolves one bound independently of the other", () => {
      expect(
        resolveContinuationChainBudget({
          RECOVERY_CONTINUATION_CHAIN_MAX_DEPTH: "4",
        }),
      ).toEqual({
        maxConsecutive: DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS,
        maxDepth: 4,
      });
    });
  });

  it("exposes the durable chain-stop receipt prefix", () => {
    expect(CONTINUATION_CHAIN_STOP_EVENT_PREFIX).toBe(
      "Continuation chain budget exhausted",
    );
  });
});
