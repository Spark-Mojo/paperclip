import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import { isUuidLike, type StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { assertIssueReviewVerdictActorAllowed } from "./issue-review-policy.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";

export interface StalledReviewDecisionActor {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  /** `send_back` is accepted by the schema but retires here: see below. */
  note?: string;
  actor: StalledReviewDecisionActor;
}

/**
 * Named upstream retirement condition (SPA-6268 fix 5).
 *
 * Upstream refs #12712 and #11299 could not be resolved against any reachable
 * repo (the JamesSparkMojo/paperclip fork holds ~38 issues; neither number
 * exists there), so this is recorded as a NAME, not a fetch result. The
 * parallel `send_back` transition path retires when EITHER upstream issue
 * lands a stalled-review `send_back` semantic that differs from
 * `request_changes`, OR when the schema drops `send_back` from
 * `StalledReviewDecisionAction`. Until then `send_back` is an alias for
 * `request_changes` everywhere in this service: same comment requirement
 * (enforced by the route schema), same canonical transition
 * (`requestedStatus: "todo"`), same `changes_requested` decision outcome.
 * Do NOT build a second transition path for it.
 */
export const STALLED_REVIEW_SEND_BACK_RETIREMENT_REFS = ["#12712", "#11299"] as const;

function resolveRunIdForDecisionColumn(
  runId: string | null | undefined,
): string | null {
  // Fix 4: malformed ids must never reach a UUID column. Trim, reject
  // non-UUID-likes, and let the caller null out stale/foreign ids against
  // heartbeatRuns scoped to the issue's company.
  const normalized = typeof runId === "string" ? runId.trim() : "";
  if (!normalized || !isUuidLike(normalized)) return null;
  return normalized;
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

      // Fix 2: authorize AGENTS as the EXACT current participant under the
      // same row lock. `currentParticipant` (not stage membership, not the
      // assignee column) is the execution lane's statement of which agent may
      // advance the stage right now — re-reading the drifted column is not
      // enough, and a pre-lock check races with stage/policy mutation.
      // Authorized board users retain stalled-review recovery authority and
      // are governed by the locked review-policy guard below.
      const policy = normalizeIssueExecutionPolicy(lockedIssue.executionPolicy ?? null);
      const state = parseIssueExecutionState(lockedIssue.executionState ?? null);
      const lockedStage = policy && state?.currentStageId
        ? policy.stages.find((stage) => stage.id === state.currentStageId) ?? null
        : null;
      const currentParticipant = state?.status === "pending" ? state.currentParticipant : null;
      const isExecutionVerdict =
        !!policy &&
        !!state &&
        state.status === "pending" &&
        !!lockedStage &&
        (lockedStage.type === "review" || lockedStage.type === "approval") &&
        !!currentParticipant;

      if (isExecutionVerdict && input.actor.type === "agent") {
        if (
          !input.actor.agentId ||
          currentParticipant.type !== "agent" ||
          currentParticipant.agentId !== input.actor.agentId
        ) {
          throw forbidden("Only the current participant of the active review stage may record this decision");
        }
      } else if (!isExecutionVerdict && input.actor.type === "agent") {
        // No active execution verdict to record (board-only recovery shape):
        // agents hold no authority here.
        throw forbidden("Only a configured participant of the active review stage may record this decision");
      }

      // Fix 3: the canonical review-policy guard runs on this verdict path,
      // inside the lock, for both agent and board callers.
      const actorId = input.actor.type === "agent"
        ? input.actor.agentId ?? "unknown-agent"
        : input.actor.userId ?? "board";
      await assertIssueReviewVerdictActorAllowed(txDb, {
        issue: lockedIssue,
        actor: { type: input.actor.type, id: actorId },
      });

      // Fix 4 (continued): stale, foreign-company, foreign-agent, wrong-issue,
      // and unbound ids resolve to null before they reach UUID audit columns. A
      // heartbeat run is provenance for its exact agent and target issue, not a
      // reusable company-scoped token.
      const candidateRunId = resolveRunIdForDecisionColumn(input.actor.runId);
      const decisionRunId = candidateRunId && input.actor.type === "agent" && input.actor.agentId
        ? await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.id, candidateRunId),
              eq(heartbeatRuns.companyId, lockedIssue.companyId),
              eq(heartbeatRuns.agentId, input.actor.agentId),
              sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${lockedIssue.id}`,
            ))
            .then((rows) => rows[0]?.id ?? null)
        : null;

      const isAgent = input.actor.type === "agent";
      // `send_back` retires into `request_changes` (see retirement note).
      // Both map onto the canonical transition's non-`done` branch, which the
      // policy machine records as `changes_requested`.
      const requestedStatus = input.action === "approve" ? "done" : "todo";
      const commentBody = input.note?.trim() ? input.note : undefined;

      const comment = commentBody
        ? await svc.addComment(
            lockedIssue.id,
            commentBody,
            isAgent
              ? { agentId: input.actor.agentId!, runId: decisionRunId }
              : { userId: input.actor.userId!, runId: decisionRunId },
            isAgent ? { authorType: "agent" } : { authorType: "user" },
            tx,
          )
        : null;

      // Fix 1: the verdict travels through the canonical row-locked
      // execution-policy stage transition — never a raw status write. Approve
      // on the last stage completes the chain; approve with a later stage
      // pending advances review→approval with the next participant assigned;
      // request_changes returns the issue to the return assignee
      // (in_progress, or todo when no return assignee exists to wake).
      // Issues without an execution verdict (board-only recovery) get an
      // empty stage patch: status move plus comment, no decision row.
      const transition = isExecutionVerdict
        ? applyIssueExecutionPolicyTransition({
            issue: lockedIssue,
            policy,
            requestedStatus,
            requestedAssigneePatch: {},
            actor: {
              agentId: isAgent ? input.actor.agentId ?? null : null,
              userId: isAgent ? null : (input.actor.userId ?? null),
            },
            // The locked route/service authorization and review-policy checks
            // above admit only a board user here. Preserve that real actor for
            // the canonical decision while allowing it to recover an agent
            // participant's stalled stage without a state-clearing override.
            allowCurrentStageDecisionOverride: input.actor.type === "user",
            commentBody,
          })
        : { patch: {} as Record<string, unknown>, decision: undefined };
      const transitionDecision = transition.decision;
      const decisionId = transitionDecision ? randomUUID() : null;
      if (decisionId && transition.patch.executionState && typeof transition.patch.executionState === "object") {
        transition.patch.executionState = {
          ...transition.patch.executionState,
          lastDecisionId: decisionId,
        };
      }

      const updated = await svc.update(lockedIssue.id, {
        status: requestedStatus,
        ...transition.patch,
        ...(isAgent
          ? { actorAgentId: input.actor.agentId! }
          : { actorUserId: input.actor.userId! }),
      }, tx);
      if (!updated) throw notFound("Issue not found");

      if (decisionId && transitionDecision) {
        await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: updated.companyId,
          issueId: updated.id,
          stageId: transitionDecision.stageId,
          stageType: transitionDecision.stageType,
          actorAgentId: isAgent ? (input.actor.agentId ?? null) : null,
          actorUserId: isAgent ? null : (input.actor.userId ?? null),
          outcome: transitionDecision.outcome,
          body: transitionDecision.body,
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
          status: requestedStatus,
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
