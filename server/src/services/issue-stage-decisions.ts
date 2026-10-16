import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import type {
  IssueExecutionDecisionOutcome,
  IssueExecutionStage,
  IssueExecutionStagePrincipal,
  IssueExecutionState,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { executionIssueCondition } from "./issue-visibility.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";
import {
  buildChangesRequestedState,
  buildCompletedState,
  buildPendingStagePatch,
  nextPendingStageAfter,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  patchForPrincipal,
  principalsEqual,
  resolveMaxReviewRounds,
  selectStageParticipant,
  stageHasParticipant,
} from "./issue-execution-policy.js";

export type StageDecisionAction = "approve" | "request_changes";

export interface StageDecisionActor {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
}

export interface StageDecisionInput {
  issueId: string;
  companyId: string;
  action: StageDecisionAction;
  body: string;
  actor: StageDecisionActor;
}

const OUTCOME_BY_ACTION: Record<StageDecisionAction, IssueExecutionDecisionOutcome> = {
  approve: "approved",
  request_changes: "changes_requested",
};

function actorPrincipal(actor: StageDecisionActor): IssueExecutionStagePrincipal | null {
  if (actor.agentId) return { type: "agent", agentId: actor.agentId, userId: null };
  if (actor.userId) return { type: "user", userId: actor.userId, agentId: null };
  return null;
}

function principalsMatchDecision(
  row: typeof issueExecutionDecisions.$inferSelect,
  actor: StageDecisionActor,
): boolean {
  if (actor.agentId) return row.actorAgentId === actor.agentId && row.actorUserId == null;
  if (actor.userId) return row.actorUserId === actor.userId && row.actorAgentId == null;
  return false;
}

export function stageDecisionService(db: Db) {
  const svc = issueService(db);
  return {
    decide: async (input: StageDecisionInput) => {
      const outcome = OUTCOME_BY_ACTION[input.action];
      if (!outcome) throw unprocessable(`Unknown stage decision action: ${input.action}`);
      const body = input.body?.trim();
      if (!body) throw unprocessable("A stage decision requires a comment body");
      const actor = actorPrincipal(input.actor);
      if (!actor) throw unprocessable("A stage decision requires an agent or user actor");

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
          throw conflict("Stage decisions require an in_review card", {
            issueId: lockedIssue.id,
            currentStatus: lockedIssue.status,
          });
        }

        // Gate order matters: builder ban is absolute (self-approval is
        // impossible even if misconfigured as participant); then resolve the
        // active stage and check participant membership BEFORE the assignee
        // ban, so the designated reviewer decides regardless of assignee seat
        // (approve-advance reassigns the card to the next stage participant).
        if (
          (input.actor.agentId && lockedIssue.createdByAgentId === input.actor.agentId) ||
          (input.actor.userId && lockedIssue.createdByUserId === input.actor.userId)
        ) {
          throw forbidden("The card builder cannot record a stage decision");
        }

        const policy = normalizeIssueExecutionPolicy(lockedIssue.executionPolicy ?? null);
        const existingState = parseIssueExecutionState(lockedIssue.executionState);
        if (!policy || policy.stages.length === 0 || !existingState?.currentStageId) {
          throw unprocessable("Card has no pending execution stage", { issueId: lockedIssue.id });
        }
        const activeStage: IssueExecutionStage | null =
          policy.stages.find((stage) => stage.id === existingState.currentStageId) ?? null;
        if (!activeStage) {
          throw unprocessable("Current execution stage is not in the card policy", {
            issueId: lockedIssue.id,
            currentStageId: existingState.currentStageId,
          });
        }
        // Escalated-human hold: mirrors the sticky hold in
        // applyIssueExecutionPolicyTransition. An escalated review is held by
        // a human outside the stage's configured participants; only that
        // human decides until they do — their own decisions fall through to
        // the participant gate below, which they satisfy as currentParticipant.
        const escalatedHold =
          existingState.currentParticipant?.type === "user" &&
          !stageHasParticipant(activeStage, existingState.currentParticipant) &&
          (existingState.changesRequestedCount ?? 0) >= resolveMaxReviewRounds(policy);
        if (escalatedHold && !principalsEqual(existingState.currentParticipant, actor)) {
          throw unprocessable("Only the escalated reviewer can advance the current execution stage");
        }
        // Execution-stage membership is the gate: only the designated
        // participant (or an escalated human holding the stage) decides.
        const isParticipant = principalsEqual(existingState.currentParticipant, actor);
        // Assignee ban applies only to non-participants — the designated
        // reviewer decides regardless of assignee seat.
        if (!isParticipant) {
          if (
            (input.actor.agentId && lockedIssue.assigneeAgentId === input.actor.agentId) ||
            (input.actor.userId && lockedIssue.assigneeUserId === input.actor.userId)
          ) {
            throw forbidden("The current assignee cannot record a stage decision");
          }
          throw unprocessable("Only the active reviewer or approver can record the current execution stage decision");
        }
        if (!existingState.returnAssignee && input.action === "request_changes") {
          throw unprocessable("This execution stage has no return assignee");
        }

        // Idempotency: a latest decision row on this issue+stage with the same
        // outcome+body+actor, already reflected in state, is a duplicate — no
        // insert, no state churn.
        const latestDecision = await tx
          .select()
          .from(issueExecutionDecisions)
          .where(and(
            eq(issueExecutionDecisions.companyId, lockedIssue.companyId),
            eq(issueExecutionDecisions.issueId, lockedIssue.id),
            eq(issueExecutionDecisions.stageId, activeStage.id),
          ))
          .orderBy(desc(issueExecutionDecisions.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (latestDecision && latestDecision.outcome === outcome && latestDecision.body === body &&
          principalsMatchDecision(latestDecision, input.actor)) {
          const reflected = input.action === "approve"
            ? existingState.completedStageIds.includes(activeStage.id) ||
              (existingState.lastDecisionId === latestDecision.id &&
                existingState.lastDecisionOutcome === "approved")
            : existingState.status === "changes_requested" &&
              existingState.currentStageId === activeStage.id &&
              existingState.lastDecisionOutcome === "changes_requested";
          if (reflected) {
            return { issue: lockedIssue, decision: latestDecision, duplicate: true as const };
          }
        }

        // Pending-only guard (non-duplicates only): an identical replay
        // above already returned duplicate:true, so anything reaching here on
        // a non-pending state is a fresh write that must fail closed instead
        // of overwriting mid-park state.
        if (existingState.status !== "pending" && existingState.status !== "changes_requested") {
          throw conflict("Execution stage is not awaiting a decision", {
            issueId: lockedIssue.id,
            executionStatus: existingState.status,
          });
        }

        const returnAssignee = existingState.returnAssignee ??
          (lockedIssue.assigneeAgentId
            ? { type: "agent" as const, agentId: lockedIssue.assigneeAgentId, userId: null }
            : lockedIssue.assigneeUserId
              ? { type: "user" as const, agentId: null, userId: lockedIssue.assigneeUserId }
              : null);

        let nextState: IssueExecutionState;
        let assigneePatch: { assigneeAgentId: string | null; assigneeUserId: string | null } | null = null;
        if (input.action === "approve") {
          const approvedState = buildCompletedState(existingState, activeStage);
          const nextStage = nextPendingStageAfter(policy, activeStage, approvedState);
          if (!nextStage) {
            nextState = approvedState;
          } else {
            const participant = selectStageParticipant(nextStage, {
              exclude: existingState.returnAssignee ?? null,
            });
            if (!participant) {
              throw unprocessable(`No eligible ${nextStage.type} participant is configured for this issue`);
            }
            // Mirror the approve-advance branch of
            // applyIssueExecutionPolicyTransition, but the card stays parked:
            // buildPendingStagePatch sets patch.status="in_review", which we
            // drop — svc.update keeps the existing in_review status and the
            // real PATCH done fires the done-gate later, unchanged.
            const stagePatch: Record<string, unknown> = {};
            buildPendingStagePatch({
              patch: stagePatch,
              previous: approvedState,
              policy,
              stage: nextStage,
              participant,
              returnAssignee,
              reviewRequest: null,
            });
            nextState = stagePatch.executionState as IssueExecutionState;
            assigneePatch = {
              assigneeAgentId: (stagePatch.assigneeAgentId as string | null) ?? null,
              assigneeUserId: (stagePatch.assigneeUserId as string | null) ?? null,
            };
          }
        } else {
          // Human decisions reset the round counter; agent rounds increment.
          const nextRounds = actor.type === "user" ? 0 : (existingState.changesRequestedCount ?? 0) + 1;
          nextState = buildChangesRequestedState(existingState, activeStage, nextRounds);
          if (existingState.returnAssignee) {
            assigneePatch = {
              ...(patchForPrincipal(existingState.returnAssignee) as {
                assigneeAgentId: string | null;
                assigneeUserId: string | null;
              }),
            };
          }
        }

        const decisionId = randomUUID();
        const executionState = {
          ...nextState,
          lastDecisionId: decisionId,
        } as unknown as Record<string, unknown>;

        // ExecutionState-only update: no status key, so assertTransition and
        // the done-gate never fire — the card stays in_review for the
        // monitor/stalled paths. Monitor fields are untouched.
        const updated = await svc.update(
          lockedIssue.id,
          {
            executionState,
            ...(assigneePatch ?? {}),
            actorAgentId: input.actor.agentId ?? null,
            actorUserId: input.actor.userId ?? null,
          },
          tx,
          postCommitActivityPublications,
          postCommitIssueActions,
        );
        if (!updated) throw notFound("Issue not found");

        const [decision] = await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: lockedIssue.companyId,
          issueId: lockedIssue.id,
          stageId: activeStage.id,
          stageType: activeStage.type,
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.userId ?? null,
          outcome,
          body,
          createdByRunId: input.actor.runId ?? null,
        }).returning();

        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: actor.type,
          actorId: actor.type === "agent" ? (input.actor.agentId as string) : (input.actor.userId as string),
          agentId: input.actor.agentId ?? null,
          runId: input.actor.runId ?? null,
          action: "issue.stage_decision_recorded",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            action: input.action,
            outcome,
            stageId: activeStage.id,
            stageType: activeStage.type,
            decisionId,
            identifier: updated.identifier,
            _previous: { status: lockedIssue.status },
          },
        },
        postCommitActivityPublications);

        return { issue: updated, decision, duplicate: false as const };
      });
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitIssueActions);
      return result;
    },
  };
}
