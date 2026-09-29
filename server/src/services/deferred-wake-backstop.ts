/**
 * SPA-9351 shape 2: backstop for `deferred_issue_execution` wakes whose
 * blocking run has already ended.
 *
 * A wake is deferred when admission finds the issue's execution lock held by
 * another run. Promotion is otherwise event-driven: the run-end path calls
 * `releaseIssueExecutionAndPromote`, whose drain promotes parked wakes. There
 * is no startup or periodic backstop, so a row that was *already* stale when
 * the fixing release shipped is never promoted — the release event it was
 * waiting for happened before anything was listening.
 *
 * `resumeQueuedRuns` carries two narrow re-drives, but both are filtered to
 * comment-queue wakes and both resolve "the blocking run" as the wake
 * agent's *latest* run on the issue. That resolution is the real defect: a
 * reassignment can leave a wake addressed to the NEW assignee, who has no run
 * history on the card at all, so the lookup finds nothing and the sweep
 * `continue`s forever. SPA-9280 is exactly that — a wake for Dex on an issue
 * every prior run of which belonged to other agents.
 *
 * So the blocking run is resolved from the *wake's own recorded reference*,
 * never from the wake agent's run history. A missing or unresolvable
 * reference is not proof of terminality and suppresses promotion.
 */

import { TERMINAL_HEARTBEAT_RUN_STATUSES } from "./issues.js";

export const DEFERRED_WAKE_BACKSTOP_WAKE_REASON = "issue_execution_promoted";

/** Bound the page so a pathological backlog cannot monopolize a scheduler tick. */
export const DEFERRED_WAKE_BACKSTOP_CANDIDATE_LIMIT = 50;

export type DeferredWakeBlockingReference =
  | { kind: "run"; runId: string }
  | { kind: "recovery_action"; recoveryActionId: string }
  | { kind: "unresolved" };

export type DeferredWakeBackstopFacts = {
  wakeStatus: string;
  /** The run this wake deferred behind, as recorded on the wake payload. */
  blockingReference: DeferredWakeBlockingReference;
  /** `heartbeat_runs.status` of the referenced run, when resolved. */
  blockingRunStatus: string | null;
  /** Run id recorded on the recovery action's evidence, for action-backed waits. */
  recoveryActionRunStatus: string | null;
  /** A newer run still holds the issue's execution lock. */
  issueExecutionRunId: string | null;
  blockingRunStillHoldsLock: boolean;
  issueStatus: string;
  /** The wake's agent is still the issue's assignee. */
  wakeAgentIsAssignee: boolean;
  wakeCompanyIsActive: boolean;
  /** The referenced run was never resolvable, so we cannot prove terminality. */
  referenceUnresolvable: boolean;
};

export type DeferredWakeBackstopDecision =
  | { kind: "promote"; blockingRunId: string }
  | { kind: "suppressed"; reason: DeferredWakeBackstopSuppressReason };

export type DeferredWakeBackstopSuppressReason =
  | "not_deferred"
  | "company_inactive"
  | "unassignee_wake"
  | "terminal_issue"
  | "no_blocking_reference"
  | "reference_unresolvable"
  | "blocking_run_live"
  | "newer_execution_owner";

/**
 * True when a run status can never change again. Terminality is proven by the
 * join against `heartbeat_runs`, never inferred from a NULL `finished_at` —
 * a run can be terminal with a null finish, and non-terminal with one set.
 */
export function isTerminalBlockingRunStatus(status: string | null) {
  return status !== null && TERMINAL_HEARTBEAT_RUN_STATUSES.has(status);
}

/**
 * Decide whether a deferred wake's blocking run has ended and the wake should
 * be promoted.
 *
 * The ordering keeps the *proof* guards ahead of the eligibility guards: a
 * reason like `reference_unresolvable` is a statement about evidence, and
 * reporting an eligibility reason instead would hide that the sweep simply
 * could not tell.
 */
export function decideDeferredWakeBackstop(
  facts: DeferredWakeBackstopFacts,
): DeferredWakeBackstopDecision {
  if (facts.wakeStatus !== "deferred_issue_execution") {
    return { kind: "suppressed", reason: "not_deferred" };
  }
  if (!facts.wakeCompanyIsActive) {
    return { kind: "suppressed", reason: "company_inactive" };
  }
  if (!facts.wakeAgentIsAssignee) {
    // A reassigned card's parked wake belongs to history. The new assignee's
    // own wake is what should run; promoting a stale one would relock the
    // card to a former owner.
    return { kind: "suppressed", reason: "unassignee_wake" };
  }
  if (["done", "cancelled"].includes(facts.issueStatus)) {
    return { kind: "suppressed", reason: "terminal_issue" };
  }

  if (facts.blockingReference.kind === "unresolved") {
    return { kind: "suppressed", reason: "no_blocking_reference" };
  }
  if (facts.referenceUnresolvable) {
    return { kind: "suppressed", reason: "reference_unresolvable" };
  }

  const status =
    facts.blockingReference.kind === "run"
      ? facts.blockingRunStatus
      : facts.recoveryActionRunStatus;
  const blockingRunId =
    facts.blockingReference.kind === "run"
      ? facts.blockingReference.runId
      : null;
  if (!blockingRunId) {
    // An action-backed wait whose action names no run proves nothing.
    return { kind: "suppressed", reason: "reference_unresolvable" };
  }
  if (!isTerminalBlockingRunStatus(status)) {
    return { kind: "suppressed", reason: "blocking_run_live" };
  }
  // The drain re-reads and re-locks under the issue row, but never displace a
  // newer live owner: that is the one case where a stale terminal reference
  // must not win.
  if (
    facts.issueExecutionRunId !== null &&
    facts.issueExecutionRunId !== blockingRunId
  ) {
    return { kind: "suppressed", reason: "newer_execution_owner" };
  }

  return { kind: "promote", blockingRunId };
}

/**
 * Pull the blocking run reference out of a deferred wake payload.
 *
 * `interruptedRunId` is the field the deferral writers actually record (it is
 * the run whose execution the wake waited behind). `executionWait.recoveryActionId`
 * is the action-backed variant; it resolves to a run through the recovery
 * action's evidence at the call site. Anything else is unresolved — and
 * unresolved is never promoted.
 */
export function readDeferredWakeBlockingReference(
  payload: unknown,
): DeferredWakeBlockingReference {
  const record = asRecord(payload);
  if (!record) return { kind: "unresolved" };

  const context = asRecord(record._paperclipWakeContext);
  const interruptedRunId =
    readString(record.interruptedRunId) ?? readString(context?.interruptedRunId);
  if (interruptedRunId) return { kind: "run", runId: interruptedRunId };

  const executionWait = asRecord(record.executionWait);
  const recoveryActionId = readString(executionWait?.recoveryActionId);
  if (recoveryActionId) {
    return { kind: "recovery_action", recoveryActionId };
  }

  return { kind: "unresolved" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
