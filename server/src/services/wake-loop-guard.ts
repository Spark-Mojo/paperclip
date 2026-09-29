/**
 * SPA-9280 — wake-loop guard.
 *
 * Defect measured 2026-09-28: an automation wake (interaction delivery or
 * continuation recovery) gets skipped at consume time (e.g. blocked by a
 * cancelled blocker) and the recovery sweep re-emits an identical-shape wake
 * every reconciliation tick. The pre-existing continuation-retry gate
 * (`summarizeRecentContinuationRetries`) only counts terminal
 * `heartbeatRuns` rows — a skipped wake never creates a run, so the gate
 * never trips and the wake inserts every 30 s. SPA-7900 was measured at
 * 2,526 skipped `agent_wakeup_requests` rows for one (agent, issue) over 10
 * days; SPA-9121 item 8 / class AZ saw ~110 continuation wakes on 3 cards in
 * 12 h.
 *
 * Three layers of defense, gated at emit so the loop never produces
 * another row once tripped:
 *
 *   0. **Terminal-status guard.** Before counters run, fetch the issue's
 *      current status. If `done` or `cancelled`, refuse to emit AND skip
 *      the row write entirely (a terminal issue needs no evidence row).
 *      Defends against TOCTOU between the recovery sweep's candidates
 *      query and the consumer pull — the consumer classifies a queued wake
 *      as `skipped` only after the issue has already been closed, which
 *      the loop's 30 s cadence amplifies into N rows per close event.
 *      Operator-driven wakes (`requestedByActorType === "user"`) bypass.
 *
 *   1. **Per-chain exponential backoff.** Keyed on
 *      `(companyId, agentId, payload.issueId, payload.mutation, payload.retryOfRunId)` —
 *      `retryOfRunId` is the chain identity (matches the existing
 *      `INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS` key shape). At attempt
 *      N (1-indexed), the wake is admitted only if elapsed since the prior
 *      skip is at least `min(30s × 2^(N-2), 1h)`. Catches the
 *      everyday-loop pattern: a fresh wake is admitted (attempt 1), the
 *      next tick is refused (attempt 2 needs 30 s), the third tick needs
 *      60 s, etc. By attempt 7 the natural 30 s tick cadence is 32× slower
 *      than the backoff floor. Backoff is windowless — the curve applies
 *      across the entire history of the chain so an exhausted chain can't
 *      be re-warmed by waiting out the hourly window. No row is written
 *      when backoff refuses — the loop dies cold at the emit site.
 *
 *   2. **Per-(agent, issue) hourly cap.** Keyed on
 *      `(companyId, agentId, payload.issueId)` over a 60-minute window.
 *      Catches gross abuse (one (agent, issue) pair spam-attempted with
 *      different mutations/retryOfRunIds or with no chain identity at all)
 *      regardless of intent shape. Backoff handles chain discipline; the
 *      hourly cap is the gross-abuse ceiling across all chain shapes.
 *
 * When any guard trips, `enqueueWakeup` short-circuits and records a
 * `skipped` row with `reason="wake_loop_guard_tripped"` — but at most
 * once per trip event (deduped on `(companyId, agentId, issueId, guard)`
 * within a 60 s window), so a reconciliation tick firing every 30 s
 * produces at most one trip-row per minute per guard instead of one per
 * tick. When the gate trips inside the recovery sweep, the recovery sweep
 * additionally escalates the affected issue: a synthetic escalation issue
 * is minted and used as a real blocker edge (per DECISION-140 / `blocked`
 * needs a real blocker edge — comment-only paths are illegal). The
 * escalation issue is assigned to Dex (law 20 — git owner and the recovery
 * ownership lane for the engine).
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues, issueRelations } from "@paperclipai/db";

/** How many wakeup attempts on one (agent, issue) per hour trip the gross-abuse guard. */
export const WAKE_LOOP_GUARD_HOURLY_LIMIT = 20;

/** Window for the hourly guard. */
export const WAKE_LOOP_GUARD_WINDOW_MS = 60 * 60 * 1000;

/**
 * Base backoff (ms) for the per-chain exponential backoff. At skip attempt
 * N (1-indexed), the next wake is admitted only if elapsed since the prior
 * skip is at least BASE * 2^(N-1), capped at 1 hour. Trip-row dedup still
 * caps the row write rate at 1/min/guard; backoff gates whether a wake is
 * admitted at all, so the loop's tick cadence no longer amplifies into rows.
 *
 * Example backoffs at BASE=30_000 (30 s):
 *   attempt 1 (the very first) — no prior skip, admitted.
 *   attempt 2 — must wait 30 s since the prior skip.
 *   attempt 3 — must wait 60 s since the prior skip.
 *   attempt 4 — must wait 120 s since the prior skip.
 *   attempt 5 — must wait 240 s since the prior skip.
 *   attempt 6 — must wait 480 s since the prior skip.
 *   attempt 7+ — must wait 960/3600 s; the cap.
 *
 * With a 30 s reconciliation tick, the loop now produces no rows on attempts
 * 2..N (backoff refuses them, no row written). By attempt 7, the natural
 * tick cadence (every 30 s) is 32x slower than the backoff floor (960 s).
 */
export const WAKE_LOOP_GUARD_BACKOFF_BASE_MS = 30_000;
export const WAKE_LOOP_GUARD_BACKOFF_CAP_MS = 60 * 60 * 1000;

/** Window for trip-row dedup — once a guard trips, do not re-record a trip-row
 *  for the same (company, agent, issue, guard) within this many ms. Keeps the
 *  loop cold at write rate 1/min/guard instead of 1/tick (30 s). */
export const WAKE_LOOP_GUARD_TRIP_RECORD_DEDUP_MS = 60_000;

/**
 * Terminal statuses for an issue — once an issue is in `done` or `cancelled`,
 * no further wake should be emitted on its behalf. Defense-in-depth against
 * the recovery sweep's candidates filter racing with a status transition.
 */
export const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export function isTerminalIssueStatusForWake(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_ISSUE_STATUSES.has(status);
}

/**
 * Load the issue's current status for the terminal-status guard. Returns null
 * when the issue is missing (deleted). Callers treat null as a soft admit —
 * the counter guards downstream still gate; a deleted issue usually cannot
 * be the target of a wake anyway.
 */
export async function loadIssueStatusForWakeGuard(
  db: Db,
  issueId: string,
): Promise<string | null> {
  const row = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  return row?.status ?? null;
}

/**
 * Has a `wake_loop_guard_tripped` row already been written for this
 * `(companyId, agentId, issueId, guard)` tuple within the dedup window?
 * Used to keep the trip-row write rate at 1/min/guard instead of 1/tick.
 */
export async function hasRecentTripRecord(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    guard: "chain" | "hourly" | "backoff";
    now?: Date;
    windowMs?: number;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? WAKE_LOOP_GUARD_TRIP_RECORD_DEDUP_MS;
  const cutoff = new Date(now.getTime() - windowMs);
  const row = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.reason, "wake_loop_guard_tripped"),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        sql`(${agentWakeupRequests.payload} -> 'heartbeatSkip' ->> 'guard') = ${input.guard}`,
        gte(agentWakeupRequests.createdAt, cutoff),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row !== null;
}

export interface WakeLoopGuardSummary {
  /** Total wakeup-request rows for the (agent, issue) pair in the window, all statuses. */
  totalInWindow: number;
  /** Subset whose `status="skipped"`. */
  skippedInWindow: number;
}

export interface WakeLoopChainSummary extends WakeLoopGuardSummary {
  /** mutation string from the wake payload (e.g. "interaction"). */
  mutation: string | null;
  /** retryOfRunId from the wake payload. */
  retryOfRunId: string | null;
  /**
   * Created-at timestamp of the most recent wakeup row for this chain within
   * the window. Used by the backoff layer to compute elapsed-since-prior-skip
   * and admit only when the backoff curve has been honored. Null when the
   * chain has no rows (a fresh chain is admitted without backoff).
   */
  mostRecentSkipAt: Date | null;
}

export interface WakeLoopGuardInput {
  companyId: string;
  agentId: string;
  issueId: string;
  payload: Record<string, unknown> | null | undefined;
  now?: Date;
}

export type WakeLoopGuardDecision =
  | { tripped: false }
  | {
      tripped: true;
      guard: "hourly" | "chain" | "backoff";
      count: number;
      limit: number;
      windowMs: number;
      /** Attempt number (1-indexed) used by the backoff curve. */
      attempt: number;
      /** Required elapsed-since-prior-skip (ms) for the next attempt. */
      nextEligibleAt: Date;
      /** When the prior skip happened (most-recent row's createdAt). */
      mostRecentSkipAt: Date;
    };

/**
 * Backoff curve at attempt N is `min(BASE * 2^(N-1), CAP)`. The first
 * skip (attempt 1) needs no prior history; attempts 2+ require an
 * exponentially-growing cooldown since the prior skip, capped at one hour.
 */
export function backoffWindowMsForAttempt(attempt: number): number {
  if (attempt <= 1) return 0;
  const raw = WAKE_LOOP_GUARD_BACKOFF_BASE_MS * Math.pow(2, attempt - 2);
  return Math.min(raw, WAKE_LOOP_GUARD_BACKOFF_CAP_MS);
}

/**
 * Per-chain guard. Counts `agent_wakeup_requests` rows for
 * the (agent, issue) pair in the last `windowMs` milliseconds, regardless of
 * `status`. Trips when the total exceeds `WAKE_LOOP_GUARD_HOURLY_LIMIT`.
 */
export async function summarizeAgentIssueWakeupsInWindow(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    now?: Date;
    windowMs?: number;
  },
): Promise<WakeLoopGuardSummary> {
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? WAKE_LOOP_GUARD_WINDOW_MS;
  const cutoff = new Date(now.getTime() - windowMs);

  const rows = await db
    .select({
      status: agentWakeupRequests.status,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        gte(agentWakeupRequests.createdAt, cutoff),
      ),
    );

  const totalInWindow = rows.length;
  const skippedInWindow = rows.reduce(
    (count, row) => (row.status === "skipped" ? count + 1 : count),
    0,
  );
  return { totalInWindow, skippedInWindow };
}

/**
 * Look up the most recent wakeup row for the chain, ignoring the window
 * cutoff. Backoff is enforced across the entire history of the chain so
 * an exhausted chain can't be re-warmed by waiting out the hourly window
 * — the operator path (decide the chain is intentionally cancelled,
 * extend the budget) is the only recovery.
 */
export async function loadChainMostRecentSkipAt(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    mutation: string | null;
    retryOfRunId: string | null;
  },
): Promise<Date | null> {
  // A chain is keyed on the same shape as the per-chain cap; without a
  // mutation or retryOfRunId the chain is shapeless and backoff returns
  // null (the hourly guard catches gross abuse).
  if (!input.mutation && !input.retryOfRunId) return null;
  const conditions = [
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
  ];
  if (input.mutation) {
    conditions.push(sql`${agentWakeupRequests.payload} ->> 'mutation' = ${input.mutation}`);
  }
  if (input.retryOfRunId) {
    conditions.push(sql`${agentWakeupRequests.payload} ->> 'retryOfRunId' = ${input.retryOfRunId}`);
  }
  const rows = await db
    .select({ createdAt: agentWakeupRequests.createdAt })
    .from(agentWakeupRequests)
    .where(and(...conditions))
    .orderBy(desc(agentWakeupRequests.createdAt))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

/**
 * Per-(agent, issue, mutation, retryOfRunId) chain guard. A new
 * `retryOfRunId` is a different chain; the exhausted bucket does not bleed.
 */
export async function summarizeMutationChainWakeups(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    mutation: string | null;
    retryOfRunId: string | null;
    now?: Date;
    windowMs?: number;
  },
): Promise<WakeLoopChainSummary> {
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? WAKE_LOOP_GUARD_WINDOW_MS;
  const cutoff = new Date(now.getTime() - windowMs);

  // A chain is keyed on mutation + retryOfRunId. Without a mutation or
  // retryOfRunId the chain is "shapeless" and the per-chain guard cannot
  // apply — fall through (the hourly guard catches gross abuse).
  if (!input.mutation && !input.retryOfRunId) {
    return {
      totalInWindow: 0,
      skippedInWindow: 0,
      mutation: input.mutation,
      retryOfRunId: input.retryOfRunId,
      mostRecentSkipAt: null,
    };
  }

  const conditions = [
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
    gte(agentWakeupRequests.createdAt, cutoff),
  ];
  if (input.mutation) {
    conditions.push(sql`${agentWakeupRequests.payload} ->> 'mutation' = ${input.mutation}`);
  }
  if (input.retryOfRunId) {
    conditions.push(
      sql`${agentWakeupRequests.payload} ->> 'retryOfRunId' = ${input.retryOfRunId}`,
    );
  }

  const rows = await db
    .select({
      status: agentWakeupRequests.status,
      createdAt: agentWakeupRequests.createdAt,
    })
    .from(agentWakeupRequests)
    .where(and(...conditions));

  const totalInWindow = rows.length;
  const skippedInWindow = rows.reduce(
    (count, row) => (row.status === "skipped" ? count + 1 : count),
    0,
  );
  // Most recent wake (regardless of status) — used by the backoff layer to
  // compute elapsed-since-prior and admit only when the curve is honored.
  let mostRecentSkipAt: Date | null = null;
  for (const row of rows) {
    if (mostRecentSkipAt === null || row.createdAt > mostRecentSkipAt) {
      mostRecentSkipAt = row.createdAt;
    }
  }
  return {
    totalInWindow,
    skippedInWindow,
    mutation: input.mutation,
    retryOfRunId: input.retryOfRunId,
    mostRecentSkipAt,
  };
}

/**
 * Evaluate the per-chain backoff before the hourly cap. The chain layer
 * runs first because the chain is intent-aware: when the same
 * (mutation, retryOfRunId) keeps skipping, the loop should slow down
 * independently of the gross-abuse ceiling.
 *
 * Order of evaluation:
 *   1. Chain backoff: at attempt N, require elapsed >= curve(N) since the
 *      prior skip for the same (agent, issue, mutation, retryOfRunId). A
 *      fresh chain (no rows) is admitted without backoff. Backoff is
 *      windowless — the curve applies across the entire history of the
 *      chain so an exhausted chain can't be re-warmed by waiting out the
 *      hourly window.
 *   2. Hourly cap: refuse after WAKE_LOOP_GUARD_HOURLY_LIMIT total skips
 *      in the 60-minute window.
 *
 * Caller decides whether to also escalate the underlying issue.
 */
export async function evaluateWakeLoopGuard(
  db: Db,
  input: WakeLoopGuardInput,
): Promise<WakeLoopGuardDecision> {
  const now = input.now ?? new Date();
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const mutation = typeof payload.mutation === "string" ? payload.mutation : null;
  const retryOfRunId = typeof payload.retryOfRunId === "string" ? payload.retryOfRunId : null;

  if (mutation || retryOfRunId) {
    // Backoff looks at the entire chain history (window-agnostic) — the
    // curve must hold across days, not just the last hour, so a row from
    // yesterday's exhausted chain still constrains today's wake.
    const chainMostRecentSkipAt = await loadChainMostRecentSkipAt(db, {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      mutation,
      retryOfRunId,
    });
    // The hourly count is window-scoped (1 hour) — what we'd add a
    // hypothetical fresh wake to.
    const chain = await summarizeMutationChainWakeups(db, {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      mutation,
      retryOfRunId,
      now,
    });

    if (chainMostRecentSkipAt !== null && chain.totalInWindow >= 1) {
      const attempt = chain.totalInWindow + 1;
      const requiredElapsed = backoffWindowMsForAttempt(attempt);
      const elapsedMs = now.getTime() - chainMostRecentSkipAt.getTime();
      if (elapsedMs < requiredElapsed) {
        const nextEligibleAt = new Date(
          chainMostRecentSkipAt.getTime() + requiredElapsed,
        );
        return {
          tripped: true,
          guard: "backoff",
          count: chain.totalInWindow,
          limit: attempt,
          windowMs: WAKE_LOOP_GUARD_WINDOW_MS,
          attempt,
          nextEligibleAt,
          mostRecentSkipAt: chainMostRecentSkipAt,
        };
      }
    }
  }

  const hourly = await summarizeAgentIssueWakeupsInWindow(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    now,
  });
  if (hourly.totalInWindow >= WAKE_LOOP_GUARD_HOURLY_LIMIT) {
    return {
      tripped: true,
      guard: "hourly",
      count: hourly.totalInWindow,
      limit: WAKE_LOOP_GUARD_HOURLY_LIMIT,
      windowMs: WAKE_LOOP_GUARD_WINDOW_MS,
      attempt: hourly.totalInWindow + 1,
      nextEligibleAt: new Date(now.getTime() + WAKE_LOOP_GUARD_BACKOFF_BASE_MS),
      mostRecentSkipAt: now,
    };
  }
  return { tripped: false };
}

export interface EscalateWakeBudgetExhaustedInput {
  db: Db;
  issueId: string;
  decision: Extract<WakeLoopGuardDecision, { tripped: true }>;
  /**
   * Agent id assigned to the synthetic escalation issue. Pass the would-be
   * woken agent (the loop culprit) when the user/board/operator is expected to
   * fix the cause; pass a CTO/CEO or board escalation when the loop is
   * operator-side. The helper does not validate the choice — caller decides.
   */
  recoveryOwnerAgentId: string;
  /** The wake payload that would have been emitted (for context in the escalation). */
  payload: Record<string, unknown> | null | undefined;
  /** Source label (e.g. "recovery.reconcile_stranded_assigned_issue"). */
  source: string;
  /** Optional run id from the recovery sweep that triggered the escalation. */
  runId?: string | null;
  /** Issues service for synthetic-issue + blocker-edge + comment writes. */
  issuesSvc: {
    create: (
      companyId: string,
      input: Record<string, unknown>,
    ) => Promise<{ id: string; identifier: string | null } | null>;
    addComment: (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null } | null,
      options?: { authorType?: "user" | "agent" | "system" | null } | null,
    ) => Promise<unknown>;
  };
}

export interface EscalateWakeBudgetExhaustedResult {
  kind: "created" | "existing_blocked" | "skipped";
  escalationIssueId: string | null;
  reason: string;
}

/**
 * Auto-create a synthetic escalation issue when the wake-loop guard trips
 * inside the recovery sweep, attach it as a real blocker edge on the
 * affected issue, and post a board-visible comment. Mirrors the shape used
 * by `createIssueGraphLivenessEscalation` (synthetic issue + blocker edge +
 * system comment) so the two escalation seams stay aligned.
 */
export async function escalateWakeBudgetExhausted(
  input: EscalateWakeBudgetExhaustedInput,
): Promise<EscalateWakeBudgetExhaustedResult> {
  const issue = await input.db
    .select()
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .then((rows) => rows[0] ?? null);
  if (!issue) {
    return { kind: "skipped", escalationIssueId: null, reason: "issue_not_found" };
  }

  if (issue.status === "blocked") {
    // Already blocked — append a system note (real blocker edges are present
    // upstream; we do not double-mint a synthetic).
    await input.issuesSvc.addComment(
      issue.id,
      buildWakeBudgetNote(input.decision, input.payload),
      null,
      { authorType: "system" },
    );
    return {
      kind: "existing_blocked",
      escalationIssueId: null,
      reason: "already_blocked",
    };
  }

  if (issue.status === "done" || issue.status === "cancelled") {
    return { kind: "skipped", escalationIssueId: null, reason: "terminal_status" };
  }

  const incidentKey = `wake-budget-exhausted:${input.decision.guard}:${issue.id}`;
  const escalation = await input.issuesSvc.create(issue.companyId, {
    title: buildWakeBudgetEscalationTitle(issue.identifier ?? issue.id, input.decision),
    description: buildWakeBudgetEscalationDescription({
      issue,
      decision: input.decision,
      payload: input.payload,
      source: input.source,
    }),
    status: "todo",
    priority: "high",
    parentId: issue.id,
    projectId: issue.projectId,
    assigneeAgentId: input.recoveryOwnerAgentId,
    originKind: "wake_loop_guard_escalation",
    originId: incidentKey,
    originFingerprint: randomUUID(),
  });
  if (!escalation) {
    return { kind: "skipped", escalationIssueId: null, reason: "create_failed" };
  }

  await input.db.insert(issueRelations).values({
    companyId: issue.companyId,
    type: "blocks",
    issueId: issue.id,
    relatedIssueId: escalation.id,
  });

  await input.db
    .update(issues)
    .set({
      status: "blocked",
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issue.id));

  await input.issuesSvc.addComment(
    escalation.id,
    buildWakeBudgetEscalationOpeningNote({
      decision: input.decision,
      issueIdentifier: issue.identifier ?? issue.id,
    }),
    null,
    { authorType: "system" },
  );
  await input.issuesSvc.addComment(
    issue.id,
    buildWakeBudgetNote(input.decision, input.payload) +
      `\n\n- Synthetic escalation: \`${escalation.id}\` (assigned to the recovery owner)`,
    null,
    { authorType: "system" },
  );

  return { kind: "created", escalationIssueId: escalation.id, reason: "ok" };
}

function buildWakeBudgetEscalationTitle(issueIdentifier: string, decision: Extract<WakeLoopGuardDecision, { tripped: true }>) {
  return `WAKE-LOOP-GUARD tripped: ${issueIdentifier} (${decision.guard}, ${decision.count}/${decision.limit} in ${Math.round(decision.windowMs / 60_000)}m)`;
}

function buildWakeBudgetEscalationDescription(args: {
  issue: { id: string; identifier: string | null; title: string; status: string };
  decision: Extract<WakeLoopGuardDecision, { tripped: true }>;
  payload: Record<string, unknown> | null | undefined;
  source: string;
}) {
  const payload = (args.payload ?? {}) as Record<string, unknown>;
  const mutation = typeof payload.mutation === "string" ? payload.mutation : null;
  const retryOfRunId = typeof payload.retryOfRunId === "string" ? payload.retryOfRunId : null;
  const lines = [
    "Paperclip's wake-loop guard tripped for this card. The engine refused to",
    "queue another wakeup because the (agent, issue) pair had crossed the retry",
    "budget in the rolling window. The card has been moved to `blocked` with",
    "this escalation as the real blocker edge (per DECISION-140).",
    "",
    `- Source card: \`${args.issue.identifier ?? args.issue.id}\` (\`${args.issue.id}\`)`,
    `- Previous status: \`${args.issue.status}\``,
    `- Guard tripped: \`${args.decision.guard}\``,
    `- Count in window: ${args.decision.count}`,
    `- Limit: ${args.decision.limit}`,
    `- Window: ${args.decision.windowMs} ms`,
    `- Wake mutation: ${mutation ? `\`${mutation}\`` : "(none)"}`,
    `- Wake retryOfRunId: ${retryOfRunId ? `\`${retryOfRunId}\`` : "(none)"}`,
    `- Wake source: \`${args.source}\``,
  ];
  if (args.decision.guard === "backoff") {
    lines.push(
      "",
      `Next attempt eligible at: \`${args.decision.nextEligibleAt.toISOString()}\` (exponential backoff)`,
    );
  }
  lines.push(
    "",
    "Next action: review the affected card and either restore a live execution",
    "path, mark the chain as intentionally cancelled, or extend the budget. Do",
    "not close this escalation until the underlying wake loop is broken.",
  );
  return lines.join("\n");
}

function buildWakeBudgetEscalationOpeningNote(args: {
  decision: Extract<WakeLoopGuardDecision, { tripped: true }>;
  issueIdentifier: string;
}) {
  const lines = [
    "Paperclip opened this escalation because the wake-loop guard tripped for",
    `\`${args.issueIdentifier}\` (${args.decision.guard} guard, ${args.decision.count}/${args.decision.limit} attempts`,
    `in the last ${Math.round(args.decision.windowMs / 60_000)} minutes). The original card`,
    "is now `blocked` with this escalation as the real blocker edge. Investigate",
    "and either restore a live execution path or close the escalation once the",
    "loop is broken.",
  ];
  if (args.decision.guard === "backoff") {
    lines.push(
      "",
      `Next wake attempt eligible after \`${args.decision.nextEligibleAt.toISOString()}\` (exponential backoff).`,
    );
  }
  return lines.join(" ");
}

function buildWakeBudgetNote(
  decision: Extract<WakeLoopGuardDecision, { tripped: true }>,
  payload: Record<string, unknown> | null | undefined,
) {
  const mutation = typeof (payload ?? {})?.mutation === "string"
    ? (payload as Record<string, unknown>).mutation
    : null;
  const lines = [
    "Wake-loop guard tripped for this card.",
    `- Guard: \`${decision.guard}\``,
    `- Count: ${decision.count}`,
    `- Limit: ${decision.limit}`,
    `- Window: ${decision.windowMs} ms`,
    `- Mutation: ${mutation ? `\`${mutation}\`` : "(none)"}`,
  ];
  if (decision.guard === "backoff") {
    lines.push(
      `- Next attempt eligible: \`${decision.nextEligibleAt.toISOString()}\``,
      `- Backoff curve: 30 s × 2^(attempt - 2), capped at 1 hour`,
    );
  }
  lines.push(
    "",
    "Paperclip refused to queue another wakeup and minted a synthetic",
    "escalation as the blocker edge.",
  );
  return lines.join("\n");
}