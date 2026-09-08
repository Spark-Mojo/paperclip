import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";

export interface StalledReviewDecisionActor {
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
}

export function stalledReviewDecisionService(db: Db) {
  return {
    decide: async (input: DecideStalledReviewInput) => db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const lockedIssue = await tx
        .select()
        .from(issues)
        .where(and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
          visibleIssueCondition(),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);

      if (!lockedIssue) throw notFound("Issue not found");
      if (lockedIssue.status !== "in_review") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          currentStatus: lockedIssue.status,
        });
      }

      const svc = issueService(txDb);
      const reviewAttention = await svc
        .listReviewAttention(lockedIssue.companyId, [lockedIssue])
        .then((rows) => rows.get(lockedIssue.id));
      if (reviewAttention?.state !== "stalled") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          reviewAttentionState: reviewAttention?.state ?? "none",
        });
      }

      // An agent-owned review stage records its verdict in
      // issue_execution_decisions exactly like the live PATCH path does, so a
      // stalled recovery decision completes the stage instead of stranding it.
      // Issues without an active review/approval execution stage (the
      // board-only recovery case) keep the previous behavior: status move plus
      // comment, no decision row.
      const isAgent = !!input.actor.agentId;
      const actorId = isAgent ? input.actor.agentId! : input.actor.userId ?? "board";
      const policy = normalizeIssueExecutionPolicy(lockedIssue.executionPolicy ?? null);
      const state = parseIssueExecutionState(lockedIssue.executionState ?? null);
      const activeStage = policy && state && state.status === "pending" && state.currentStageId
        ? policy.stages.find((stage) =>
            stage.id === state.currentStageId &&
            (stage.type === "review" || stage.type === "approval"),
          ) ?? null
        : null;
      const decisionId = activeStage ? randomUUID() : null;
      const outcome = input.action === "approve" ? "approved" : "changes_requested";
      // Invalid/stale run ids must not 500 the inserts — null out unknowns,
      // the same way comment creation does.
      const decisionRunId = input.actor.runId
        ? await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.id, input.actor.runId),
              eq(heartbeatRuns.companyId, lockedIssue.companyId),
            ))
            .then((rows) => rows[0]?.id ?? null)
        : null;

      const comment = input.note
        ? await svc.addComment(
            lockedIssue.id,
            input.note,
            isAgent
              ? { agentId: input.actor.agentId!, runId: input.actor.runId ?? null }
              : { userId: input.actor.userId!, runId: input.actor.runId ?? null },
            isAgent ? { authorType: "agent" } : { authorType: "user" },
            tx,
          )
        : null;
      const status = input.action === "approve" ? "done" : "todo";
      const updated = await svc.update(lockedIssue.id, {
        status,
        ...(isAgent
          ? { actorAgentId: input.actor.agentId! }
          : { actorUserId: input.actor.userId! }),
        ...(decisionId && state
          ? {
              executionState: {
                ...state,
                lastDecisionId: decisionId,
                lastDecisionOutcome: outcome,
              },
            }
          : {}),
      }, tx);
      if (!updated) throw notFound("Issue not found");

      if (decisionId && activeStage) {
        await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: updated.companyId,
          issueId: updated.id,
          stageId: activeStage.id,
          stageType: activeStage.type,
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: isAgent ? null : (input.actor.userId ?? null),
          outcome,
          body: input.note ?? "",
          createdByRunId: decisionRunId,
        });
      }

      if (comment) {
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: isAgent ? "agent" : "user",
          actorId,
          runId: decisionRunId,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            commentId: comment.id,
            ...(isAgent ? { authorAgentId: input.actor.agentId! } : { authorUserId: input.actor.userId! }),
            source: "stalled_review_decision",
          },
        });
      }
      await logActivity(txDb, {
        companyId: updated.companyId,
        actorType: isAgent ? "agent" : "user",
        actorId,
        runId: decisionRunId,
        action: "issue.stalled_review_decided",
        entityType: "issue",
        entityId: updated.id,
        issueId: updated.id,
        details: {
          action: input.action,
          status,
          identifier: updated.identifier,
          commentId: comment?.id ?? null,
          ...(isAgent
            ? { authorAgentId: comment ? input.actor.agentId! : null }
            : { authorUserId: comment ? input.actor.userId! : null }),
          decisionId,
          _previous: { status: lockedIssue.status },
        },
      });

      return { issue: updated, comment };
    }),
  };
}
