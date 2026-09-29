import type {
  QueuedRunStalenessErrorCode,
  ScheduledRetryGateErrorCode,
} from "../domain/policy.js";

export type QueuedRunEvent = {
  kind: "run_queued";
  companyId: string;
  runId: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  wakeupRequestId: string | null;
};

export type RunStatusEvent = {
  kind: "run_status_published";
  companyId: string;
  runId: string;
  agentId: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  error: string | null;
  errorCode: string | null;
  /** Source-only projection from the committed run; never its full wake context. */
  contextSource: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  result: Record<string, unknown>;
  issueId: string | null;
  previousStatus: string | null;
};

/** Explicit event payloads a caller publishes after the semantic transaction commits. */
export type PostCommitEffect = QueuedRunEvent | RunStatusEvent;

export type PromoteScheduledRetryOutcome =
  | { outcome: "promoted"; postCommitEffects: PostCommitEffect[] }
  | {
      outcome: "gate_suppressed";
      reason: string;
      errorCode: ScheduledRetryGateErrorCode;
    }
  | { outcome: "not_promoted" };

export type CancelStaleQueuedRunOutcome =
  | { outcome: "not_stale" }
  /** The run's status no longer matched the phase the caller expected; a concurrent writer already won. */
  | { outcome: "lost_race" }
  | {
      outcome: "cancelled";
      reason: string;
      errorCode: QueuedRunStalenessErrorCode;
      postCommitEffects: PostCommitEffect[];
    }
  /**
   * SPA-8631 (Case 2): the run was flipped from `queued` to `scheduled_retry`
   * because the previous run's environment lease has not yet been released.
   * A bounded number of attempts is allowed before this outcome falls through
   * to `cancelled` with the recovery-action-required reason text.
   */
  | {
      outcome: "rescheduled";
      reason: string;
      errorCode: "execution_reconciliation_required";
      rescheduledRunId: string;
      attempt: number;
      dueAt: Date;
      postCommitEffects: PostCommitEffect[];
    };

export type RunDispatchApplicationErrorCode = "run_not_found";

export class RunDispatchApplicationError extends Error {
  constructor(
    readonly code: RunDispatchApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunDispatchApplicationError";
  }
}
