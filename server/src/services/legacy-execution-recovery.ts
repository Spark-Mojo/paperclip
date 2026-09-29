import { normalizeMaxTurnStopReason } from "./heartbeat-stop-metadata.js";
import { hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { isSupersededConversationRun } from "./agent-conversations.js";

type Run = typeof heartbeatRuns.$inferSelect;
export const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";

/** Error families describe availability, not whether earlier actions happened. */
export function legacyExecutionNeedsReconciliation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, "scheduledRetryAttempt" | "scheduledRetryReason" | "contextSnapshot">>,
): boolean {
  if (
    run.runtimeMode === "native" ||
    !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
  )
    return false;
  // A fresh conversation turn lets the agent decide what remains. The retry
  // scheduler, not an action-outcome hold, owns the automatic attempt limit.
  if (hasConversationContinuationPolicy(run.resultJson)) return false;
  // Productive turn-budget continuation is not a failed provider session.
  if (normalizeMaxTurnStopReason(run.resultJson?.stopReason) ?? normalizeMaxTurnStopReason(run.errorCode)) return false;
  const evidence = run.resultJson?.executionRecovery as
    Record<string, unknown> | undefined;
  if (run.status === "cancelled" && evidence?.kind === "interrupted"
      && evidence.providerStopped === true && evidence.sessionPreserved === true
      && evidence.actionOutcomes === "settled"
      && (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged") return false;
  // Waiting for a subscription or workspace precedes provider execution. It is
  // a resource wait, not a failed provider attempt or permission to replay work.
  if (run.status === "cancelled" && run.errorCode === "ai_connection_busy" &&
      evidence?.kind === "ai_connection_wait" && evidence.providerWorkStarted === false) return false;
  if (run.status === "cancelled" && run.errorCode === "workspace_busy" &&
      evidence?.kind === "workspace_wait" && evidence.providerWorkStarted === false) return false;
  // Setup owns the bounded retry budget for temporary workspace scans. Its
  // exhaustion needs workspace repair, not reconciliation of provider actions
  // that the bootstrap evidence proves never started. Keep unknown outcomes held.
  if ((run.errorCode === "workspace_git_scan_timeout" || run.errorCode === "workspace_git_scan_saturated") &&
      evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false) return false;
  if (executionFailureRetryCount(run) >= 2) return true;
  return !(
    evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false
  );
}

/** Persist the failed legacy run, owned lock release and operator decision together. */
export async function terminalizeLegacyExecution(input: {
  db: Db;
  run: Run;
  status: string;
  patch?: Partial<typeof heartbeatRuns.$inferInsert>;
  fromStatuses?: string[];
}) {
  const { db, run, status, patch } = input;
  const issueId =
    run.nativeIssueId ??
    (typeof run.contextSnapshot?.issueId === "string"
      ? run.contextSnapshot.issueId
      : null);
  // SPA-9282 (cycle 4): the delivery-id latch below was structurally defeated
  // by the status-delivery cycle. deliverExecutionStatuses (a 15s sweep)
  // publishes heartbeat.run.status and then CLEARS executionStatusDeliveryId
  // to null, so on the next periodic reconciliation pass (recovery stranded
  // sweep, quota monitor recovery, continuation recovery) the latch read
  // false, this function rewrote updated_at + a fresh delivery id on the
  // already-terminal row, setRunStatus published it, and the UI toasted the
  // run as a fresh failure — every ~15-40s, forever (the "Steve/Argus
  // failing all day" toasts; proven live by heartbeat_run_writer_audit:
  // 157 execution_status_delivery_id cycles on the five observed runs).
  // The canonical once marker must survive the publish-and-clear cycle, so
  // it lives in result_json.executionTerminalizedAt, written in the same
  // update that first terminalizes the run. An empty-patch re-terminalize
  // of a marked run is a hard no-op regardless of delivery id.
  const [liveRow] = await db
    .select({
      executionStatusDeliveryId: heartbeatRuns.executionStatusDeliveryId,
      resultJson: heartbeatRuns.resultJson,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.companyId, run.companyId),
    ))
    .limit(1);
  const terminalizedMarker = (liveRow?.resultJson as Record<string, unknown> | null)
    ?.executionTerminalizedAt;
  const hasSubstantivePatch = Boolean(patch && Object.keys(patch).length > 0);
  if (typeof terminalizedMarker === "string" && !hasSubstantivePatch) {
    return null;
  }
  const deliveryAlreadySet = typeof liveRow?.executionStatusDeliveryId === "string"
    && liveRow.executionStatusDeliveryId.length > 0;
  if (deliveryAlreadySet && !hasSubstantivePatch) {
    return null;
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
    );
    const [task] = issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)),
          )
          .for("update")
      : [];
    // Base the merged result_json on the LIVE row read above (the input `run`
    // snapshot is stale across periodic sweep ticks), merge any caller patch
    // result_json on top, then stamp the once marker. The marker survives the
    // status-delivery publish-and-clear cycle that defeats the delivery-id
    // latch.
    const patchResultJson = (patch?.resultJson ?? null) as Record<string, unknown> | null;
    const mergedResultJson = {
      ...((liveRow?.resultJson as Record<string, unknown> | null) ?? {}),
      ...(patchResultJson ?? {}),
      executionTerminalizedAt: new Date().toISOString(),
    };
    const [updated] = await tx
      .update(heartbeatRuns)
      .set({
        status,
        ...patch,
        executionStatusDeliveryId: randomUUID(),
        updatedAt: new Date(),
        resultJson: mergedResultJson,
      })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, run.companyId),
          inArray(heartbeatRuns.status, input.fromStatuses ?? [run.status]),
        ),
      )
      .returning();
    if (!updated) return null;
    if (task?.executionRunId === run.id)
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
        })
        .where(eq(issues.id, task.id));
    if (task?.checkoutRunId === run.id)
      await tx
        .update(issues)
        .set({ checkoutRunId: null })
        .where(eq(issues.id, task.id));
    const review = task?.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
    const isCurrentReviewer = review?.status === "pending" &&
      review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === run.agentId;
    if (
      task &&
      !isSupersededConversationRun(task, updated) &&
      (task.assigneeAgentId === run.agentId || isCurrentReviewer) &&
      !["done", "cancelled"].includes(task.status)
    ) {
      // Periodic stranded-work checks may revisit this terminal run before its
      // reconciled continuation is dispatched. Preserve the recorded decision.
      const [reconciled] = await tx.select({ id: issueRecoveryActions.id })
        .from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.status, "resolved"),
          sql`${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${run.id}`,
        )).limit(1);
      if (reconciled) return updated;
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: run.companyId,
        sourceIssueId: task.id,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: task.assigneeAgentId,
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: `legacy-execution:${run.id}`,
        evidence: {
          runId: run.id,
          ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
          originalFailureCode: updated.errorCode,
          adapterRecovery: "unsupported_or_unknown",
          attempt: executionFailureRetryCount(run) + 1,
        },
        nextAction:
          "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing. This adapter has not established a safe resume checkpoint.",
        maxAttempts: 3,
        wakePolicy: null,
        supersedeOnIdentityChange: true,
      });
    }
    return updated;
  });
}
