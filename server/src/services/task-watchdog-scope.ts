import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, issueWatchdogs } from "@paperclipai/db";

const MAX_WATCHDOG_SCOPE_ANCESTRY_DEPTH = 100;
export const TASK_WATCHDOG_ORIGIN_KIND = "task_watchdog";

type AgentRunActor = {
  type: string;
  agentId?: string | null;
  companyId?: string | null;
  runId?: string | null;
};

export type TaskWatchdogWakeStopSnapshot = {
  version: 2;
  fingerprint: string;
  materialLeaves: Array<{
    issueId: string;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    blockerIssueIds: string[];
    pendingInteractionIds: string[];
    pendingApprovalIds: string[];
  }>;
  waitsByIssueId: Record<
    string,
    { pendingInteractionIds: string[]; pendingApprovalIds: string[] }
  >;
};

type IssueScopeTarget = {
  id: string;
  companyId: string;
  parentId?: string | null;
};

export type TaskWatchdogMutationScope =
  | { kind: "none" }
  | { kind: "invalid"; detail: string }
  | {
      kind: "watchdog";
      watchdogId: string;
      companyId: string;
      watchedIssueId: string;
      watchdogIssueId: string | null;
      stopFingerprint: string | null;
      // The material stop snapshot this run was woken with, reconstructed from
      // the run's own immutable wake context (SPA-7407). `null` when the
      // context cannot be read; the stale-repair carve-out then fails closed.
      wakeStopSnapshot: TaskWatchdogWakeStopSnapshot | null;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => entry != null);
}

/**
 * Reconstruct the material stop snapshot a run was woken with, from the run's
 * OWN wake context.
 *
 * SPA-7407. The watchdog ROW is deliberately not used as this baseline:
 * `issue_watchdogs.lastObservedStopSnapshot` is overwritten by every later
 * evaluation, including evaluations triggered by runs with a broader scope, so
 * binding to it would let the baseline move after this run was woken. The wake
 * context is immutable for the run, and it is the only record of what this run
 * actually saw. Returns `null` when the context cannot be read, so a caller
 * that needs a baseline fails closed instead of comparing against nothing.
 */
export function readTaskWatchdogWakeStopSnapshot(
  contextSnapshot: unknown,
  stopFingerprint: string | null,
) {
  if (!stopFingerprint) return null;
  const context = isPlainRecord(contextSnapshot) ? contextSnapshot : null;
  const rawLeaves = context?.stoppedLeaves;
  if (!Array.isArray(rawLeaves) || rawLeaves.length === 0) return null;

  const materialLeaves = [];
  for (const raw of rawLeaves) {
    if (!isPlainRecord(raw)) return null;
    const issueId = readString(raw.issueId);
    const status = readString(raw.status);
    if (!issueId || !status) return null;
    materialLeaves.push({
      issueId,
      status,
      assigneeAgentId: readString(raw.assigneeAgentId),
      assigneeUserId: readString(raw.assigneeUserId),
      blockerIssueIds: readStringArray(raw.blockerIssueIds),
      pendingInteractionIds: readStringArray(raw.pendingInteractionIds),
      pendingApprovalIds: readStringArray(raw.pendingApprovalIds),
    });
  }

  // Waits are recorded on the wake context as pending interactions plus a
  // per-issue pending-approval map. Rebuild both halves; an absent map means
  // no pending approvals, which is what the classifier recorded for an
  // approval-free stop.
  const taskWatchdog = isPlainRecord(context?.taskWatchdog) ? context.taskWatchdog : null;
  const waitsByIssueId: Record<
    string,
    { pendingInteractionIds: string[]; pendingApprovalIds: string[] }
  > = {};
  const rawPendingInteractions = taskWatchdog?.pendingInteractions;
  if (Array.isArray(rawPendingInteractions)) {
    for (const entry of rawPendingInteractions) {
      if (!isPlainRecord(entry)) continue;
      const issueId = readString(entry.issueId);
      const interactionId = readString(entry.id);
      if (!issueId || !interactionId) continue;
      const waits = (waitsByIssueId[issueId] ??= {
        pendingInteractionIds: [],
        pendingApprovalIds: [],
      });
      waits.pendingInteractionIds.push(interactionId);
    }
  }
  const rawPendingApprovals = taskWatchdog?.pendingApprovals;
  if (isPlainRecord(rawPendingApprovals)) {
    for (const [issueId, rawIds] of Object.entries(rawPendingApprovals)) {
      const approvalIds = readStringArray(rawIds);
      if (approvalIds.length === 0) continue;
      const waits = (waitsByIssueId[issueId] ??= {
        pendingInteractionIds: [],
        pendingApprovalIds: [],
      });
      waits.pendingApprovalIds.push(...approvalIds.sort());
    }
  }
  for (const waits of Object.values(waitsByIssueId)) {
    waits.pendingInteractionIds.sort();
  }

  return {
    version: 2 as const,
    fingerprint: stopFingerprint,
    materialLeaves,
    waitsByIssueId,
  };
}

function readTaskWatchdogContext(contextSnapshot: unknown) {
  const context = isPlainRecord(contextSnapshot) ? contextSnapshot : null;
  const taskWatchdog = isPlainRecord(context?.taskWatchdog) ? context.taskWatchdog : null;
  if (!taskWatchdog && context?.taskWatchdog !== true) return null;
  return {
    watchedIssueId: readString(taskWatchdog?.watchedIssueId) ?? readString(context?.watchedIssueId),
    stopFingerprint: readString(taskWatchdog?.stopFingerprint) ?? readString(context?.stopFingerprint),
  };
}

export async function resolveTaskWatchdogMutationScope(
  db: Db,
  actor: AgentRunActor,
): Promise<TaskWatchdogMutationScope> {
  if (actor.type !== "agent") return { kind: "none" };
  const agentId = readString(actor.agentId);
  const runId = readString(actor.runId);
  const actorCompanyId = readString(actor.companyId);
  if (!agentId || !runId) return { kind: "none" };

  const run = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);

  if (!run) return { kind: "none" };
  const taskWatchdog = readTaskWatchdogContext(run.contextSnapshot);
  if (!taskWatchdog) return { kind: "none" };
  if (run.agentId !== agentId || (actorCompanyId && run.companyId !== actorCompanyId)) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context does not belong to this agent.",
    };
  }

  if (!taskWatchdog.watchedIssueId) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context is missing a persisted watched issue id.",
    };
  }

  const watchdog = await db
    .select({
      id: issueWatchdogs.id,
      companyId: issueWatchdogs.companyId,
      issueId: issueWatchdogs.issueId,
      watchdogAgentId: issueWatchdogs.watchdogAgentId,
      watchdogIssueId: issueWatchdogs.watchdogIssueId,
      status: issueWatchdogs.status,
    })
    .from(issueWatchdogs)
    .where(and(
      eq(issueWatchdogs.companyId, run.companyId),
      eq(issueWatchdogs.issueId, taskWatchdog.watchedIssueId),
      eq(issueWatchdogs.watchdogAgentId, agentId),
      eq(issueWatchdogs.status, "active"),
    ))
    .then((rows) => rows[0] ?? null);

  if (!watchdog) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context is not backed by an active persisted watchdog.",
    };
  }

  return {
    kind: "watchdog",
    watchdogId: watchdog.id,
    companyId: watchdog.companyId,
    watchedIssueId: watchdog.issueId,
    watchdogIssueId: watchdog.watchdogIssueId ?? null,
    stopFingerprint: taskWatchdog.stopFingerprint,
    wakeStopSnapshot: readTaskWatchdogWakeStopSnapshot(
      run.contextSnapshot,
      taskWatchdog.stopFingerprint,
    ),
  };
}

export async function issueIsInTaskWatchdogSubtree(
  db: Db,
  companyId: string,
  issueId: string,
  watchedIssueId: string,
) {
  let currentId: string | null = issueId;
  const seen = new Set<string>();

  for (let depth = 0; currentId && depth < MAX_WATCHDOG_SCOPE_ANCESTRY_DEPTH; depth += 1) {
    if (seen.has(currentId)) return false;
    seen.add(currentId);

    const parent: { id: string; companyId: string; parentId: string | null; originKind: string | null } | null = await db
      .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId, originKind: issues.originKind })
      .from(issues)
      .where(and(eq(issues.id, currentId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!parent) return false;
    if (parent.originKind === TASK_WATCHDOG_ORIGIN_KIND) return false;
    if (currentId === watchedIssueId) return true;
    currentId = parent.parentId ?? null;
  }

  return false;
}

export async function taskWatchdogScopeAllowsIssueMutation(
  db: Db,
  scope: TaskWatchdogMutationScope,
  issue: IssueScopeTarget,
  opts: { allowWatchdogIssue?: boolean } = {},
) {
  if (scope.kind !== "watchdog") return scope;
  if (issue.companyId !== scope.companyId) {
    return {
      kind: "invalid" as const,
      detail: "Task-watchdog mutation target is outside the watchdog company.",
    };
  }
  if (opts.allowWatchdogIssue !== false && scope.watchdogIssueId && issue.id === scope.watchdogIssueId) {
    return scope;
  }
  if (await issueIsInTaskWatchdogSubtree(db, scope.companyId, issue.id, scope.watchedIssueId)) {
    return scope;
  }
  return {
    kind: "invalid" as const,
    detail: "Task-watchdog runs can only mutate the watched issue subtree.",
  };
}
