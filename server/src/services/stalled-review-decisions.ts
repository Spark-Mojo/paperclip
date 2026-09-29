import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { IssueStageApprovalPullRequest, StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { executionIssueCondition } from "./issue-visibility.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "./issue-execution-policy.js";
import { issueStageApprovalService } from "./issue-stage-approvals.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";

export interface StalledReviewDecisionActor {
  userId: string;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  reviewedPullRequests?: IssueStageApprovalPullRequest[] | null;
  actor: StalledReviewDecisionActor;
}

export function stalledReviewDecisionService(db: Db) {
  const svc = issueService(db);
  return {
    decide: async (input: DecideStalledReviewInput) => {
      let verifiedApprovalPullRequests: IssueStageApprovalPullRequest[] | null = null;
      if (input.action === "approve") {
        const stageApprovalSvc = issueStageApprovalService(db);
        const issueForApproval = await svc.getById(input.issueId);
        if (issueForApproval && issueForApproval.companyId === input.companyId) {
          const hasBoundPrs = await stageApprovalSvc.hasBoundPullRequests({
            id: issueForApproval.id,
            companyId: issueForApproval.companyId,
            description: issueForApproval.description,
          });
          if (hasBoundPrs) {
            const verified = await stageApprovalSvc.verifyReviewedPullRequests({
              issue: {
                id: issueForApproval.id,
                companyId: issueForApproval.companyId,
                description: issueForApproval.description,
              },
              claim: input.reviewedPullRequests,
            });
            verifiedApprovalPullRequests = verified.pullRequests;
          }
        }
      }
      const postCommitActivityPublications: ActivityPublication[] = [];
      const postCommitIssueActions: IssuePostCommitAction[] = [];
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const lockedIssue = await tx
          .select()
          .from(issues)
          .where(and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            executionIssueCondition(),
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

        const reviewAttention = await svc
          .listReviewAttention(lockedIssue.companyId, [lockedIssue], tx)
          .then((rows) => rows.get(lockedIssue.id));
        if (reviewAttention?.state !== "stalled") {
          throw conflict("Issue is no longer a stalled review", {
            issueId: lockedIssue.id,
            reviewAttentionState: reviewAttention?.state ?? "none",
          });
        }

        const comment = input.note
          ? await svc.addComment(
              lockedIssue.id,
              input.note,
              { userId: input.actor.userId, runId: input.actor.runId ?? null },
              { authorType: "user" },
              tx,
            )
          : null;
        const status = input.action === "approve" ? "done" : "todo";
        const executionPolicy = normalizeIssueExecutionPolicy(
          lockedIssue.executionPolicy ?? null,
        );
        const transition =
          input.action === "approve" && executionPolicy
            ? applyIssueExecutionPolicyTransition({
                issue: lockedIssue,
                policy: executionPolicy,
                previousPolicy: executionPolicy,
                requestedStatus: "done",
                requestedAssigneePatch: {},
                actor: { agentId: null, userId: input.actor.userId },
                commentBody: input.note ?? null,
                approvalPullRequests: verifiedApprovalPullRequests,
              })
            : { patch: {} as Record<string, unknown> };
        const nextStatus =
          typeof transition.patch.status === "string"
            ? (transition.patch.status as string)
            : status;
        const updated = await svc.update(
          lockedIssue.id,
          {
            status: nextStatus,
            actorUserId: input.actor.userId,
            ...(Object.keys(transition.patch).length > 0
              ? { ...transition.patch, status: nextStatus }
              : {}),
          },
          tx,
          postCommitActivityPublications,
          postCommitIssueActions,
        );
        if (!updated) throw notFound("Issue not found");

        if (comment) {
          await logActivity(txDb, {
            companyId: updated.companyId,
            actorType: "user",
            actorId: input.actor.userId,
            runId: input.actor.runId ?? null,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: updated.id,
            issueId: updated.id,
            details: {
              commentId: comment.id,
              authorUserId: input.actor.userId,
              source: "stalled_review_decision",
            },
          });
        }
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: input.actor.userId,
          runId: input.actor.runId ?? null,
          action: "issue.stalled_review_decided",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            action: input.action,
            status: nextStatus,
            identifier: updated.identifier,
            commentId: comment?.id ?? null,
            authorUserId: comment ? input.actor.userId : null,
            _previous: { status: lockedIssue.status },
          },
        });

        return { issue: updated, comment };
      });
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitIssueActions);
      return result;
    },
  };
}
