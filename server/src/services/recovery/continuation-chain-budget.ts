import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

/**
 * Chain-wide retry budget for the automatic productive-continuation chain.
 *
 * SPA-11836: on SPA-11628 (2026-10-11 15:30Z -> 16:03Z) the stranded-recovery
 * sweep minted 25 linked successors through
 * `issue.productive_terminal_continuation_recovery`, every one of them
 * `status=succeeded` with `scheduledRetryAttempt=0`, `scheduledRetryReason=None`
 * and `continuationAttempt=0`. A run on a text-only transport kept declaring a
 * concrete blocker, the sweep read `livenessState` `blocked`/`needs_followup` as
 * continuation-worthy, and the successor inherited a card whose only remaining
 * action was a write it could not perform. The per-run bounded-retry counters
 * never moved, so nothing stopped it; a stale-lock sweep did, ~33 minutes later.
 *
 * The bound therefore cannot live on a run. It lives on the chain: this module
 * walks the `retryOfRunId` ancestry, counts the chain itself, and refuses the
 * enqueue once the chain is spent. That is a different lane from SPA-4002's
 * `circuit_breaker_allows`, which bounds our harness re-issuing disposition-guard
 * violations per `(issueId, watcher, failure_signature)` and lives in
 * `sparkmojo-internal`, not in this repo.
 *
 * Two bounds, because one is not enough:
 * - consecutive non-advancing members (the fast trip for the obvious shape), and
 * - an absolute chain-depth ceiling (insurance against alternation, and against
 *   a future `livenessState` value that this module does not recognise as
 *   advancing).
 *
 * A chain that keeps making real progress terminates itself long before the
 * depth ceiling, so the ceiling only fires on something pathological no matter
 * what the run claims about itself.
 */

/** The stranded-recovery lane that mints automatic continuation successors. */
export const PRODUCTIVE_CONTINUATION_RECOVERY_SOURCE =
  "issue.productive_terminal_continuation_recovery";
export const CONTINUATION_CHAIN_RETRY_REASON = "issue_continuation_needed";

/**
 * Lifecycle-receipt prefix for a spent chain. Distinct from the bounded-retry
 * receipt (`Bounded retry exhausted%`) so the attention surfaces that read that
 * prefix keep ignoring these events.
 */
export const CONTINUATION_CHAIN_STOP_EVENT_PREFIX =
  "Continuation chain budget exhausted";

export const DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS = 3;
export const DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH = 10;

/**
 * Hard cap on ancestry hops. A corrupt or cyclic `retryOfRunId` must not turn one
 * sweep into an unbounded read; the budget trips long before this binds.
 */
export const CONTINUATION_CHAIN_WALK_LIMIT = 64;

/**
 * Liveness states that describe the loop: the run declared a concrete blocker,
 * or produced useful output with no concrete action evidence. A run in either
 * state hands its successor exactly the obligation it could not discharge.
 */
const NON_ADVANCING_LIVENESS_STATES = new Set(["blocked", "needs_followup"]);

export type ContinuationChainRun = {
  id: string;
  retryOfRunId: string | null;
  livenessState: string | null;
  status: string | null;
  contextSnapshot?: unknown;
};

export type ContinuationChainBudgetVerdict =
  | { allowed: true; consecutive: number; depth: number }
  | {
      allowed: false;
      bound: "consecutive" | "chain_depth";
      consecutive: number;
      depth: number;
    };

function positiveIntegerEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function resolveContinuationChainBudget(
  env: Record<string, string | undefined> = process.env,
): { maxConsecutive: number; maxDepth: number } {
  return {
    maxConsecutive: positiveIntegerEnv(
      env.RECOVERY_CONTINUATION_CHAIN_MAX_CONSECUTIVE,
      DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS,
    ),
    maxDepth: positiveIntegerEnv(
      env.RECOVERY_CONTINUATION_CHAIN_MAX_DEPTH,
      DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH,
    ),
  };
}

export function isProductiveContinuationChainRun(
  run: ContinuationChainRun,
): boolean {
  const context = parseObject(run.contextSnapshot);
  return (
    context.source === PRODUCTIVE_CONTINUATION_RECOVERY_SOURCE &&
    context.retryReason === CONTINUATION_CHAIN_RETRY_REASON
  );
}

export function isNonAdvancingContinuationRun(
  livenessState: string | null,
): boolean {
  return livenessState !== null && NON_ADVANCING_LIVENESS_STATES.has(livenessState);
}

/**
 * `ancestry` is newest-first and already restricted to one chain's members (the
 * caller stops walking at the first non-member). Depth counts every member,
 * including an advancing one — an advancing member only ends the leading
 * non-advancing run, it does not buy the chain a fresh budget.
 */
export function evaluateContinuationChainBudget(input: {
  ancestry: ContinuationChainRun[];
  maxConsecutive: number;
  maxDepth: number;
}): ContinuationChainBudgetVerdict {
  let consecutive = 0;
  for (const run of input.ancestry) {
    if (!isNonAdvancingContinuationRun(run.livenessState)) break;
    consecutive += 1;
  }
  const depth = input.ancestry.length;
  if (consecutive >= input.maxConsecutive) {
    return { allowed: false, bound: "consecutive", consecutive, depth };
  }
  if (depth >= input.maxDepth) {
    return { allowed: false, bound: "chain_depth", consecutive, depth };
  }
  return { allowed: true, consecutive, depth };
}

async function selectChainRun(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; runId: string },
): Promise<ContinuationChainRun | null> {
  const [row] = await db
    .select({
      id: heartbeatRuns.id,
      retryOfRunId: heartbeatRuns.retryOfRunId,
      livenessState: heartbeatRuns.livenessState,
      status: heartbeatRuns.status,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Newest-first chain members, walked through `retryOfRunId`. Stops at the first
 * ancestor that is not a member of this lane (a human dispatch, a different
 * recovery lane, a different issue) — that ancestor is a chain boundary, not a
 * link, so it can never spend this chain's budget or inherit its stop.
 */
export async function readContinuationChainAncestry(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; latestRunId: string },
): Promise<ContinuationChainRun[]> {
  const ancestry: ContinuationChainRun[] = [];
  const seen = new Set<string>();
  let cursor: string | null = input.latestRunId;

  while (cursor && ancestry.length < CONTINUATION_CHAIN_WALK_LIMIT) {
    if (seen.has(cursor)) break; // defensive: never loop on a cyclic pointer
    seen.add(cursor);
    const run = await selectChainRun(db, { ...input, runId: cursor });
    if (!run || !isProductiveContinuationChainRun(run)) break;
    ancestry.push(run);
    cursor = run.retryOfRunId;
  }

  return ancestry;
}

export type ContinuationChainStop = {
  runId: string;
  message: string;
  consecutive: number;
  depth: number;
  maxConsecutive: number;
  maxDepth: number;
  bound: "consecutive" | "chain_depth";
};

/**
 * The durable stop receipt. Returns the existing receipt when this chain was
 * already stopped, so the caller escalates exactly once and a later sweep over
 * the same chain refuses silently instead of commenting again.
 */
export async function gateContinuationChain(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; latestRunId: string },
): Promise<
  | { allowed: true; consecutive: number; depth: number }
  | { allowed: false; alreadyStopped: boolean; stop: ContinuationChainStop }
> {
  const ancestry = await readContinuationChainAncestry(db, input);
  const { maxConsecutive, maxDepth } = resolveContinuationChainBudget();
  const verdict = evaluateContinuationChainBudget({
    ancestry,
    maxConsecutive,
    maxDepth,
  });
  if (verdict.allowed) return verdict;

  const stopRunId = ancestry[0]?.id ?? input.latestRunId;
  const stop = {
    runId: stopRunId,
    message: buildContinuationChainStopMessage(verdict, { maxConsecutive, maxDepth }),
    consecutive: verdict.consecutive,
    depth: verdict.depth,
    maxConsecutive,
    maxDepth,
    bound: verdict.bound,
  };

  // A chain that already carries a stop receipt must not spend a second one, and
  // must not produce a second escalation.
  const existing = await findContinuationChainStop(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    runIds: ancestry.map((run) => run.id),
  });
  if (existing) {
    return {
      allowed: false,
      alreadyStopped: true,
      stop: { ...stop, runId: existing.runId, message: existing.message },
    };
  }

  await recordContinuationChainStop(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    runId: stopRunId,
    stop,
  });

  return { allowed: false, alreadyStopped: false, stop };
}

function buildContinuationChainStopMessage(
  verdict: Extract<ContinuationChainBudgetVerdict, { allowed: false }>,
  bounds: { maxConsecutive: number; maxDepth: number },
): string {
  const bound =
    verdict.bound === "consecutive"
      ? `${verdict.consecutive} consecutive non-advancing continuations (max ${bounds.maxConsecutive})`
      : `chain depth ${verdict.depth} (max ${bounds.maxDepth})`;
  return (
    `${CONTINUATION_CHAIN_STOP_EVENT_PREFIX} after ${verdict.consecutive} consecutive ` +
    `non-advancing continuation(s) at chain depth ${verdict.depth}; no further automatic ` +
    `re-queue will be queued for this chain. Bound: ${bound}.`
  );
}

export async function findContinuationChainStop(
  db: Db,
  input: { companyId: string; agentId: string; runIds: string[] },
): Promise<{ runId: string; message: string } | null> {
  if (input.runIds.length === 0) return null;
  const [row] = await db
    .select({
      runId: heartbeatRunEvents.runId,
      message: heartbeatRunEvents.message,
    })
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.agentId, input.agentId),
        inArray(heartbeatRunEvents.runId, input.runIds),
        eq(heartbeatRunEvents.eventType, "lifecycle"),
        sql`${heartbeatRunEvents.message} like ${`${CONTINUATION_CHAIN_STOP_EVENT_PREFIX}%`}`,
      ),
    )
    .limit(1);
  if (!row?.message) return null;
  return { runId: row.runId, message: row.message };
}

async function recordContinuationChainStop(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    stop: ContinuationChainStop;
  },
): Promise<void> {
  await appendHeartbeatRunEvent(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    eventType: "lifecycle",
    stream: "system",
    level: "warn",
    message: input.stop.message,
    payload: {
      reason: "continuation_chain_budget_exhausted",
      bound: input.stop.bound,
      consecutive: input.stop.consecutive,
      depth: input.stop.depth,
      maxConsecutive: input.stop.maxConsecutive,
      maxDepth: input.stop.maxDepth,
      source: PRODUCTIVE_CONTINUATION_RECOVERY_SOURCE,
      retryReason: CONTINUATION_CHAIN_RETRY_REASON,
    },
  });
}
