import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  issues,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import { forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import {
  authorizationDeniedDetails,
  authorizationService,
} from "./authorization.js";

const MANAGE_RUNTIME_PERMISSION = "tools:manage_runtime";

type MonitorPhase = Record<string, unknown> & {
  phaseId: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
};

type PersistedMonitorPhaseFields = {
  monitorPhaseHistory: Record<string, unknown>[];
  monitorActivePhase: Record<string, unknown> | null;
};

type PhaseTransitionIssueRow = {
  id: string;
  companyId: string;
  executionState: unknown;
  monitorPhaseHistory: unknown;
  monitorActivePhase: unknown;
};

type PhaseTransitionActor =
  | { type: "board"; userId?: string | null }
  | { type: "agent"; agentId?: string | null };

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPhase(value: unknown): MonitorPhase | null {
  const phase = readRecord(value);
  if (
    !phase ||
    typeof phase.phaseId !== "string" ||
    typeof phase.status !== "string" ||
    !Number.isInteger(phase.attemptCount) ||
    !Number.isInteger(phase.maxAttempts)
  ) {
    return null;
  }
  return phase as MonitorPhase;
}

function actorPrincipal(actor: PhaseTransitionActor) {
  if (actor.type === "board" && actor.userId) {
    return { principalType: "user" as const, principalId: actor.userId };
  }
  if (actor.type === "agent" && actor.agentId) {
    return { principalType: "agent" as const, principalId: actor.agentId };
  }
  throw unauthorized();
}

function exhaustedPhaseFromIssue(issue: PhaseTransitionIssueRow) {
  const active = readPhase(issue.monitorActivePhase);
  if (active) return active;
  return readPhase(readRecord(issue.executionState)?.monitor);
}

function withoutCurrentActiveSnapshot(
  history: Record<string, unknown>[],
  currentPhaseId: string,
) {
  const last = readPhase(history.at(-1));
  return last?.phaseId === currentPhaseId ? history.slice(0, -1) : history;
}

/**
 * Atomically closes one exhausted monitor phase and starts its successor.
 * Authorization comes from the canonical decidePrincipalGrant decision while
 * the persisted grant and issue rows are locked, so revocation cannot race
 * the mutation and prose is never an authorization input.
 */
export async function transitionIssueMonitorPhase(input: {
  db: Db;
  issueId: string;
  companyId: string;
  actor: PhaseTransitionActor;
  predicate: string;
  notes: string;
  maxAttempts: number;
}) {
  const principal = actorPrincipal(input.actor);

  return input.db.transaction(async (tx) => {
    const access = authorizationService(tx);
    const issue = await tx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        executionState: issues.executionState,
        monitorPhaseHistory: issues.monitorPhaseHistory,
        monitorActivePhase: issues.monitorActivePhase,
      })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const decision = await access.decidePrincipalGrant({
      companyId: issue.companyId,
      principalType: principal.principalType,
      principalId: principal.principalId,
      action: MANAGE_RUNTIME_PERMISSION,
      permissionKey: MANAGE_RUNTIME_PERMISSION,
    });

    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }

    // Pin the persisted grant row under lock so revocation cannot race the
    // mutation. The role-default path carries no grant row, so provenance
    // records null ids there instead of fabricating one.
    const grant: { id: string | null; grantedByUserId: string | null } | null =
      decision.reason === "allow_explicit_grant" && decision.grant
        ? await tx
            .select({
              id: principalPermissionGrants.id,
              grantedByUserId: principalPermissionGrants.grantedByUserId,
            })
            .from(principalPermissionGrants)
            .where(
              and(
                eq(principalPermissionGrants.companyId, issue.companyId),
                eq(principalPermissionGrants.principalType, principal.principalType),
                eq(principalPermissionGrants.principalId, principal.principalId),
                eq(principalPermissionGrants.permissionKey, MANAGE_RUNTIME_PERMISSION),
              ),
            )
            .for("share")
            .then((rows) => rows[0] ?? null)
        : { id: null, grantedByUserId: null };
    if (!grant) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }

    const archivedPhase = exhaustedPhaseFromIssue(issue);
    if (
      !archivedPhase ||
      archivedPhase.status !== "cleared" ||
      archivedPhase.clearReason !== "max_attempts_exhausted" ||
      archivedPhase.attemptCount < archivedPhase.maxAttempts
    ) {
      throw unprocessable("The current monitor phase is not exhausted");
    }

    const activePhase = {
      phaseId: randomUUID(),
      status: "active",
      attemptCount: 0,
      maxAttempts: input.maxAttempts,
      clearReason: null,
      predicate: input.predicate,
      notes: input.notes,
      scheduledBy: input.actor.type === "board" ? "board" : "assignee",
      authorizationProvenance: {
        principalType: principal.principalType,
        principalId: principal.principalId,
        permissionKey: MANAGE_RUNTIME_PERMISSION,
        grantId: grant.id,
        grantedByUserId: grant.grantedByUserId,
        authorizationReason: decision.reason,
      },
    };

    const existingHistory = Array.isArray(issue.monitorPhaseHistory)
      ? issue.monitorPhaseHistory.filter(
          (phase): phase is Record<string, unknown> => readRecord(phase) !== null,
        )
      : [];
    const ledger = [
      ...withoutCurrentActiveSnapshot(existingHistory, archivedPhase.phaseId),
      archivedPhase,
      activePhase,
    ];
    const executionState = readRecord(issue.executionState);

    await tx
      .update(issues)
      .set({
        monitorPhaseHistory: ledger,
        monitorActivePhase: activePhase,
        monitorAttemptCount: 0,
        monitorNotes: input.notes,
        monitorScheduledBy: activePhase.scheduledBy,
        monitorNextCheckAt: null,
        monitorWakeRequestedAt: null,
        executionState: executionState ? { ...executionState, monitor: null } : null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));

    return { archivedPhase, activePhase, ledger };
  });
}
